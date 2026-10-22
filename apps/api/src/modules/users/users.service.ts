import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { Role, User, UserStatus, publicUser } from './user.entity';
import { CreateUserDto, UpdateUserDto } from './users.dto';
import { hashPassword } from '../auth/password';
@Injectable()
export class UsersService {
  constructor(private readonly db: DataSource, private readonly config: ConfigService) {}
  private fictionalEmail(email?: string, preservedOperator = false) {
    if (!preservedOperator && this.config.get('DEMO_EMAIL_MODE') === true && email && !email.endsWith('@example.test')) throw new BadRequestException('Demo accounts require fictional example.test addresses');
  }
  async list() { return (await this.db.getRepository(User).find({ order: { createdAt: 'ASC' }, take: 200 })).map(publicUser); }
  async create(dto: CreateUserDto) {
    this.fictionalEmail(dto.email);
    try {
      const { password, ...fields } = dto;
      const user = await this.db.getRepository(User).save(this.db.getRepository(User).create({ ...fields, passwordHash: await hashPassword(password) }));
      return publicUser(user);
    } catch (error) { return this.handleError(error); }
  }
  async update(id: string, dto: UpdateUserDto, actor: User) {
    const passwordHash = dto.password ? await hashPassword(dto.password) : undefined;
    try {
      return await this.db.transaction(async manager => {
        // Serialize administrator mutations to preserve the final active administrator.
        await manager.query('SELECT pg_advisory_xact_lock(42002026)');
        const repo = manager.getRepository(User);
        const currentActor = await repo.findOneBy({ id: actor.id });
        if (!currentActor || currentActor.role !== Role.SYSTEM_ADMIN || currentActor.status !== UserStatus.ACTIVE) throw new BadRequestException('Administrator access changed');
        const user = await repo.createQueryBuilder('user').addSelect('user.authVersion').setLock('pessimistic_write').where('user.id = :id', { id }).getOne();
        if (!user) throw new NotFoundException();
        let preservedOperator = false;
        if (this.config.get('DEMO_EMAIL_MODE') === true) {
          const [identity] = await manager.query('SELECT mode, "operatorAdminId" FROM deployment_identity WHERE id=true');
          preservedOperator = identity?.mode === 'starter' && identity.operatorAdminId === user.id;
          if (preservedOperator && ((dto.role && dto.role !== Role.SYSTEM_ADMIN) || dto.status === UserStatus.INACTIVE)) throw new BadRequestException('The starter demo operator must remain an active administrator');
        }
        this.fictionalEmail(dto.email, preservedOperator && dto.email === user.email);

        if (id === actor.id && ((dto.role && dto.role !== Role.SYSTEM_ADMIN) || dto.status === UserStatus.INACTIVE)) throw new BadRequestException('You cannot remove your own administrator access');
        if (user.role === Role.SYSTEM_ADMIN && user.status === UserStatus.ACTIVE && ((dto.role && dto.role !== Role.SYSTEM_ADMIN) || dto.status === UserStatus.INACTIVE)) {
          if (await repo.countBy({ role: Role.SYSTEM_ADMIN, status: UserStatus.ACTIVE }) <= 1) throw new BadRequestException('At least one active administrator is required');
        }
        const { password: _password, ...fields } = dto;
        void _password;
        Object.assign(user, fields, { authVersion: user.authVersion + 1 });
        if (passwordHash) user.passwordHash = passwordHash;
        await repo.save(user);
        await manager.query(`DELETE FROM staff_sessions WHERE sess->>'userId' = $1`, [id]);
        return publicUser(user);
      });
    } catch (error) { return this.handleError(error); }
  }
  private handleError(error: unknown): never {
    if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23505') throw new ConflictException('Email is already in use');
    throw error;
  }
}
