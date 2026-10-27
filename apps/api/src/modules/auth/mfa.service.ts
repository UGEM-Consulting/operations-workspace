import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toString as qrSvg } from 'qrcode';
import { DataSource, EntityManager } from 'typeorm';
import { EnvironmentError } from '../../config/environment';
import { Role, User, UserStatus, publicUser } from '../users/user.entity';
import { attemptKey, clearAttempts, countAttempt } from './attempts';
import { RECOVERY_CODE_COUNT, SecretBox, formatManualKey, matchTotp, newRecoveryCode, newTotpSecret, normalizeRecoveryCode, totpUri } from './mfa-crypto';
import { MfaPolicy, SecurityEventType, StaffMfa, StaffRecoveryCode, StaffSecurityEvent, StaffSecuritySettings } from './mfa.entity';
import { hashPassword, verifyPassword } from './password';
import { accessFor } from './policy';
import { AuthRequest, MfaStage, regenerateSession, saveSession } from './session';

const ISSUER = 'UGEM Workspace';
// Consecutive wrong codes per user before a 15-minute lockout, across all sessions and API instances.
const MAX_CODE_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 900;
const PENDING_SECONDS: Record<MfaStage, number> = { verify: 300, enrol: 900 };
export const mfaRequired = (role: Role, policy: MfaPolicy) => role === Role.SYSTEM_ADMIN || policy === MfaPolicy.ALL_STAFF;
type CodeKind = 'totp' | 'recovery';

@Injectable()
export class MfaService {
  private readonly box: SecretBox | null;
  constructor(private readonly db: DataSource, private readonly config: ConfigService) {
    const key = config.get<string>('MFA_ENCRYPTION_KEY');
    // Administrators must use two-step verification, so production cannot run without the key.
    if (!key && config.get('NODE_ENV') === 'production') throw new EnvironmentError('The production API requires MFA_ENCRYPTION_KEY');
    this.box = key ? new SecretBox(key) : null;
  }

  async state(user: Pick<User, 'id' | 'role'>, manager: DataSource | EntityManager = this.db) {
    const [row]: { enrolled: boolean; policy: MfaPolicy | null }[] = await manager.query(`SELECT
      EXISTS(SELECT 1 FROM staff_mfa WHERE "userId" = $1 AND "confirmedAt" IS NOT NULL) AS enrolled,
      (SELECT "mfaRequiredFor" FROM staff_security_settings WHERE id = 1) AS policy`, [user.id]);
    const policy = row.policy ?? MfaPolicy.ADMINS;
    return { enrolled: row.enrolled, required: mfaRequired(user.role, policy), policy };
  }

  /** After a correct password: either a full session, or a pending second step that grants no staff access. */
  async startSession(user: User, req: AuthRequest) {
    const { enrolled, required } = await this.state(user);
    if (!enrolled && !required) return this.establish(req, user, 'not-required');
    const stage: MfaStage = enrolled ? 'verify' : 'enrol';
    await regenerateSession(req);
    req.session.mfaPending = { userId: user.id, authVersion: user.authVersion, stage, expiresAt: Date.now() + PENDING_SECONDS[stage] * 1000 };
    await saveSession(req);
    return { mfa: stage, landingPage: stage === 'verify' ? '/login/mfa' : '/login/mfa-setup' };
  }

  async verifyLogin(req: AuthRequest, code: string) {
    const user = this.pendingUser(req, 'verify');
    const kind = await this.checkCode(user, code, true);
    const result = await this.establish(req, user, 'verified');
    return kind === 'recovery' ? { ...result, recoveryCodesRemaining: await this.remainingRecoveryCodes(user.id) } : result;
  }

  async status(user: User) {
    const { enrolled, required, policy } = await this.state(user);
    const row = await this.db.getRepository(StaffMfa).findOneBy({ userId: user.id });
    return { enabled: enrolled, required, policy, enabledAt: enrolled ? row?.confirmedAt ?? null : null,
      recoveryCodesRemaining: enrolled ? await this.remainingRecoveryCodes(user.id) : 0 };
  }

