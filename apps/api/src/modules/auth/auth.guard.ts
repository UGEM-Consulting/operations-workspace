import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Role, User, UserStatus } from '../users/user.entity';
import { MfaService } from './mfa.service';
import { MFA_STAGES, PUBLIC, ROLES } from './policy';
import { AuthRequest, MfaStage } from './session';
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: DataSource, private readonly mfa: MfaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, targets);
    const pending = req.session?.mfaPending;
    // A half-signed-in session only reaches routes that explicitly admit its stage.
    if (!req.session?.userId && pending) {
      const stages = this.reflector.getAllAndOverride<MfaStage[]>(MFA_STAGES, targets);
      if (!stages?.includes(pending.stage) || pending.expiresAt <= Date.now()) throw new UnauthorizedException();
      return this.authorize(req, await this.load(pending.userId), pending.authVersion, roles);
    }
    if (!req.session?.userId || !req.session.expiresAt || req.session.expiresAt <= Date.now()) throw new UnauthorizedException();
    const user = await this.load(req.session.userId);
    // Sessions without a completed second step end once the user enrols or their role/policy requires MFA.
    if (user && req.session.mfa !== 'verified') {
      const state = await this.mfa.state(user);
      if (state.enrolled || state.required) throw new UnauthorizedException();
    }
    return this.authorize(req, user, req.session.authVersion, roles);
  }
  private load(id: string) {
    return this.db.getRepository(User).createQueryBuilder('user').addSelect('user.authVersion').where('user.id = :id', { id }).getOne();
  }
  private authorize(req: AuthRequest, user: User | null, authVersion: number | undefined, roles: Role[] | undefined): boolean {
    if (!user || user.status !== UserStatus.ACTIVE || user.authVersion !== authVersion) throw new UnauthorizedException();
    req.currentUser = user;
    if (!roles || !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}
