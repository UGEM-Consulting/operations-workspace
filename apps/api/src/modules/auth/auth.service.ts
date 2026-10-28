import { randomBytes } from 'node:crypto';
import { BadRequestException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User, UserStatus } from '../users/user.entity';
import { clientContext } from '../documents/client-context';
import { hashPassword, verifyPassword } from './password';
import { AuthRequest } from './session';
import { ChangePasswordDto, LoginDto } from './auth.dto';
import { attemptKey, clearAttempts, countAttempt, countAttempts, readAttempts } from './attempts';
import { MfaService } from './mfa.service';
import { SecurityEventType, StaffSecurityEvent } from './mfa.entity';
import { revokeUserSessions } from './revoke';

const WINDOW_SECONDS = 900;
// Atomic PostgreSQL counters shared by all API instances; keys are SHA-256 digests, so no email or IP address is stored.
// The client IP comes from the BFF (x-client-ip), which every request must authenticate with the server-only secret.
export const LOGIN_LIMITS = {
  // Service-wide circuit breaker against floods that would exhaust Argon2id CPU/memory; far above normal staff use.
  service: { limit: 1000, seconds: 60 },
  // One network address, all attempts (an office NAT shares it). Never cleared by a success.
  ip: { limit: 100, seconds: WINDOW_SECONDS },
  // One account from one address: password guessing. Cleared by a correct password.
  emailAndIp: { limit: 10, seconds: WINDOW_SECONDS },
  // One account from anywhere: counts failures only and is cleared by a correct password, so a user's own successful
  // sign-in resets it and a targeted lockout costs an attacker a sustained stream of attempts.
  emailFailures: { limit: 20, seconds: WINDOW_SECONDS },
};
const PASSWORD_CHANGE_LIMIT = 5;
const tooMany = () => new HttpException('Too many login attempts. Try again later.', 429);

@Injectable()
export class AuthService {
  private readonly dummyHash = hashPassword(randomBytes(32).toString('hex'));
  constructor(private readonly db: DataSource, private readonly mfa: MfaService) {}
  async login(input: LoginDto, req: AuthRequest) {
    const ip = clientContext(req).ipAddress ?? 'unknown';
    const keys = { ip: attemptKey('login-ip', ip), emailAndIp: attemptKey('login-email-ip', `${input.email}\n${ip}`), email: attemptKey('login-email', input.email) };
    await this.db.query(`DELETE FROM login_attempts WHERE key IN (SELECT key FROM login_attempts WHERE "expiresAt" <= now() LIMIT 100)`);
    // Service, address and account-from-address counters in one round trip; any one over its limit refuses.
    const limited = [{ key: attemptKey('login-service', 'all'), ...LOGIN_LIMITS.service }, { key: keys.ip, ...LOGIN_LIMITS.ip }, { key: keys.emailAndIp, ...LOGIN_LIMITS.emailAndIp }];
    const counts = await countAttempts(this.db, limited);
    if (counts.some((count, index) => count > limited[index].limit)) throw tooMany();
    // Checked before the password, so a locked account rejects even a correct password; known and unknown emails alike.
    if (await readAttempts(this.db, keys.email) >= LOGIN_LIMITS.emailFailures.limit) throw tooMany();
    const user = await this.db.getRepository(User).createQueryBuilder('user').addSelect(['user.passwordHash', 'user.authVersion']).where('lower(user.email) = :email', { email: input.email }).getOne();
    const matches = await verifyPassword(user?.passwordHash ?? await this.dummyHash, input.password);
    if (!user || !user.passwordHash || !matches || user.status !== UserStatus.ACTIVE) {
      await countAttempt(this.db, keys.email, LOGIN_LIMITS.emailFailures.seconds);
      throw new UnauthorizedException('Invalid email or password');
    }
    await clearAttempts(this.db, [keys.email, keys.emailAndIp]);
    // A forced password change, then MFA when enrolled or required; nobody gets staff access before those steps.
    return this.mfa.startSession(user, req);
  }

  /**
   * Self-service change from a full session, or the forced change after signing in with an administrator-set password.
   * Every session of the user ends; this one continues (a full session under a new ID, or the next sign-in step).
   */
  async changePassword(input: ChangePasswordDto, req: AuthRequest) {
    const forced = Boolean(req.session.mfaPending);
    const actor = forced ? this.mfa.pendingUser(req, 'password') : this.mfa.fullSessionUser(req);
    const limitKey = attemptKey('password-change', actor.id);
    if (await countAttempt(this.db, limitKey, WINDOW_SECONDS) > PASSWORD_CHANGE_LIMIT) throw new HttpException('Too many password change attempts. Try again later.', 429);
    const stored = await this.db.getRepository(User).createQueryBuilder('user').addSelect('user.passwordHash').where('user.id = :id', { id: actor.id }).getOne();
    if (!stored?.passwordHash || !await verifyPassword(stored.passwordHash, input.currentPassword)) throw new BadRequestException('Your current password is incorrect');
    // The current password was just verified, so comparing with it is the reuse check.
    if (input.newPassword === input.currentPassword) throw new BadRequestException('Choose a new password that differs from your current one');
    const passwordHash = await hashPassword(input.newPassword);
    const updated = await this.db.transaction(async manager => {
      const user = await manager.getRepository(User).createQueryBuilder('user').addSelect(['user.authVersion', 'user.passwordHash'])
        .setLock('pessimistic_write').where('user.id = :id', { id: actor.id }).getOne();
      // An administrator edit or another change since this request was authorized wins.
      if (!user || user.status !== UserStatus.ACTIVE || user.authVersion !== actor.authVersion || user.passwordHash !== stored.passwordHash) {
        throw new UnauthorizedException('Your sign-in expired. Sign in again.');
      }
      await manager.getRepository(User).update(user.id, { passwordHash, mustChangePassword: false });
      Object.assign(user, { passwordHash: null, mustChangePassword: false });
      await revokeUserSessions(manager, user);
      await manager.insert(StaffSecurityEvent, { userId: user.id, actorId: user.id, type: SecurityEventType.PASSWORD_CHANGED, metadata: { forced } });
      return user;
    });
    await clearAttempts(this.db, limitKey);
    return forced ? this.mfa.startSession(updated, req) : this.mfa.continueSession(req, updated);
  }
}
