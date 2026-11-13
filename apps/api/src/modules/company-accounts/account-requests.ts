import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { DispatchEvent, DispatchMember, ExistingMemberRecord } from '../dispatch/dispatch.entity';
import { ItOnboardingActivity, ItOnboardingRequest, PortalNotification, itStatus } from '../it/it.entity';
import { memberSetups, setupAccounts } from '../it/removal';
import { onboardingLimit } from '../onboarding/rate-limit';
import { Role, UserStatus, type User } from '../users/user.entity';
import { checkEmailFree, refreshRemovalAccounts } from './accounts';
import { ACCOUNT_TASKS, ItAccountActivity, ItAccountRequest, ItAccountTask, type AccountRequestProfile, type AccountTaskKey } from './account-requests.entity';
import { CompanyAccount } from './company-accounts.entity';

const done = (task: Pick<ItAccountTask, 'status'>) => task.status === 'COMPLETED';
/** Someone's main accounts: what IT recorded on their setups (newest first), else what a manager recorded by hand. */
export async function mainAccounts(em: EntityManager, memberId: string) {
 const setups = await memberSetups(em, memberId), fromIt = setups.length ? setupAccounts(setups) : null;
 const record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId });
 return { companyEmail: fromIt?.companyEmail ?? record?.companyEmail ?? null, ringCentralNumber: fromIt?.ringCentralNumber ?? record?.ringCentralNumber ?? null,
  ringCentralExtension: fromIt?.ringCentralExtension ?? record?.ringCentralExtension ?? null, setup: setups.find(setup => setup.companyEmail || setup.assignedRingCentralPhoneNumber) ?? null, record };
}
/** The load board accounts an email still signs in to (open seats). */
async function seatsUsing(em: Pick<EntityManager, 'query'>, email: string | null): Promise<string[]> {
 if (!email) return [];
 return (await em.query(`SELECT DISTINCT a.name FROM member_load_board_seats s JOIN load_board_accounts a ON a.id = s."accountId" WHERE s.status <> 'ENDED' AND s."signInEmail" = lower($1) ORDER BY a.name`, [email])).map((row: { name: string }) => row.name);
}

/**
 * A move to another MC with new accounts (KeptForLoadBoardsMoveScreen), in the move's transaction: IT creates the email and
 * number at the new MC and closes the old ones, except an email that still signs in to a load board seat, which is kept
 * unless the manager said to close it anyway. Nothing changes on the record until IT finishes.
 */
export async function askForMoveAccounts(em: EntityManager, actorId: string, member: DispatchMember, from: { id: string; name: string } | null, to: { id: string; name: string }, closeKept: boolean) {
 if (await em.getRepository(ItAccountRequest).existsBy({ memberId: member.id, kind: 'MOVE', completedAt: IsNull(), cancelledAt: IsNull() }))
  throw new ConflictException('IT is still working on their accounts from an earlier move. Wait for it to finish, or keep the same accounts.');
 const main = await mainAccounts(em, member.id), kept = closeKept ? [] : await seatsUsing(em, main.companyEmail);
 const profile: AccountRequestProfile = { displayName: `${member.firstName} ${member.lastName}`, fromMc: from?.name ?? null, toMc: to.name, fromMcId: from?.id ?? null, toMcId: to.id, create: ['companyEmail', 'ringCentralNumber'],
  close: [...(main.ringCentralNumber ? [{ label: 'RingCentral number', value: main.ringCentralNumber }] : []), ...(main.companyEmail && !kept.length ? [{ label: 'Company email', value: main.companyEmail }] : [])],
  keep: main.companyEmail && kept.length ? [{ value: main.companyEmail, reason: `Signs in to ${kept.join(' and ')}` }] : [] };
 const keys: AccountTaskKey[] = ['NEW_EMAIL', 'NEW_NUMBER', ...(main.companyEmail && !kept.length ? ['CLOSE_EMAIL' as const] : []), ...(main.ringCentralNumber ? ['CLOSE_NUMBER' as const] : []), ...(main.companyEmail && !kept.length ? ['SHARED_PASSWORDS' as const] : [])];
 return openRequest(em, actorId, { memberId: member.id, kind: 'MOVE', accountId: null, profile, note: null, emailAfter: 'SUSPEND', forwardTo: null }, keys);
}
async function openRequest(em: EntityManager, actorId: string, input: Pick<ItAccountRequest, 'memberId' | 'kind' | 'accountId' | 'profile' | 'note' | 'emailAfter' | 'forwardTo'>, keys: AccountTaskKey[]) {
 const request = await em.getRepository(ItAccountRequest).save({ ...input, managerId: actorId });
 await em.getRepository(ItAccountTask).save(ACCOUNT_TASKS.filter(task => keys.includes(task.key)).map(task => ({ requestId: request.id, key: task.key, status: 'PENDING' as const, notes: '' })));
 await em.getRepository(ItAccountActivity).save({ requestId: request.id, actorId, event: 'ACCOUNT_REQUEST_CREATED', metadata: { kind: input.kind } });
 return request;
}

