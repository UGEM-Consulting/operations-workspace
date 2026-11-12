import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toString as qrSvg } from 'qrcode';
import { DataSource, EntityManager } from 'typeorm';
import { EnvironmentError } from '../../config/environment';
import { Role, User, UserStatus, publicUser } from '../users/user.entity';
import { attemptKey, clearAttempts, countAttempt, countSliding, lockKey, readAttempts } from './attempts';
import { EmailService } from '../email/email.service';
import { consumeEmailCode, EMAIL_SENDS_PER_WINDOW, type EmailCodePurpose, generateEmailCode, hasEmailCode, maskEmail, resendAfter, storeEmailCode } from './mfa-email';
import { RECOVERY_CODE_COUNT, SecretBox, formatManualKey, matchTotp, newRecoveryCode, newTotpSecret, normalizeRecoveryCode, totpUri } from './mfa-crypto';
import { MfaMethod, MfaPolicy, SecurityEventType, StaffMfa, StaffRecoveryCode, StaffSecurityEvent, StaffSecuritySettings } from './mfa.entity';
import { clearSavedSignature } from '../documents/saved-signature';
import { hashPassword, verifyPassword } from './password';
import { accessFor } from './policy';
import { revokeUserSessions } from './revoke';
import { AuthRequest, MfaStage, regenerateSession, saveSession } from './session';
import { deviceToken, trustDevice, trustedDevices, TRUSTED_DAYS, trustFailureCode, useTrustedDevice } from './trusted-devices';

const ISSUER = 'UGEM Workspace';
// Wrong codes per user (across all sessions and API instances) within 15 minutes before a lockout.
const MAX_CODE_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 900;
// After a recovery-code sign-in, a new authenticator may be started without another code for this long; a started one
// must be confirmed within REPLACEMENT_MS.
const RECOVERED_GRACE_MS = 15 * 60_000, REPLACEMENT_MS = 15 * 60_000;
/** Names one started setup (its sealed secret, random each time) so confirming can tell it was the one shown. */
const replacementId = (sealed: string) => createHash('sha256').update(sealed).digest('hex').slice(0, 32);
// A repeat lockout lasts an hour: code guessing slows to about 5 per hour, while someone who knows a password can hold
// an account for at most an hour per burst (longer locks would make denying the last administrator cheap). Never
// permanent. Escalation resets after a day without a lockout.
export const LOCKOUT_STEPS = [900, 3600];
const LOCKOUT_MEMORY_SECONDS = 86_400;
const lockoutLabel = (seconds: number) => seconds >= 3600 ? `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}` : `${seconds / 60} minutes`;
// The code step allows for an emailed code arriving late; it stays far shorter than a session.
const PENDING_SECONDS: Record<MfaStage, number> = { password: 600, verify: 600, enrol: 900 };
const PENDING_PAGES: Record<MfaStage, string> = { password: '/login/password', verify: '/login/mfa', enrol: '/login/mfa-setup' };
/** Every per-user code counter (hashed keys); an administrator reset clears them all. */
const codeKeys = (userId: string) => ({ failures: attemptKey('mfa', userId), lock: attemptKey('mfa-lock', userId), lockouts: attemptKey('mfa-lockouts', userId),
  sends: attemptKey('mfa-email-send', userId) });
export const mfaRequired = (role: Role, policy: MfaPolicy) => role === Role.SYSTEM_ADMIN || policy === MfaPolicy.ALL_STAFF;
/** Administrators keep an authenticator app: their account can change everyone else's. */
export const emailCodesAllowed = (role: Role) => role !== Role.SYSTEM_ADMIN;
type CodeKind = 'totp' | 'email' | 'recovery';
/**
 * Removes an email-code enrolment when the user becomes an administrator; they set up an authenticator at the next
 * sign-in. Also run at sign-in (no actor) for an administrator an older API or a manual role change left on email codes.
 */
export async function removeEmailEnrolment(manager: EntityManager, userId: string, actorId: string | null, reason = 'administrator-role') {
  const removed = await manager.delete(StaffMfa, { userId, method: MfaMethod.EMAIL });
  if (!removed.affected) return false;
  await manager.delete(StaffRecoveryCode, { userId });
  await manager.query('DELETE FROM staff_mfa_email_codes WHERE "userId" = $1', [userId]);
  await manager.insert(StaffSecurityEvent, { userId, actorId, type: SecurityEventType.MFA_RESET_BY_ADMIN, metadata: { reason, method: MfaMethod.EMAIL } });
  return true;
}

