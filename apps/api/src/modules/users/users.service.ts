import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Role, User, UserStatus, publicUser } from './user.entity';
import { CreateUserDto, UpdateUserDto } from './users.dto';
import { generatePassword, hashPassword } from '../auth/password';
import { revokeUserSessions } from '../auth/revoke';
import { SecurityEventType, StaffSecurityEvent } from '../auth/mfa.entity';
import { clearSavedSignature } from '../documents/saved-signature';
import { removeEmailEnrolment } from '../auth/mfa.service';
import { handOver, openRecords, RESPONSIBLE_ROLES } from '../onboarding/hand-over';
import { companyEmailOf, syncSignIns } from '../dispatch/lead-sign-in';
type Editable = 'firstName' | 'lastName' | 'email' | 'role' | 'status';
const EDITABLE: Editable[] = ['firstName', 'lastName', 'email', 'role', 'status'];
// Audit event per kind of change. Names change nothing about access; the others end the user's sessions.
const CHANGE_EVENTS: { type: SecurityEventType; fields: string[]; revokes: boolean }[] = [
  { type: SecurityEventType.USER_NAME_CHANGED, fields: ['firstName', 'lastName'], revokes: false },
  { type: SecurityEventType.USER_EMAIL_CHANGED, fields: ['email'], revokes: true },
  // A team lead's dispatcher record decides what they can see, so changing it is a role change.
  { type: SecurityEventType.USER_ROLE_CHANGED, fields: ['role', 'memberId'], revokes: true },
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
    const links: { id: string; accountUserId: string }[] = await this.db.query(`SELECT id, "accountUserId" FROM dispatch_members WHERE "accountUserId" IS NOT NULL`);
    const members = new Map(links.map(row => [row.accountUserId, row.id]));
    return users.map(user => ({ ...publicUser(user), mfaEnabled: methods.has(user.id), mfaMethod: methods.get(user.id) ?? null, mustChangePassword: user.mustChangePassword, memberId: members.get(user.id) ?? null }));
  }
  /**
   * Without a password the API generates one and returns it this once, for the administrator to send them; only its hash is kept.
   * Either way someone else knows it, so the user must replace it at the first sign-in.
   */
  async create(dto: CreateUserDto, actor: User) {
    const { password, memberId, ...fields } = dto;
    const generatedPassword = password === undefined ? generatePassword() : undefined;
    const passwordHash = await hashPassword(password ?? generatedPassword!);
    try {
      return await this.db.transaction(async manager => {
        await this.lockAdministration(manager, actor);
        const repo = manager.getRepository(User);
        const user = await repo.save(repo.create({ ...fields, passwordHash, mustChangePassword: true }));
        const link = await this.linkMember(manager, user, memberId);
        await this.companyEmailOnly(manager, user, link.after);
        // A request waiting for IT to create this sign-in is no longer needed.
        await syncSignIns(manager, [link.after], actor.id, false);
        const provided = [...Object.entries(fields).filter(([, value]) => value !== undefined).map(([key]) => key), ...(link.changed ? ['memberId'] : [])];
        await this.audit(manager, user.id, actor.id, SecurityEventType.USER_CREATED, { fields: [...provided, 'password'] });
        return { ...publicUser(user), ...(generatedPassword ? { generatedPassword } : {}) };
      });
    } catch (error) { return this.handleError(error); }
  }
  /**
   * A team lead's account points at exactly one current dispatcher record; other roles point at none. Returns the record
   * before and after, and whether the link changed. The unique index keeps one account per dispatcher.
   */
  private async linkMember(manager: EntityManager, user: User, requested: string | null | undefined) {
    const [current] = await manager.query(`SELECT id FROM dispatch_members WHERE "accountUserId" = $1 FOR UPDATE`, [user.id]);
    const target = user.role === Role.TEAM_LEAD ? (requested === undefined ? current?.id ?? null : requested) : null;
    if (user.role === Role.TEAM_LEAD && !target) throw new BadRequestException('Choose the dispatcher record for this team lead.');
    const result = { before: (current?.id ?? null) as string | null, after: target as string | null, changed: (current?.id ?? null) !== target };
    if (!result.changed) return result;
    if (target) {
      const [member] = await manager.query(`SELECT position, status, "accountUserId" FROM dispatch_members WHERE id = $1 FOR UPDATE`, [target]);
      if (!member || member.position !== 'DISPATCHER' || member.status === 'LEFT') throw new BadRequestException('A team lead account links to a current dispatcher.');
      if (member.accountUserId) throw new ConflictException('This dispatcher already has a team lead account.');
    }
    if (current) await manager.query(`UPDATE dispatch_members SET "accountUserId" = NULL WHERE id = $1`, [current.id]);
    if (target) await manager.query(`UPDATE dispatch_members SET "accountUserId" = $1 WHERE id = $2`, [user.id, target]);
    return result;
  }
  /** A team lead signs in with their dispatcher record's company email, never a personal or made-up one. */
  private async companyEmailOnly(manager: EntityManager, user: User, memberId: string | null) {
    if (user.role !== Role.TEAM_LEAD || !memberId) return;
    const { email } = await companyEmailOf(manager, memberId);
    if (!email) throw new BadRequestException('Record their company email on their dispatcher record first. A team lead signs in with it.');
    if (email !== user.email.toLowerCase()) throw new BadRequestException(`A team lead signs in with their company email, ${email}.`);
  }
  /** What a manager is responsible for now, asked before their account is deactivated or their role changes. */
  async openRecords(id: string) {
    if (!await this.db.getRepository(User).existsBy({ id })) throw new NotFoundException();
    return (await openRecords(this.db.manager, id)).counts;
  }
  async update(id: string, dto: UpdateUserDto, actor: User) {
    if (dto.generatePassword && dto.password) throw new BadRequestException('Choose a password or generate one, not both');
    // Someone resetting their own password has Account security, which asks for the current one.
    if (dto.generatePassword && id === actor.id) throw new BadRequestException('Change your own password in Account security');
    const generatedPassword = dto.generatePassword ? generatePassword() : undefined;
    const newPassword = generatedPassword ?? dto.password;
    const passwordHash = newPassword ? await hashPassword(newPassword) : undefined;
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
        // A manager losing access hands their open records to someone first, in this same transaction.
        const wasResponsible = user.status === UserStatus.ACTIVE && RESPONSIBLE_ROLES.includes(user.role);
        const losesAccess = dto.status === UserStatus.INACTIVE || (dto.role !== undefined && !RESPONSIBLE_ROLES.includes(dto.role));
        const handedOver = wasResponsible && losesAccess ? await this.handOverFor(manager, id, dto.handOverTo, actor) : 0;
        // The editor submits every field; only real differences count as changes.
        const changed: string[] = EDITABLE.filter(key => dto[key] !== undefined && dto[key] !== user[key]);
        for (const key of changed) Object.assign(user, { [key]: dto[key as Editable] });
        const link = await this.linkMember(manager, user, dto.memberId);
        if (link.changed) changed.push('memberId');
        // Turning an account back on counts too: it comes back only under the company email they sign in with now.
        if (['email', 'role', 'memberId'].some(field => changed.includes(field)) || (changed.includes('status') && user.status === UserStatus.ACTIVE)) await this.companyEmailOnly(manager, user, link.after);
        if (passwordHash) {
          changed.push('password');
          user.passwordHash = passwordHash;
          // Someone else chose it, so it is replaced at the next sign-in; an administrator's own choice is not.
          user.mustChangePassword = id !== actor.id;
        }
        const events = CHANGE_EVENTS.filter(event => event.fields.some(field => changed.includes(field)));
        const sessionsRevoked = events.some(event => event.revokes);
        if (changed.length) await repo.save(user);
        // Waiting sign-in requests this change answered (an account turned on or off, a new link) are cancelled, once the account
        // is saved so they're checked against what it is now. None are asked for here: the administrator changed it on purpose.
        await syncSignIns(manager, [link.before, link.after], actor.id, false);
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
        return { ...publicUser(user), sessionsRevoked, handedOver, ...(generatedPassword ? { generatedPassword } : {}) };
      });
    } catch (error) { return this.handleError(error); }
  }
  private async handOverFor(manager: EntityManager, id: string, to: string | undefined, actor: User) {
    const { counts } = await openRecords(manager, id);
    if (!counts.total) return 0;
    if (!to) throw new ConflictException({ message: 'Choose who takes over their open records.', openRecords: counts });
    return handOver(manager, id, to, actor.id);
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
