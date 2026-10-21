import { createHash, randomBytes } from 'node:crypto';
import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { User, UserStatus, publicUser } from '../users/user.entity';
import { hashPassword, verifyPassword } from './password';
import { AuthRequest } from './session';
import { LoginDto } from './auth.dto';
import { accessFor } from './policy';
@Injectable()
export class AuthService {
  private readonly dummyHash = hashPassword(randomBytes(32).toString('hex'));
  constructor(private readonly db: DataSource, private readonly config: ConfigService) {}
  async login(input: LoginDto, req: AuthRequest) {
    // Atomic PostgreSQL counters work across API instances. Retain neither emails nor passwords here.
    const key = createHash('sha256').update(input.email).digest('hex');
    await this.db.query(`DELETE FROM login_attempts WHERE key IN (SELECT key FROM login_attempts WHERE "expiresAt" <= now() LIMIT 100)`);
    await this.consumeLimit('global-login-budget', 60, 60);
    await this.consumeLimit(key, 5, 900);
    const user = await this.db.getRepository(User).createQueryBuilder('user').addSelect(['user.passwordHash', 'user.authVersion']).where('lower(user.email) = :email', { email: input.email }).getOne();
    const matches = await verifyPassword(user?.passwordHash ?? await this.dummyHash, input.password);
    if (!user || !user.passwordHash || !matches || user.status !== UserStatus.ACTIVE) throw new UnauthorizedException('Invalid email or password');
    await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.userId = user.id;
    req.session.authVersion = user.authVersion;
    req.session.expiresAt = Date.now() + this.config.getOrThrow<number>('SESSION_TTL_SECONDS') * 1000;
    await this.db.getRepository(User).update(user.id, { lastLoginAt: new Date() });
    await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    return { user: publicUser(user), ...accessFor(user) };
  }
  private async consumeLimit(key: string, limit: number, seconds: number): Promise<void> {
    const rows: { attempts: number }[] = await this.db.query(`INSERT INTO login_attempts (key, attempts, "expiresAt") VALUES ($1, 1, now() + $2 * interval '1 second')
      ON CONFLICT (key) DO UPDATE SET attempts = CASE WHEN login_attempts."expiresAt" <= now() THEN 1 ELSE login_attempts.attempts + 1 END,
      "expiresAt" = CASE WHEN login_attempts."expiresAt" <= now() THEN now() + $2 * interval '1 second' ELSE login_attempts."expiresAt" END RETURNING attempts`, [key, seconds]);
    if (rows[0].attempts > limit) throw new HttpException('Too many login attempts. Try again later.', 429);
  }

}