@Injectable()
export class MfaService {
  private readonly box: SecretBox | null;
  constructor(private readonly db: DataSource, private readonly config: ConfigService, private readonly email: EmailService) {
    const key = config.get<string>('MFA_ENCRYPTION_KEY');
    // Administrators must use two-step verification, so production cannot run without the key.
    if (!key && config.get('NODE_ENV') === 'production') throw new EnvironmentError('The production API requires MFA_ENCRYPTION_KEY');
    this.box = key ? new SecretBox(key) : null;
  }

  async state(user: Pick<User, 'id' | 'role'>, manager: DataSource | EntityManager = this.db) {
    const [row]: { method: MfaMethod | null; policy: MfaPolicy | null }[] = await manager.query(`SELECT
      (SELECT method FROM staff_mfa WHERE "userId" = $1 AND "confirmedAt" IS NOT NULL) AS method,
      (SELECT "mfaRequiredFor" FROM staff_security_settings WHERE id = 1) AS policy`, [user.id]);
    const policy = row.policy ?? MfaPolicy.ADMINS;
    return { enrolled: row.method !== null, method: row.method, required: mfaRequired(user.role, policy), policy };
  }

  /**
   * After a correct password: a full session, or a pending step that grants no staff access. A password chosen by an
   * administrator must be replaced first; the change then calls this again to continue with the second step.
   */
  async startSession(user: User, req: AuthRequest) {
    if (user.mustChangePassword) {
      await this.pend(req, user, 'password');
      return { stage: 'password' as const, landingPage: PENDING_PAGES.password };
    }
    let { enrolled, method, required } = await this.state(user);
    // An administrator never signs in with emailed codes: the enrolment goes and they set up an authenticator now.
    if (method === MfaMethod.EMAIL && !emailCodesAllowed(user.role)) {
      user = await this.dropAdministratorEmailCodes(user);
      ({ enrolled, method, required } = await this.state(user));
    }
    if (!enrolled && !required) return this.establish(req, user, 'not-required');
    // A device they trusted after a code in the last 30 days skips the code; never for administrators (TrustDeviceAdminScreen).
    if (enrolled && emailCodesAllowed(user.role) && await this.trustedDevice(req, user)) {
      const result = await this.establish(req, user, 'verified');
      // The history keeps every sign-in that skipped the code, also after the device rows are gone; written once the session
      // exists, so a sign-in that failed is never recorded as one.
      await this.db.manager.insert(StaffSecurityEvent, { userId: user.id, actorId: user.id, type: SecurityEventType.TRUSTED_DEVICE_USED, metadata: {} })
        .catch((error: unknown) => Logger.error(`Recording a trusted device sign-in failed: ${trustFailureCode(error)}`, 'Mfa'));
      return result;
    }
    const stage: MfaStage = enrolled ? 'verify' : 'enrol';
    await this.pend(req, user, stage);
    return { mfa: stage, landingPage: PENDING_PAGES[stage] };
  }

  /** The guard admitted this pending stage; services re-read it rather than trusting the route decorator alone. */
  pendingUser(req: AuthRequest, stage: MfaStage): User {
    const pending = req.session.mfaPending;
    if (req.session.userId || !pending || pending.stage !== stage || pending.expiresAt <= Date.now() || pending.userId !== req.currentUser?.id
      || pending.authVersion !== req.currentUser.authVersion) throw new UnauthorizedException('Your sign-in expired. Sign in again.');
    return req.currentUser;
  }

  /** A full session of the current user and authentication version, never a pending one. */
  fullSessionUser(req: AuthRequest): User {
    if (req.session.mfaPending || !req.session.userId || req.session.userId !== req.currentUser?.id
      || req.session.authVersion !== req.currentUser.authVersion) throw new UnauthorizedException();
    return req.currentUser;
  }

  /** After the user changed their own password (which revoked every session): this session continues under a new ID. */
  async continueSession(req: AuthRequest, user: User) {
    const { mfa, expiresAt } = req.session;
    await regenerateSession(req);
    Object.assign(req.session, { userId: user.id, authVersion: user.authVersion, mfa, expiresAt });
    await saveSession(req);
    return { user: publicUser(user), ...accessFor(user) };
  }