  /** Stores a new unconfirmed secret and returns it once for the authenticator app. */
  async beginEnrolment(user: User) {
    const box = this.requireBox();
    if (await countAttempt(this.db, attemptKey('mfa-enrol', user.id), LOCKOUT_SECONDS) > 10) throw new HttpException('Too many setup attempts. Try again later.', 429);
    const secret = newTotpSecret();
    const rows: unknown[] = await this.db.query(`INSERT INTO staff_mfa ("userId", "secretCiphertext") VALUES ($1, $2)
      ON CONFLICT ("userId") DO UPDATE SET "secretCiphertext" = EXCLUDED."secretCiphertext", "lastUsedStep" = NULL, "updatedAt" = now()
      WHERE staff_mfa."confirmedAt" IS NULL RETURNING "userId"`, [user.id, box.seal(secret, user.id)]);
    if (!rows.length) throw new ConflictException('Two-step verification is already turned on');
    const uri = totpUri(secret, user.email, ISSUER);
    const svg = await qrSvg(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    return { qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, uri, manualKey: formatManualKey(secret), issuer: ISSUER, account: user.email };
  }

  /** The first correct code confirms enrolment, issues recovery codes and revokes every other session. */
  async confirmEnrolment(user: User, code: string, req: AuthRequest) {
    const box = this.requireBox();
    await this.countCodeAttempt(user);
    const row = await this.db.getRepository(StaffMfa).createQueryBuilder('mfa').addSelect(['mfa.secretCiphertext', 'mfa.lastUsedStep'])
      .where('mfa.userId = :id AND mfa.confirmedAt IS NULL', { id: user.id }).getOne();
    if (!row) throw new ConflictException('Start two-step verification setup again');
    const step = matchTotp(box.open(row.secretCiphertext, user.id), code.trim());
    if (step === null) throw new UnauthorizedException('Invalid verification code');
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const hashes = await this.hashRecoveryCodes(codes);
    const updated = await this.db.transaction(async manager => {
      const current = await this.lockUser(manager, user.id);
      const confirmed = await manager.createQueryBuilder().update(StaffMfa).set({ confirmedAt: () => 'now()', lastUsedStep: String(step) })
        .where('"userId" = :id AND "confirmedAt" IS NULL', { id: user.id }).execute();
      if (!confirmed.affected) throw new ConflictException('Two-step verification is already turned on');
      await this.replaceRecoveryCodes(manager, user.id, hashes);
      await this.revoke(manager, current);
      await this.audit(manager, user.id, null, SecurityEventType.MFA_ENROLLED, { recoveryCodes: RECOVERY_CODE_COUNT });
      return current;
    });
    await clearAttempts(this.db, attemptKey('mfa', user.id));
    return { ...await this.establish(req, updated, 'verified'), recoveryCodes: codes };
  }

  async regenerateRecoveryCodes(user: User, code: string) {
    await this.checkCode(user, code, false);
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
    await this.checkCode(user, code, true);
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
    });
    await clearAttempts(this.db, attemptKey('mfa', id));
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

  private pendingUser(req: AuthRequest, stage: MfaStage): User {
    const pending = req.session.mfaPending;
    if (!pending || pending.stage !== stage || pending.userId !== req.currentUser?.id) throw new UnauthorizedException('Your sign-in expired. Sign in again.');
    return req.currentUser;
  }

  private async countCodeAttempt(user: User) {
    const attempts = await countAttempt(this.db, attemptKey('mfa', user.id), LOCKOUT_SECONDS);
    if (attempts > MAX_CODE_ATTEMPTS) {
      if (attempts === MAX_CODE_ATTEMPTS + 1) await this.audit(this.db.manager, user.id, null, SecurityEventType.MFA_LOCKED_OUT, { lockoutSeconds: LOCKOUT_SECONDS });
      throw new HttpException('Too many incorrect codes. Try again in 15 minutes.', 429);
    }
  }

  /** Rate-limited TOTP check with replay protection, falling back to single-use recovery codes. */
  private async checkCode(user: User, code: string, allowRecovery: boolean): Promise<CodeKind> {
    const box = this.requireBox();
    await this.countCodeAttempt(user);
    const row = await this.db.getRepository(StaffMfa).createQueryBuilder('mfa').addSelect('mfa.secretCiphertext')
      .where('mfa.userId = :id AND mfa.confirmedAt IS NOT NULL', { id: user.id }).getOne();
    if (!row) throw new UnauthorizedException('Invalid verification code');
    const token = code.trim();
    const step = matchTotp(box.open(row.secretCiphertext, user.id), token);
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
    await clearAttempts(this.db, attemptKey('mfa', user.id));
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
    await manager.delete(StaffMfa, { userId: user.id });
    await this.revoke(manager, user);
  }

  /** Invalidates every existing session of the user, including the caller's; callers re-establish their own. */
  private async revoke(manager: EntityManager, user: User) {
    user.authVersion += 1;
    await manager.getRepository(User).update(user.id, { authVersion: user.authVersion });
    await manager.query(`DELETE FROM staff_sessions WHERE sess->>'userId' = $1 OR sess->'mfaPending'->>'userId' = $1`, [user.id]);
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
