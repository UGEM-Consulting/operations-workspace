import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Role, User, UserStatus } from '../users/user.entity';
import { PUBLIC, ROLES } from './policy';
import { AuthRequest } from './session';
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: DataSource) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (!req.session?.userId || !req.session.expiresAt || req.session.expiresAt <= Date.now()) throw new UnauthorizedException();
    const user = await this.db.getRepository(User).createQueryBuilder('user').addSelect('user.authVersion').where('user.id = :id', { id: req.session.userId }).getOne();
    if (!user || user.status !== UserStatus.ACTIVE || user.authVersion !== req.session.authVersion) throw new UnauthorizedException();
    req.currentUser = user;
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, targets);
    if (!roles || !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}