/**
 * IT's checklists for company accounts (section 33, approved 2026-11-13): Close an account at another company (asked by a
 * dispatch manager or administrator once no load board seat uses it), and the new accounts of a move. IT and administrators
 * work them; finishing one updates the record and sends whoever asked a portal notice. Activity holds task keys and
 * statuses, never emails or numbers.
 */
@Injectable()
export class AccountRequestsService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService) {}
 private get fictionalOnly() { return !(this.config.get('NODE_ENV') === 'production' || this.config.get('DEPLOYMENT_PURPOSE') === 'production'); }
 private allowIt(user: User) { if (user.status !== UserStatus.ACTIVE || ![Role.SYSTEM_ADMIN, Role.IT_SPECIALIST].includes(user.role)) throw new ForbiddenException(); }

 /** Close one account at another company (CloseCompanyAccountScreen). Refused while a load board seat still signs in with it. */
 async askToClose(user: User, accountId: string, dto: { version: number; emailAfter: 'FORWARD' | 'SUSPEND'; note?: string }) {
  return this.db.transaction(async em => {
   const found = await em.getRepository(CompanyAccount).findOneBy({ id: accountId });
   if (!found) throw new NotFoundException('This account no longer exists.');
   const member = await em.getRepository(DispatchMember).findOne({ where: { id: found.memberId }, lock: { mode: 'pessimistic_write' } });
   const account = await em.getRepository(CompanyAccount).findOne({ where: { id: accountId }, lock: { mode: 'pessimistic_write' } });
   if (!member || !account) throw new NotFoundException('This account no longer exists.');
   if (account.version !== dto.version) throw new ConflictException('Someone else changed this account. Reload and try again.');
   if (account.status === 'CLOSED') throw new ConflictException('This account is already closed.');
   if (await em.getRepository(ItAccountRequest).existsBy({ accountId, completedAt: IsNull(), cancelledAt: IsNull() })) throw new ConflictException('IT has already been asked to close this account.');
   const using = await seatsUsing(em, account.companyEmail);
   if (using.length) throw new ConflictException(`It still signs in to ${using.join(' and ')}. Move or end that seat first.`);
   const company = (await em.query(`SELECT name FROM mcs WHERE id = $1`, [account.mcId]))[0]?.name ?? account.companyName;
   const profile: AccountRequestProfile = { displayName: `${member.firstName} ${member.lastName}`, fromMc: company, toMc: null, create: [], keep: [],
    close: [...(account.companyEmail ? [{ label: 'Company email', value: account.companyEmail }] : []), ...(account.ringCentralNumber ? [{ label: 'RingCentral number', value: account.ringCentralNumber }] : [])] };
   const forward = dto.emailAfter === 'FORWARD' && !!account.companyEmail;
   const request = await openRequest(em, user.id, { memberId: member.id, kind: 'CLOSE', accountId, profile, note: dto.note?.trim() || null, emailAfter: forward ? 'FORWARD' : 'SUSPEND', forwardTo: forward ? user.id : null },
    [...(account.companyEmail ? ['CLOSE_EMAIL' as const, 'SHARED_PASSWORDS' as const] : []), ...(account.ringCentralNumber ? ['CLOSE_NUMBER' as const] : [])]);
   account.version += 1; await em.save(account);
   await em.getRepository(DispatchEvent).save({ memberId: member.id, teamId: null, event: 'COMPANY_ACCOUNT_CHANGED', actorId: user.id, metadata: { fields: [], closeAsked: true, forward } });
   return { id: request.id };
  });
 }

 async detail(user: User, id: string) {
  this.allowIt(user);
  return this.view(this.db.manager, id);
 }
 private async view(em: EntityManager, id: string) {
  const request = await em.getRepository(ItAccountRequest).findOneBy({ id });
  if (!request) throw new NotFoundException();
  const tasks = await em.getRepository(ItAccountTask).findBy({ requestId: id });
  const activity = await em.getRepository(ItAccountActivity).find({ where: { requestId: id }, order: { createdAt: 'ASC' } });
  const [names] = await em.query(`SELECT (SELECT "firstName" || ' ' || "lastName" FROM users WHERE id = $1) AS manager, (SELECT "firstName" || ' ' || "lastName" FROM users WHERE id = $2) AS "forwardTo"`, [request.managerId, request.forwardTo]);
  return { request: { ...request, status: itStatus(request, tasks), managerName: names.manager as string | null, forwardToName: names.forwardTo as string | null },
   tasks: ACCOUNT_TASKS.flatMap(template => { const task = tasks.find(item => item.key === template.key); return task ? [{ ...task, label: template.label, description: template.description, optional: false }] : []; }), activity };
 }

 /** A move's new accounts as IT records them; completing a New task needs its value. */
 async contact(user: User, id: string, dto: { version: number; companyEmail?: string; ringCentralNumber?: string; ringCentralExtension?: string }) {
  this.allowIt(user); await onboardingLimit(this.db, 'it-contact:' + user.id, 60, 60);
  if (dto.companyEmail && this.fictionalOnly && !dto.companyEmail.endsWith('@example.test')) throw new BadRequestException('Outside production, emails must be fictional example.test addresses.');
  return this.db.transaction(async em => {
   const request = await this.locked(em, id, dto.version);
   if (request.kind !== 'MOVE') throw new BadRequestException('Only a move records new accounts.');
   if (dto.companyEmail) await checkEmailFree(em, dto.companyEmail, request.memberId);
   for (const [field, value] of [['newCompanyEmail', dto.companyEmail], ['newRingCentralNumber', dto.ringCentralNumber], ['newRingCentralExtension', dto.ringCentralExtension]] as const) if (value !== undefined) request[field] = value || null;
   for (const [key, value] of [['NEW_EMAIL', request.newCompanyEmail], ['NEW_NUMBER', request.newRingCentralNumber]] as const)
    if (!value && (await em.getRepository(ItAccountTask).findOneBy({ requestId: id, key }))?.status === 'COMPLETED') throw new BadRequestException('A completed task needs its account recorded.');
   request.version += 1; await em.save(request);
   await em.getRepository(ItAccountActivity).save({ requestId: id, actorId: user.id, event: 'ACCOUNTS_RECORDED', metadata: { email: !!request.newCompanyEmail, number: !!request.newRingCentralNumber } });
   return this.view(em, id);
  });
 }

 async task(user: User, id: string, key: string, dto: { version: number; status: string; notes?: string }) {
  this.allowIt(user); await onboardingLimit(this.db, 'it-task:' + user.id, 120, 60);
  if (!ACCOUNT_TASKS.some(task => task.key === key)) throw new NotFoundException();
  if (dto.status === 'NOT_NEEDED') throw new BadRequestException('Each of these tasks is needed.');
  return this.db.transaction(async em => {
   const request = await this.locked(em, id, dto.version);
   const task = await em.getRepository(ItAccountTask).findOneBy({ requestId: id, key: key as AccountTaskKey });
   if (!task) throw new NotFoundException();
   const notes = dto.notes ?? task.notes;
   if (dto.status === 'BLOCKED' && !notes.trim()) throw new BadRequestException('Provide a reason for a blocked task.');
   if (dto.status === 'COMPLETED' && key === 'NEW_EMAIL' && !request.newCompanyEmail) throw new BadRequestException('Record the new company email first.');
   if (dto.status === 'COMPLETED' && key === 'NEW_NUMBER' && !request.newRingCentralNumber) throw new BadRequestException('Record the new RingCentral number first.');
   const previous = task.status; Object.assign(task, { status: dto.status, notes, updatedBy: user.id }); await em.save(task);
   await em.getRepository(ItAccountActivity).save({ requestId: id, actorId: user.id, event: 'TASK_UPDATED', metadata: { key, previousStatus: previous, newStatus: dto.status } });
   const tasks = await em.getRepository(ItAccountTask).findBy({ requestId: id });
   if (tasks.every(done)) await this.finish(em, user, request);
   request.version += 1; await em.save(request);
   return this.view(em, id);
  });
 }

 private async locked(em: EntityManager, id: string, version: number) {
  const request = await em.getRepository(ItAccountRequest).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  if (!request) throw new NotFoundException();
  if (request.completedAt) throw new ConflictException('This request is finished and cannot be changed.');
  if (request.cancelledAt) throw new ConflictException('This request was cancelled.');
  if (request.version !== version) throw new ConflictException('This request changed. Reload before saving.');
  return request;
 }

 /**
  * The last task done: a closed account becomes Closed; a move's old accounts become an account at the MC they left (Closed,
  * or Kept for load boards for an email a seat still uses) and the new ones their main accounts. Whoever asked is told.
  */
 private async finish(em: EntityManager, user: User, request: ItAccountRequest) {
  request.completedAt = new Date();
  if (request.kind === 'CLOSE') {
   const account = await em.getRepository(CompanyAccount).findOne({ where: { id: request.accountId! }, lock: { mode: 'pessimistic_write' } });
   if (account && account.status !== 'CLOSED') {
    Object.assign(account, { status: 'CLOSED', closedAt: new Date(), closedBy: user.id, version: account.version + 1 }); await em.save(account);
    await em.getRepository(DispatchEvent).save({ memberId: request.memberId, teamId: null, event: 'COMPANY_ACCOUNT_CHANGED', actorId: user.id, metadata: { fields: [], status: 'CLOSED', byIt: true } });
   }
  } else await this.moveAccounts(em, user, request);
  await refreshRemovalAccounts(em, request.memberId, user.id);
  await em.getRepository(PortalNotification).save({ recipientId: request.managerId, requestId: null, removalId: null, leaveRequestId: null, accountRequestId: request.id, kind: 'IT_ACCOUNT_COMPLETED' });
  await em.getRepository(ItAccountActivity).save({ requestId: request.id, actorId: user.id, event: 'IT_ACCOUNT_COMPLETED', metadata: {} });
 }
 private async moveAccounts(em: EntityManager, user: User, request: ItAccountRequest) {
  const member = await em.getRepository(DispatchMember).findOne({ where: { id: request.memberId }, lock: { mode: 'pessimistic_write' } });
  if (!member) return;
  const main = await mainAccounts(em, member.id), keptEmail = request.profile.keep[0]?.value ?? null;
  const from = request.profile.fromMcId ? { id: request.profile.fromMcId } : null;
  // Their old accounts stay on record at the MC they left.
  if (main.companyEmail || main.ringCentralNumber) {
   const status = keptEmail && keptEmail === main.companyEmail ? 'KEPT_FOR_LOAD_BOARDS' : 'CLOSED';
   await em.getRepository(CompanyAccount).save({ memberId: member.id, mcId: from?.id ?? null, companyName: from ? null : request.profile.fromMc ?? 'Earlier company', nameUsed: null,
    companyEmail: main.companyEmail, ringCentralNumber: main.ringCentralNumber, ringCentralExtension: main.ringCentralExtension, status, closedAt: status === 'CLOSED' ? new Date() : null, closedBy: status === 'CLOSED' ? user.id : null, createdBy: user.id, sourceName: null });
   await em.getRepository(DispatchEvent).save({ memberId: member.id, teamId: null, event: 'COMPANY_ACCOUNT_ADDED', actorId: user.id, metadata: { status, fields: [], from: 'move' } });
  }
  // The new ones become their main accounts, where their main accounts are kept: IT's newest setup, else the manager's record.
  const values = { companyEmail: request.newCompanyEmail, ringCentralNumber: request.newRingCentralNumber, ringCentralExtension: request.newRingCentralExtension };
  if (main.setup) {
   const setup = await em.getRepository(ItOnboardingRequest).findOne({ where: { id: main.setup.id }, lock: { mode: 'pessimistic_write' } });
   if (setup) { Object.assign(setup, { companyEmail: values.companyEmail, assignedRingCentralPhoneNumber: values.ringCentralNumber, ringCentralExtension: values.ringCentralExtension, version: setup.version + 1 }); await em.save(setup);
    await em.getRepository(ItOnboardingActivity).save({ requestId: setup.id, actorId: user.id, event: 'ACCOUNTS_MOVED', metadata: { accountRequest: request.id } }); }
  } else if (main.record) { Object.assign(main.record, values); await em.save(main.record); }
  // Nowhere to keep main accounts (no setup with accounts and no record): they're kept as their account at the new MC.
  else if (values.companyEmail || values.ringCentralNumber) {
   const to = request.profile.toMcId ? { id: request.profile.toMcId } : null;
   await em.getRepository(CompanyAccount).save({ memberId: member.id, mcId: to?.id ?? null, companyName: to ? null : request.profile.toMc ?? 'New company', nameUsed: null, ...values, status: 'ACTIVE', createdBy: user.id, sourceName: null });
  }
  member.version += 1; await em.save(member);
 }
 /** Open requests of someone, for their page. */
 open(memberId: string) {
  return this.db.getRepository(ItAccountRequest).find({ where: { memberId, completedAt: IsNull(), cancelledAt: IsNull() }, select: ['id', 'kind', 'accountId', 'createdAt'] });
 }
}