  async verifyLogin(req: AuthRequest, code: string, trust = false) {
    const user = this.pendingUser(req, 'verify');
    const kind = await this.checkCode(user, code, true, 'login');
    const result = await this.establish(req, user, 'verified');
    // Whoever holds a recovery code may not have the phone, so it never trusts a device (TrustDeviceRecoveryScreen).
    // The code is used and the session saved by now, so a failure here never undoes the sign-in: they're asked again next time.
    if (trust && kind !== 'recovery' && emailCodesAllowed(user.role)) await trustDevice(this.db, user, req).catch((error: unknown) => Logger.error(`Trusting a device failed: ${trustFailureCode(error)}`, 'Mfa'));
    if (kind !== 'recovery') return result;
    // A recovery code usually means the authenticator is gone: for a short while this session may start a new one
    // without spending another code (NewAuthenticatorAfterRecoveryScreen).
    req.session.mfaRecoveredAt = Date.now();
    await saveSession(req);
    return { ...result, recoveryCodesRemaining: await this.remainingRecoveryCodes(user.id) };
  }

  /**
   * Starts a new authenticator for someone who already uses one (Account security; administrators included). It needs a
   * code from the current authenticator or a recovery code (used up), except just after signing in with a recovery code.
   * The new secret waits beside the current one, which keeps working until the new one's first code is confirmed.
   */
  async beginReplacement(req: AuthRequest, code: string | undefined) {
    const user = req.currentUser;
    const { enrolled, method } = await this.state(user);
    if (!enrolled) throw new BadRequestException('Two-step verification isn’t on for your account.');
    if (method !== MfaMethod.TOTP) throw new BadRequestException('Only an authenticator app can be replaced. Your account uses email codes.');
    const recovered = !!req.session.mfaRecoveredAt && Date.now() - req.session.mfaRecoveredAt < RECOVERED_GRACE_MS;
    if (!recovered && !code) throw new BadRequestException('Enter a code from your authenticator or a recovery code.');
    const box = this.requireBox();
    // Refused before the code is checked, so a recovery code is never used up for nothing.
    if (await countAttempt(this.db, attemptKey('mfa-enrol', user.id), LOCKOUT_SECONDS) > 10) throw new HttpException('Too many setup attempts. Try again later.', 429);
    if (!recovered) await this.checkCode(user, code!, true, 'manage');
    const secret = newTotpSecret(), sealed = box.seal(secret, user.id);
    const rows: unknown[] = await this.db.query(`UPDATE staff_mfa SET "pendingSecretCiphertext" = $2, "pendingCreatedAt" = now()
      WHERE "userId" = $1 AND method = 'TOTP' AND "confirmedAt" IS NOT NULL RETURNING "userId"`, [user.id, sealed]);
    if (!(rows[0] as unknown[] | undefined)?.length) throw new ConflictException('Two-step verification changed. Reload the page.');
    // The shortcut after a recovery code works once.
    if (recovered) { delete req.session.mfaRecoveredAt; await saveSession(req); }
    const uri = totpUri(secret, user.email, ISSUER);
    const svg = await qrSvg(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    return { qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, uri, manualKey: formatManualKey(secret), issuer: ISSUER, account: user.email,
      replacementId: replacementId(sealed) };
  }

  /** The new authenticator's first code makes it the one in use. Other sessions end and this one continues. */
  async confirmReplacement(req: AuthRequest, code: string, shown: string) {
    const user = req.currentUser;
    const row = await this.db.getRepository(StaffMfa).createQueryBuilder('mfa').addSelect(['mfa.pendingSecretCiphertext', 'mfa.pendingCreatedAt'])
      .where('mfa.userId = :id AND mfa.method = :method AND mfa.confirmedAt IS NOT NULL', { id: user.id, method: MfaMethod.TOTP }).getOne();
    if (!row?.pendingSecretCiphertext || !row.pendingCreatedAt || Date.now() - row.pendingCreatedAt.getTime() > REPLACEMENT_MS) throw new ConflictException('Start setting up the new authenticator again.');
    // Only the secret that was shown: a setup started again elsewhere replaced it, and its codes would never match.
    // Refused before counting, so codes from the QR code they scanned don't add up to a lockout.
    if (replacementId(row.pendingSecretCiphertext) !== shown) throw new ConflictException('You started a new authenticator again somewhere else, so this QR code no longer works. Start again here.');
    await this.countCodeAttempt(user);
    const step = matchTotp(this.requireBox().open(row.pendingSecretCiphertext, user.id), code.trim());
    if (step === null) throw new UnauthorizedException('Invalid verification code');
    const updated = await this.db.transaction(async manager => {
      const current = await this.lockUser(manager, user.id);
      // Only the secret that was shown: a second setup started meanwhile makes this one stale.
      const replaced = await manager.query(`UPDATE staff_mfa SET "secretCiphertext" = "pendingSecretCiphertext", "pendingSecretCiphertext" = NULL, "pendingCreatedAt" = NULL,
        "lastUsedStep" = $3, "updatedAt" = now() WHERE "userId" = $1 AND "pendingSecretCiphertext" = $2 RETURNING "userId"`, [user.id, row.pendingSecretCiphertext, String(step)]) as [unknown[], number];
      if (!replaced[0].length) throw new ConflictException('Start setting up the new authenticator again.');
      await revokeUserSessions(manager, current);
      await this.audit(manager, user.id, null, SecurityEventType.MFA_AUTHENTICATOR_REPLACED, {});
      return current;
    });
    await clearAttempts(this.db, codeKeys(user.id).failures);
    return this.establish(req, updated, 'verified');
  }

  async status(user: User) {
    const { enrolled, method, required, policy } = await this.state(user);
    const row = await this.db.getRepository(StaffMfa).findOneBy({ userId: user.id });
    return { enabled: enrolled, method, required, policy, enabledAt: enrolled ? row?.confirmedAt ?? null : null,
      recoveryCodesRemaining: enrolled ? await this.remainingRecoveryCodes(user.id) : 0,
      emailCodesAvailable: emailCodesAllowed(user.role) && this.email.staffCodesEnabled, email: maskEmail(user.email) };
  }

  /** The sign-in step: which kind of code to ask for. For email codes, sends one unless a recent one is outstanding. */
  async loginChallenge(req: AuthRequest, resend: boolean) {
    const user = this.pendingUser(req, 'verify');
    const { method } = await this.state(user);
    // trustDevice: whether the step offers to skip the code on this device (an older API sends none, and the box stays hidden).
    const trust = { trustDevice: emailCodesAllowed(user.role), trustDays: TRUSTED_DAYS };
    if (method !== MfaMethod.EMAIL) return { method: MfaMethod.TOTP, ...trust };
    // Signing in again replaces an administrator's email codes with an authenticator (see startSession).
    if (!emailCodesAllowed(user.role)) throw new UnauthorizedException('Administrators must use an authenticator app. Sign in again to set one up.');
    if (resend || !await hasEmailCode(this.db, user.id, 'login')) await this.sendEmailCode(user, 'login');
    return { method, sentTo: maskEmail(user.email), resendAfter: await resendAfter(this.db, user.id, 'login'), ...trust };
  }

  /** Account security's trusted devices: available only to people with two-step verification on who aren't administrators. */
  async devices(req: AuthRequest) {
    const user = req.currentUser, { enrolled } = await this.state(user);
    const available = enrolled && emailCodesAllowed(user.role);
    return { available, administrator: !emailCodesAllowed(user.role), days: TRUSTED_DAYS, items: available ? await trustedDevices(this.db, user, req) : [] };
  }

  /** What this person may choose when setting up two-step verification. */
  methods(req: AuthRequest) {
    const user = this.enrolmentUser(req);
    return { methods: emailCodesAllowed(user.role) && this.email.staffCodesEnabled ? [MfaMethod.TOTP, MfaMethod.EMAIL] : [MfaMethod.TOTP], email: maskEmail(user.email) };
  }

  /** A code for confirming Account security changes, for email-code users. */
  async sendManageCode(user: User) {
    if ((await this.state(user)).method !== MfaMethod.EMAIL) throw new BadRequestException('Your account uses an authenticator app');
    await this.sendEmailCode(user, 'manage');
    return { sentTo: maskEmail(user.email), resendAfter: await resendAfter(this.db, user.id, 'manage') };
  }

  /**
   * Starts enrolment. An authenticator app gets a new unconfirmed secret, returned once; email codes get a code sent
   * to the account email (calling again resends after a short wait).
   */
  async beginEnrolment(req: AuthRequest, method: MfaMethod = MfaMethod.TOTP) {
    const user = this.enrolmentUser(req);
    if (method === MfaMethod.EMAIL) {
      if (!emailCodesAllowed(user.role)) throw new BadRequestException('Administrators must use an authenticator app');
      if (!this.email.staffCodesEnabled) throw new ServiceUnavailableException('Email codes are not available on this server');
      const rows: unknown[] = await this.db.query(`INSERT INTO staff_mfa ("userId", method, "secretCiphertext") VALUES ($1, 'EMAIL', NULL)
        ON CONFLICT ("userId") DO UPDATE SET method = 'EMAIL', "secretCiphertext" = NULL, "lastUsedStep" = NULL, "updatedAt" = now()
        WHERE staff_mfa."confirmedAt" IS NULL RETURNING "userId"`, [user.id]);
      if (!rows.length) throw new ConflictException('Two-step verification is already turned on');
      await this.sendEmailCode(user, 'enrol');
      return { method, sentTo: maskEmail(user.email), resendAfter: await resendAfter(this.db, user.id, 'enrol') };
    }
    const box = this.requireBox();
    if (await countAttempt(this.db, attemptKey('mfa-enrol', user.id), LOCKOUT_SECONDS) > 10) throw new HttpException('Too many setup attempts. Try again later.', 429);
    const secret = newTotpSecret();
    const rows: unknown[] = await this.db.query(`INSERT INTO staff_mfa ("userId", method, "secretCiphertext") VALUES ($1, 'TOTP', $2)
      ON CONFLICT ("userId") DO UPDATE SET method = 'TOTP', "secretCiphertext" = EXCLUDED."secretCiphertext", "lastUsedStep" = NULL, "updatedAt" = now()
      WHERE staff_mfa."confirmedAt" IS NULL RETURNING "userId"`, [user.id, box.seal(secret, user.id)]);
    if (!rows.length) throw new ConflictException('Two-step verification is already turned on');
    const uri = totpUri(secret, user.email, ISSUER);
    const svg = await qrSvg(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    return { method, qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, uri, manualKey: formatManualKey(secret), issuer: ISSUER, account: user.email };
  }

  /** The first correct code confirms enrolment, issues recovery codes and revokes every other session. */
  async confirmEnrolment(req: AuthRequest, code: string) {
    const user = this.enrolmentUser(req);
    await this.countCodeAttempt(user);
    const row = await this.db.getRepository(StaffMfa).createQueryBuilder('mfa').addSelect(['mfa.secretCiphertext', 'mfa.lastUsedStep'])
      .where('mfa.userId = :id AND mfa.confirmedAt IS NULL', { id: user.id }).getOne();
    if (!row) throw new ConflictException('Start two-step verification setup again');
    let step: number | null = null;
    if (row.method === MfaMethod.EMAIL) {
      if (!emailCodesAllowed(user.role)) throw new BadRequestException('Administrators must use an authenticator app');
      if (!await consumeEmailCode(this.db, user.id, 'enrol', code.trim())) throw new UnauthorizedException('Invalid verification code');
    } else {
      step = matchTotp(this.requireBox().open(row.secretCiphertext!, user.id), code.trim());
      if (step === null) throw new UnauthorizedException('Invalid verification code');
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const hashes = await this.hashRecoveryCodes(codes);
    const updated = await this.db.transaction(async manager => {
      const current = await this.lockUser(manager, user.id);
      const confirmed = await manager.createQueryBuilder().update(StaffMfa).set({ confirmedAt: () => 'now()', lastUsedStep: step === null ? null : String(step) })
        .where('"userId" = :id AND "confirmedAt" IS NULL AND method = :method', { id: user.id, method: row.method }).execute();
      if (!confirmed.affected) throw new ConflictException('Two-step verification is already turned on');
      await this.replaceRecoveryCodes(manager, user.id, hashes);
      await revokeUserSessions(manager, current);
      await this.audit(manager, user.id, null, SecurityEventType.MFA_ENROLLED, { recoveryCodes: RECOVERY_CODE_COUNT, method: row.method });
      return current;
    });
    await clearAttempts(this.db, codeKeys(user.id).failures);
    return { ...await this.establish(req, updated, 'verified'), recoveryCodes: codes };
  }

  async regenerateRecoveryCodes(user: User, code: string) {
    await this.checkCode(user, code, false, 'manage');
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const hashes = await this.hashRecoveryCodes(codes);
    await this.db.transaction(async manager => {
      await this.lockUser(manager, user.id);
      if (!(await this.state(user, manager)).enrolled) throw new ConflictException('Two-step verification is not turned on');
      await this.replaceRecoveryCodes(manager, user.id, hashes);
      await this.audit(manager, user.id, null, SecurityEventType.MFA_RECOVERY_CODES_REGENERATED, { recoveryCodes: RECOVERY_CODE_COUNT });
    });
    return { recoveryCodes: codes };
  }

  /** Optional roles only. Requires a current code; other sessions end and this one continues without MFA. */
  async disable(user: User, code: string, req: AuthRequest) {
    if ((await this.state(user)).required) throw new BadRequestException('Your role requires two-step verification');
    await this.checkCode(user, code, true, 'manage');
    const updated = await this.db.transaction(async manager => {
      const current = await this.lockUser(manager, user.id);
      if ((await this.state(current, manager)).required) throw new BadRequestException('Your role requires two-step verification');
      await this.removeEnrolment(manager, current);
      await this.audit(manager, user.id, null, SecurityEventType.MFA_DISABLED, {});
      return current;
    });
    return this.establish(req, updated, 'not-required');
  }

  /** For a user who lost their authenticator and recovery codes. Administrators never see secrets. */
  async adminReset(actor: User, id: string) {
    if (actor.id === id) throw new BadRequestException('Use Account security to change your own two-step verification');
    await this.db.transaction(async manager => {
      // Same lock as user administration so role/status edits and resets serialize.
      await manager.query('SELECT pg_advisory_xact_lock(42002026)');
      const currentActor = await manager.getRepository(User).findOneBy({ id: actor.id });
      if (!currentActor || currentActor.role !== Role.SYSTEM_ADMIN || currentActor.status !== UserStatus.ACTIVE) throw new BadRequestException('Administrator access changed');
      const user = await this.lockUser(manager, id);
      if (!await manager.getRepository(StaffMfa).existsBy({ userId: id })) throw new NotFoundException('Two-step verification is not set up for this user');
      await this.removeEnrolment(manager, user);
      await this.audit(manager, id, actor.id, SecurityEventType.MFA_RESET_BY_ADMIN, {});
      await clearSavedSignature(manager, id, actor.id, 'mfa-reset');
    });
    // The user enrols again from scratch, so earlier lockouts no longer apply.
    await clearAttempts(this.db, Object.values(codeKeys(id)));
    return { mfaEnabled: false };
  }

  async policy() {
    const settings = await this.db.getRepository(StaffSecuritySettings).findOneBy({ id: 1 });
    return { mfaRequiredFor: settings?.mfaRequiredFor ?? MfaPolicy.ADMINS };
  }

  /** Raising the policy needs no revocation: the guard rejects unverified sessions of newly required users. */
  async setPolicy(actor: User, mfaRequiredFor: MfaPolicy) {
    await this.db.transaction(async manager => {
      const [settings]: { mfaRequiredFor: MfaPolicy }[] = await manager.query(`SELECT "mfaRequiredFor" FROM staff_security_settings WHERE id = 1 FOR UPDATE`);
      if (settings?.mfaRequiredFor === mfaRequiredFor) return;
      await manager.query(`INSERT INTO staff_security_settings (id, "mfaRequiredFor", "updatedById", "updatedAt") VALUES (1, $1, $2, now())
        ON CONFLICT (id) DO UPDATE SET "mfaRequiredFor" = EXCLUDED."mfaRequiredFor", "updatedById" = EXCLUDED."updatedById", "updatedAt" = now()`, [mfaRequiredFor, actor.id]);
      await this.audit(manager, actor.id, actor.id, SecurityEventType.MFA_POLICY_CHANGED, { from: settings?.mfaRequiredFor ?? MfaPolicy.ADMINS, to: mfaRequiredFor });
    });
    return { mfaRequiredFor };
  }

  /** Forced enrolment from a pending 'enrol' sign-in, or voluntary enrolment from a full session. */
  private enrolmentUser(req: AuthRequest): User {
    return req.session.mfaPending ? this.pendingUser(req, 'enrol') : this.fullSessionUser(req);
  }

  /**
   * Whether this browser's trusted device skips the code. While wrong codes have locked the account it asks for a code, which
   * the lock then refuses. The cookie is checked first, so most sign-ins skip the queries, and a failed query only asks for the code.
   */
  private async trustedDevice(req: AuthRequest, user: User) {
    if (!deviceToken(req)) return false;
    try { return !await readAttempts(this.db, codeKeys(user.id).lock) && await useTrustedDevice(this.db, user, req); }
    catch (error) { Logger.error(`Checking a trusted device failed: ${trustFailureCode(error)}`, 'Mfa'); return false; }
  }

  private async pend(req: AuthRequest, user: User, stage: MfaStage) {
    await regenerateSession(req);
    req.session.mfaPending = { userId: user.id, authVersion: user.authVersion, stage, expiresAt: Date.now() + PENDING_SECONDS[stage] * 1000 };
    await saveSession(req);
  }

  /** Counts a code attempt; the sixth within 15 minutes starts an escalating lock that also rejects correct codes. */
  private async countCodeAttempt(user: User) {
    const keys = codeKeys(user.id);
    if (await readAttempts(this.db, keys.lock)) throw new HttpException('Too many incorrect codes. Try again later.', 429);
    const attempts = await countAttempt(this.db, keys.failures, LOCKOUT_SECONDS);
    if (attempts <= MAX_CODE_ATTEMPTS) return;
    // The atomic counter lets exactly one request reach the threshold, so each lockout is recorded once.
    if (attempts !== MAX_CODE_ATTEMPTS + 1) throw new HttpException('Too many incorrect codes. Try again later.', 429);
    const lockouts = await countSliding(this.db, keys.lockouts, LOCKOUT_MEMORY_SECONDS);
    const seconds = LOCKOUT_STEPS[Math.min(lockouts, LOCKOUT_STEPS.length) - 1];
    await lockKey(this.db, keys.lock, seconds);
    await clearAttempts(this.db, keys.failures);
    await this.audit(this.db.manager, user.id, null, SecurityEventType.MFA_LOCKED_OUT, { lockoutSeconds: seconds, lockoutsInSeries: lockouts });
    throw new HttpException(`Too many incorrect codes. Try again in ${lockoutLabel(seconds)}.`, 429);
  }

  /** Sends a new code for this purpose unless one was sent moments ago. Sends per user are capped across purposes. */
  private async sendEmailCode(user: User, purpose: EmailCodePurpose) {
    if (!this.email.staffCodesEnabled) throw new ServiceUnavailableException('Email codes are not available on this server');
    const keys = codeKeys(user.id);
    if (await readAttempts(this.db, keys.sends) >= EMAIL_SENDS_PER_WINDOW) throw new HttpException('Too many codes sent. Try again in 15 minutes.', 429);
    const code = generateEmailCode();
    if (!await storeEmailCode(this.db, user.id, purpose, code)) return;
    await countAttempt(this.db, keys.sends, LOCKOUT_SECONDS);
    const sent = await this.email.sendStaffCode(user.email, code, purpose);
    if (sent !== true) {
      // The code was never delivered; let the person ask again straight away.
      await this.db.query('DELETE FROM staff_mfa_email_codes WHERE "userId" = $1 AND purpose = $2', [user.id, purpose]);
      throw new ServiceUnavailableException('The code could not be emailed. Try again shortly, or use a recovery code.');
    }
  }

  /** Rate-limited check of the enrolled method (TOTP with replay protection, or a single-use emailed code), then recovery codes. */
  private async checkCode(user: User, code: string, allowRecovery: boolean, purpose: Exclude<EmailCodePurpose, 'enrol'>): Promise<CodeKind> {
    await this.countCodeAttempt(user);
    const row = await this.db.getRepository(StaffMfa).createQueryBuilder('mfa').addSelect('mfa.secretCiphertext')
      .where('mfa.userId = :id AND mfa.confirmedAt IS NOT NULL', { id: user.id }).getOne();
    if (!row) throw new UnauthorizedException('Invalid verification code');
    const token = code.trim();
    // Never an emailed code for an administrator (recovery codes still work), even if an email enrolment survived.
    if (row.method === MfaMethod.EMAIL && emailCodesAllowed(user.role) && await consumeEmailCode(this.db, user.id, purpose, token)) return this.accepted(user, 'email');
    const step = row.method === MfaMethod.TOTP ? matchTotp(this.requireBox().open(row.secretCiphertext!, user.id), token) : null;
    if (step !== null) {
      // Each time step is accepted once, even across concurrent requests.
      const accepted = await this.db.createQueryBuilder().update(StaffMfa).set({ lastUsedStep: String(step) })
        .where('"userId" = :id AND "confirmedAt" IS NOT NULL AND ("lastUsedStep" IS NULL OR "lastUsedStep" < :step)', { id: user.id, step }).execute();
      if (accepted.affected) return this.accepted(user, 'totp');
    } else if (allowRecovery) {
      const recovery = normalizeRecoveryCode(token);
      const candidates = recovery ? await this.db.getRepository(StaffRecoveryCode).createQueryBuilder('code').addSelect('code.codeHash')
        .where('code.userId = :id AND code.usedAt IS NULL', { id: user.id }).getMany() : [];
      for (const candidate of candidates) {
        if (!await verifyPassword(candidate.codeHash, recovery!)) continue;
        const used = await this.db.createQueryBuilder().update(StaffRecoveryCode).set({ usedAt: () => 'now()' })
          .where('id = :id AND "usedAt" IS NULL', { id: candidate.id }).execute();
        if (!used.affected) break;
        await this.audit(this.db.manager, user.id, null, SecurityEventType.MFA_RECOVERY_CODE_USED, { remaining: await this.remainingRecoveryCodes(user.id) });
        return this.accepted(user, 'recovery');
      }
    }
    throw new UnauthorizedException('Invalid verification code');
  }

  private async accepted(user: User, kind: CodeKind): Promise<CodeKind> {
    await clearAttempts(this.db, codeKeys(user.id).failures);
    return kind;
  }

  /** Regenerates the session ID and grants staff access for the user's current authentication version. */
  private async establish(req: AuthRequest, user: User, mfa: 'verified' | 'not-required') {
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.authVersion = user.authVersion;
    req.session.mfa = mfa;
    req.session.expiresAt = Date.now() + this.config.getOrThrow<number>('SESSION_TTL_SECONDS') * 1000;
    await this.db.getRepository(User).update(user.id, { lastLoginAt: new Date() });
    await saveSession(req);
    return { user: publicUser(user), ...accessFor(user) };
  }

  private async lockUser(manager: EntityManager, id: string): Promise<User> {
    const user = await manager.getRepository(User).createQueryBuilder('user').addSelect('user.authVersion').setLock('pessimistic_write').where('user.id = :id', { id }).getOne();
    if (!user) throw new NotFoundException();
    return user;
  }

  /**
   * Removes an administrator's email-code enrolment (with its recovery and outstanding codes) after a correct password
   * and ends their sessions, like any enrolment change. Returns the user as stored now, so the pending sign-in carries
   * the current authVersion even when a concurrent sign-in already removed it or the role changed meanwhile.
   */
  private async dropAdministratorEmailCodes(user: User): Promise<User> {
    return this.db.transaction(async manager => {
      const current = await this.lockUser(manager, user.id);
      if (!emailCodesAllowed(current.role) && await removeEmailEnrolment(manager, current.id, null, 'administrator-sign-in')) await revokeUserSessions(manager, current);
      return current;
    });
  }

  private async removeEnrolment(manager: EntityManager, user: User) {
    await manager.delete(StaffRecoveryCode, { userId: user.id });
    await manager.query('DELETE FROM staff_mfa_email_codes WHERE "userId" = $1', [user.id]);
    await manager.delete(StaffMfa, { userId: user.id });
    await revokeUserSessions(manager, user);
  }

  private async replaceRecoveryCodes(manager: EntityManager, userId: string, hashes: string[]) {
    await manager.delete(StaffRecoveryCode, { userId });
    await manager.insert(StaffRecoveryCode, hashes.map(codeHash => ({ userId, codeHash })));
  }

  // Sequential: each Argon2id hash uses 64 MiB.
  private async hashRecoveryCodes(codes: string[]) {
    const hashes: string[] = [];
    for (const code of codes) hashes.push(await hashPassword(normalizeRecoveryCode(code)!));
    return hashes;
  }

  private remainingRecoveryCodes(userId: string) {
    return this.db.getRepository(StaffRecoveryCode).createQueryBuilder('code').where('code.userId = :userId AND code.usedAt IS NULL', { userId }).getCount();
  }

  private async audit(manager: EntityManager, userId: string, actorId: string | null, type: SecurityEventType, metadata: StaffSecurityEvent['metadata']) {
    await manager.insert(StaffSecurityEvent, { userId, actorId, type, metadata });
  }

  private requireBox(): SecretBox {
    if (!this.box) throw new ServiceUnavailableException('Two-step verification is not configured on this server');
    return this.box;
  }
}
