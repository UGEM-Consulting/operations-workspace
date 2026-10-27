import { createHash, randomBytes } from 'node:crypto';
import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User, UserStatus } from '../users/user.entity';
import { hashPassword, verifyPassword } from './password';
import { AuthRequest } from './session';
import { LoginDto } from './auth.dto';
import { countAttempt } from './attempts';
import { MfaService } from './mfa.service';
@Injectable()
export class AuthService {
  private readonly dummyHash = hashPassword(randomBytes(32).toString('hex'));
  constructor(private readonly db: DataSource, private readonly mfa: MfaService) {}
  async login(input: LoginDto, req: AuthRequest) {
    // Atomic PostgreSQL counters work across API instances. Retain neither emails nor passwords here.
    const key = createHash('sha256').update(input.email).digest('hex');
    await this.db.query(`DELETE FROM login_attempts WHERE key IN (SELECT key FROM login_attempts WHERE "expiresAt" <= now() LIMIT 100)`);
    await this.consumeLimit('global-login-budget', 60, 60);
    await this.consumeLimit(key, 5, 900);
    const user = await this.db.getRepository(User).createQueryBuilder('user').addSelect(['user.passwordHash', 'user.authVersion']).where('lower(user.email) = :email', { email: input.email }).getOne();
    const matches = await verifyPassword(user?.passwordHash ?? await this.dummyHash, input.password);
    if (!user || !user.passwordHash || !matches || user.status !== UserStatus.ACTIVE) throw new UnauthorizedException('Invalid email or password');
    // Enrolled or MFA-required users continue to a second step; nobody gets staff access before it.
    return this.mfa.startSession(user, req);
  }
  private async consumeLimit(key: string, limit: number, seconds: number): Promise<void> {
    if (await countAttempt(this.db, key, seconds) > limit) throw new HttpException('Too many login attempts. Try again later.', 429);
  }
}
