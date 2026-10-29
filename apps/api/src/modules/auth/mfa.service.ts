import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
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

const ISSUER = 'UGEM Workspace';
// Wrong codes per user (across all sessions and API instances) within 15 minutes before a lockout.
const MAX_CODE_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 900;
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
/** Removes an email-code enrolment when the user becomes an administrator; they set up an authenticator at the next sign-in. */
export async function removeEmailEnrolment(manager: EntityManager, userId: string, actorId: string) {
  const removed = await manager.delete(StaffMfa, { userId, method: MfaMethod.EMAIL });
  if (!removed.affected) return;
  await manager.delete(StaffRecoveryCode, { userId });
  await manager.query('DELETE FROM staff_mfa_email_codes WHERE "userId" = $1', [userId]);
  await manager.insert(StaffSecurityEvent, { userId, actorId, type: SecurityEventType.MFA_RESET_BY_ADMIN, metadata: { reason: 'administrator-role', method: MfaMethod.EMAIL } });
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
    const { enrolled, required } = await this.state(user);
    if (!enrolled && !required) return this.establish(req, user, 'not-required');
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

  async verifyLogin(req: AuthRequest, code: string) {
    const user = this.pendingUser(req, 'verify');
    const kind = await this.checkCode(user, code, true, 'login');
    const result = await this.establish(req, user, 'verified');
    return kind === 'recovery' ? { ...result, recoveryCodesRemaining: await this.remainingRecoveryCodes(user.id) } : result;
  }

  async status(user: User) {
    const { enrolled, method, required, policy } = await this.state(user);
    const row = await this.db.getRepository(StaffMfa).findOneBy({ userId: user.id });
    return { enabled: enrolled, method, required, policy, enabledAt: enrolled ? row?.confirmedAt ?? null : null,
      recoveryCodesRemaining: enrolled ? await this.remainingRecoveryCodes(user.id) : 0,
      emailCodesAvailable: emailCodesAllowed(user.role) && this.email.enabled, email: maskEmail(user.email) };
  }

  /** The sign-in step: which kind of code to ask for. For email codes, sends one unless a recent one is outstanding. */
  async loginChallenge(req: AuthRequest, resend: boolean) {
    const user = this.pendingUser(req, 'verify');
    const { method } = await this.state(user);
    if (method !== MfaMethod.EMAIL) return { method: MfaMethod.TOTP };
    if (resend || !await hasEmailCode(this.db, user.id, 'login')) await this.sendEmailCode(user, 'login');
    return { method, sentTo: maskEmail(user.email), resendAfter: await resendAfter(this.db, user.id, 'login') };
  }

  /** What this person may choose when setting up two-step verification. */
  methods(req: AuthRequest) {
    const user = this.enrolmentUser(req);
    return { methods: emailCodesAllowed(user.role) && this.email.enabled ? [MfaMethod.TOTP, MfaMethod.EMAIL] : [MfaMethod.TOTP], email: maskEmail(user.email) };
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
      if (!this.email.enabled) throw new ServiceUnavailableException('Email codes are not available on this server');
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
    if (!this.email.enabled) throw new ServiceUnavailableException('Email codes are not available on this server');
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
    if (row.method === MfaMethod.EMAIL && await consumeEmailCode(this.db, user.id, purpose, token)) return this.accepted(user, 'email');
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
