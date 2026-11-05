import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength, ValidateIf } from 'class-validator';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { generatePassword, hashPassword } from '../auth/password';
import { revokeUserSessions } from '../auth/revoke';
import { SecurityEventType, StaffSecurityEvent } from '../auth/mfa.entity';
import { companyEmailOf, companyEmailSql, lockAccount, syncSignIns, TeamLeadSignIn, turnOffAccount, wantedSignIn } from '../dispatch/lead-sign-in';
import { DispatchEvent, DispatchMember } from '../dispatch/dispatch.entity';
import { onboardingLimit } from '../onboarding/rate-limit';
import { Role, User, UserStatus } from '../users/user.entity';

export class SignInDto {
 // Only when no company email is recorded: IT adds it here and it's saved on their record too.
 @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
 @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== '') @IsEmail() @MaxLength(254) companyEmail?: string;
}

/** Same advisory lock as user administration, so this and an administrator's edit can't change one account at once. */
const ADMINISTRATION_LOCK = 42002026;
/** ExistingDispatchersService's lock for adding and correcting recorded details. */
const RECORDED_DETAILS_LOCK = 42002037;
const STALE = 'This changed since it was asked. Reload IT tasks.';
const HANDLED = 'This sign-in was already handled or is no longer needed. Reload IT tasks.';

/**
 * IT or an administrator does what a team lead sign-in request asks: creates the account with the dispatcher's company
 * email, turns their old one back on, or turns it off. A first password is generated and returned once; only its hash is
 * kept, it must be replaced at the first sign-in and the workspace never emails it.
 */
