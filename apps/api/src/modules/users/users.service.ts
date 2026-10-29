import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Role, User, UserStatus, publicUser } from './user.entity';
import { CreateUserDto, UpdateUserDto } from './users.dto';
import { hashPassword } from '../auth/password';
import { revokeUserSessions } from '../auth/revoke';
import { SecurityEventType, StaffSecurityEvent } from '../auth/mfa.entity';
import { clearSavedSignature } from '../documents/saved-signature';
import { removeEmailEnrolment } from '../auth/mfa.service';
type Editable = 'firstName' | 'lastName' | 'email' | 'role' | 'status';
const EDITABLE: Editable[] = ['firstName', 'lastName', 'email', 'role', 'status'];
// Audit event per kind of change. Names change nothing about access; the others end the user's sessions.
const CHANGE_EVENTS: { type: SecurityEventType; fields: string[]; revokes: boolean }[] = [
  { type: SecurityEventType.USER_NAME_CHANGED, fields: ['firstName', 'lastName'], revokes: false },
  { type: SecurityEventType.USER_EMAIL_CHANGED, fields: ['email'], revokes: true },
  { type: SecurityEventType.USER_ROLE_CHANGED, fields: ['role'], revokes: true },
  { type: SecurityEventType.USER_STATUS_CHANGED, fields: ['status'], revokes: true },
  { type: SecurityEventType.USER_PASSWORD_SET, fields: ['password'], revokes: true },
];
@Injectable()
export class UsersService {
  constructor(private readonly db: DataSource) {}
  async list() {
    const users = await this.db.getRepository(User).find({ order: { createdAt: 'ASC' }, take: 200 });
    const enrolled: { userId: string; method: string }[] = await this.db.query(`SELECT "userId", method FROM staff_mfa WHERE "confirmedAt" IS NOT NULL`);
    const methods = new Map(enrolled.map(row => [row.userId, row.method]));
    return users.map(user => ({ ...publicUser(user), mfaEnabled: methods.has(user.id), mfaMethod: methods.get(user.id) ?? null, mustChangePassword: user.mustChangePassword }));
  }
  /** The administrator chose the initial password, so the user must replace it at the first sign-in. */
  async create(dto: CreateUserDto, actor: User) {
    const { password, ...fields } = dto;
    const passwordHash = await hashPassword(password);
    try {
      return await this.db.transaction(async manager => {
        await this.lockAdministration(manager, actor);
        const repo = manager.getRepository(User);
        const user = await repo.save(repo.create({ ...fields, passwordHash, mustChangePassword: true }));
        const provided = Object.entries(fields).filter(([, value]) => value !== undefined).map(([key]) => key);
        await this.audit(manager, user.id, actor.id, SecurityEventType.USER_CREATED, { fields: [...provided, 'password'] });
        return publicUser(user);
      });
    } catch (error) { return this.handleError(error); }
  }
  async update(id: string, dto: UpdateUserDto, actor: User) {
    const passwordHash = dto.password ? await hashPassword(dto.password) : undefined;
    try {
      return await this.db.transaction(async manager => {
        await this.lockAdministration(manager, actor);
        const repo = manager.getRepository(User);
        const user = await repo.createQueryBuilder('user').addSelect('user.authVersion').setLock('pessimistic_write').where('user.id = :id', { id }).getOne();
        if (!user) throw new NotFoundException();
        if (id === actor.id && ((dto.role && dto.role !== Role.SYSTEM_ADMIN) || dto.status === UserStatus.INACTIVE)) throw new BadRequestException('You cannot remove your own administrator access');
        if (user.role === Role.SYSTEM_ADMIN && user.status === UserStatus.ACTIVE && ((dto.role && dto.role !== Role.SYSTEM_ADMIN) || dto.status === UserStatus.INACTIVE)) {
          if (await repo.countBy({ role: Role.SYSTEM_ADMIN, status: UserStatus.ACTIVE }) <= 1) throw new BadRequestException('At least one active administrator is required');
        }
        // The editor submits every field; only real differences count as changes.
        const changed: string[] = EDITABLE.filter(key => dto[key] !== undefined && dto[key] !== user[key]);
        for (const key of changed) Object.assign(user, { [key]: dto[key as Editable] });
        if (passwordHash) {
          changed.push('password');
          user.passwordHash = passwordHash;
          // Someone else chose it, so it is replaced at the next sign-in; an administrator's own choice is not.
          user.mustChangePassword = id !== actor.id;
        }
        const events = CHANGE_EVENTS.filter(event => event.fields.some(field => changed.includes(field)));
        const sessionsRevoked = events.some(event => event.revokes);
        if (changed.length) await repo.save(user);
        if (sessionsRevoked) {
          await revokeUserSessions(manager, user);
          // Another administrator changed this account (identity, role, status or a password they chose): the owner
          // saves their signature again. An administrator editing their own account keeps theirs.
          if (id !== actor.id) await clearSavedSignature(manager, id, actor.id, 'account-change');
        }
        // Administrators must use an authenticator app; a new administrator with email codes sets one up at the next sign-in.
        if (changed.includes('role') && user.role === Role.SYSTEM_ADMIN) await removeEmailEnrolment(manager, id, actor.id);
        for (const event of events) {
          await this.audit(manager, id, actor.id, event.type, { fields: event.fields.filter(field => changed.includes(field)), sessionsRevoked });
        }
        return { ...publicUser(user), sessionsRevoked };
      });
    } catch (error) { return this.handleError(error); }
  }
  /** Serializes administrator mutations (preserving the final active administrator) and rechecks the actor in the transaction. */
  private async lockAdministration(manager: EntityManager, actor: User) {
    await manager.query('SELECT pg_advisory_xact_lock(42002026)');
    const current = await manager.getRepository(User).findOneBy({ id: actor.id });
    if (!current || current.role !== Role.SYSTEM_ADMIN || current.status !== UserStatus.ACTIVE) throw new BadRequestException('Administrator access changed');
  }
  // Metadata only: field names, never values.
  private async audit(manager: EntityManager, userId: string, actorId: string, type: SecurityEventType, metadata: StaffSecurityEvent['metadata']) {
    await manager.insert(StaffSecurityEvent, { userId, actorId, type, metadata });
  }
  private handleError(error: unknown): never {
    if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23505') throw new ConflictException('Email is already in use');
    throw error;
  }
}