@Injectable()
export class SignInsService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService) {}
 async complete(user: User, id: string, dto: SignInDto) {
  if (user.status !== UserStatus.ACTIVE || ![Role.SYSTEM_ADMIN, Role.IT_SPECIALIST].includes(user.role)) throw new ForbiddenException();
  await onboardingLimit(this.db, 'it-sign-in:' + user.id, 30, 60);
  const fictionalOnly = !(this.config.get('NODE_ENV') === 'production' || this.config.get('DEPLOYMENT_PURPOSE') === 'production');
  if (fictionalOnly && dto.companyEmail && !dto.companyEmail.endsWith('@example.test')) throw new BadRequestException('Outside production, emails must be fictional example.test addresses.');
  const asked = await this.db.getRepository(TeamLeadSignIn).findOneBy({ id });
  if (!asked) throw new NotFoundException();
  if (asked.doneAt || asked.cancelledAt) throw new ConflictException(HANDLED);
  // Hashing is slow, so it happens before any lock is taken, and only for a request that gives out a password.
  const password = asked.kind === 'TURN_OFF' ? null : generatePassword(), passwordHash = password ? await hashPassword(password) : null;
  let outcome: { stale: true } | { stale: false; result: Record<string, unknown> };
  try {
   outcome = await this.db.transaction(async em => {
    await em.query('SELECT pg_advisory_xact_lock($1)', [ADMINISTRATION_LOCK]);
    const actor = await em.getRepository(User).findOneBy({ id: user.id });
    if (!actor || actor.status !== UserStatus.ACTIVE || ![Role.SYSTEM_ADMIN, Role.IT_SPECIALIST].includes(actor.role)) throw new ForbiddenException();
    // An email IT types is saved on their recorded details, under the lock a manager's edit of them takes first.
    if (dto.companyEmail) await em.query('SELECT pg_advisory_xact_lock($1)', [RECORDED_DETAILS_LOCK]);
    // The dispatcher's record before the request, the order every dispatch change takes them in (a request never moves
    // to another dispatcher, so the one read above names the right record).
    const member = await em.getRepository(DispatchMember).findOne({ where: { id: asked.memberId }, lock: { mode: 'pessimistic_write' } });
    const request = await em.getRepository(TeamLeadSignIn).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!request || !member) throw new NotFoundException();
    if (request.doneAt || request.cancelledAt) throw new ConflictException(HANDLED);
    // Things may have changed since it was asked (a new lead, someone leaving): the request is brought up to date and
    // kept, and IT reloads to see what's needed now.
    if (await wantedSignIn(em, member.id) !== request.kind) { await syncSignIns(em, [member.id], null); return { stale: true as const }; }
    let account: User | null = null;
    if (request.kind === 'CREATE') {
     const email = await this.signInEmail(em, member, dto.companyEmail, user.id);
     const repo = em.getRepository(User);
     account = await repo.save(repo.create({ firstName: member.firstName, lastName: member.lastName, email, role: Role.TEAM_LEAD, status: UserStatus.ACTIVE, passwordHash: passwordHash!, mustChangePassword: true }));
     await em.query(`UPDATE dispatch_members SET "accountUserId" = $1 WHERE id = $2`, [account.id, member.id]);
     await this.audit(em, account.id, user.id, SecurityEventType.USER_CREATED, { fields: ['firstName', 'lastName', 'email', 'role', 'memberId', 'password'], reason: 'team-lead-sign-in' });
    } else {
     account = await lockAccount(em, member.accountUserId);
     if (!account) throw new ConflictException('Their account no longer exists. Reload IT tasks.');
     // Only the linked team lead account is ever switched here, never another kind of account.
     if (account.role !== Role.TEAM_LEAD) throw new ConflictException('Their linked account isn’t a team lead account any more. An administrator can check it in Staff accounts.');
     if (request.kind === 'TURN_ON') {
      // The account comes back only under the company email they sign in with now.
      const { email } = await companyEmailOf(em, member.id);
      if (email !== account.email.toLowerCase()) throw new ConflictException(email ? `Their company email is now ${email}. An administrator changes their sign-in email in Staff accounts first.` : 'Their company email isn’t recorded any more. Record it on their dispatcher record first.');
      // An old password may be known to someone else by now, so they get a new first one.
      await em.getRepository(User).update(account.id, { status: UserStatus.ACTIVE, passwordHash: passwordHash!, mustChangePassword: true });
      await revokeUserSessions(em, account);
      await this.audit(em, account.id, user.id, SecurityEventType.USER_STATUS_CHANGED, { fields: ['status'], sessionsRevoked: true, reason: 'team-lead-again' });
      await this.audit(em, account.id, user.id, SecurityEventType.USER_PASSWORD_SET, { fields: ['password'], sessionsRevoked: true, reason: 'team-lead-again' });
     } else await turnOffAccount(em, account, user.id, 'no-longer-team-lead');
    }
    Object.assign(request, { doneAt: new Date(), doneBy: user.id, userId: account.id }); await em.save(request);
    return { stale: false as const, result: { id, kind: request.kind, email: account.email, name: `${member.firstName} ${member.lastName}`, ...(password ? { generatedPassword: password } : {}) } };
   });
  } catch (error) {
   // Only the email index means the email is taken; any other clash (an account or request made at the same moment) is a reload.
   const clash = error instanceof QueryFailedError ? error.driverError as { code?: string; constraint?: string } : null;
   if (clash?.code === '23505') throw new ConflictException(clash.constraint === 'users_email_lower_unique' ? 'This email already signs in to another account. Use their own company email.' : STALE);
   throw error;
  }
  // Said after the commit, so the corrected request stays for the reload.
  if (outcome.stale) throw new ConflictException(STALE);
  return outcome.result;
 }
 /**
  * Always their company email: the recorded one, or one IT adds now, never a personal email or one another account uses.
  * One IT adds is kept where a manager recorded their details. Someone with IT setup always has one, because setup can't
  * finish without it, and a finished setup is never changed here.
  */
 private async signInEmail(em: EntityManager, member: DispatchMember, given: string | undefined, actorId: string) {
  const recorded = await companyEmailOf(em, member.id);
  if (recorded.email && given && given !== recorded.email) throw new BadRequestException('To use a different email, correct it on their dispatcher record first.');
  const email = recorded.email ?? given;
  if (!email) throw new BadRequestException('Add their company email first. It’s what they’ll sign in with.');
  if (recorded.personal.includes(email)) throw new BadRequestException(`This is their personal email. Use ${member.firstName}’s company email.`);
  if ((await em.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [email])).length) throw new ConflictException(`This email already signs in to another account. Use ${member.firstName}’s own company email.`);
  if (!recorded.email) {
   if (!recorded.hasRecord) throw new BadRequestException('Their company email can’t be added here. Contact an administrator.');
   // The same rule as correcting recorded details: nobody else current has it as a company email or a contact.
   const [used] = await em.query(`SELECT 1 FROM dispatch_members d LEFT JOIN existing_member_records e ON e."memberId" = d.id
     WHERE d.id <> $1 AND d.status <> 'LEFT' AND (lower(${companyEmailSql()}) = $2 OR EXISTS(SELECT 1 FROM member_contacts c WHERE c."memberId" = d.id AND c.kind = 'EMAIL' AND c."removedAt" IS NULL AND lower(c.value) = $2))
     LIMIT 1`, [member.id, email]);
   if (used) throw new ConflictException('Someone in the workspace already has this company email. Use their own company email.');
   await em.query(`UPDATE existing_member_records SET "companyEmail" = $1 WHERE "memberId" = $2`, [email, member.id]);
   // A manager with their record open has to reload before saving, so this email isn't wiped by an older copy.
   member.version += 1; await em.save(member);
   // In the record's history like a manager's edit: the field name only, never the email.
   await em.getRepository(DispatchEvent).save({ memberId: member.id, teamId: null, event: 'EXISTING_UPDATED', actorId, metadata: { fields: ['companyEmail'], reason: 'team-lead-sign-in' } });
  }
  return email;
 }
 // Metadata only: field names and why, never values.
 private async audit(em: EntityManager, userId: string, actorId: string, type: SecurityEventType, metadata: StaffSecurityEvent['metadata']) {
  await em.insert(StaffSecurityEvent, { userId, actorId, type, metadata });
 }
}
