import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, QueryFailedError } from 'typeorm';
import type { User } from '../users/user.entity';
import { UserStatus } from '../users/user.entity';
import { addDays, usDay } from '../safety/screening-rules';
import { NotificationsService } from '../updates/notifications.service';
import { lockSetupRequests, memberSetups, sameSetups, setupAccounts } from '../it/removal';
import { ItLeaveActivity, ItLeaveRequest, type LeaveProfile } from '../it/it.entity';
import { cancelLeaveRequest, createLeaveRequest, lockSuspend } from '../it/leave';
import { BackOnDto, LeaveDto, LeaveReasonDto, LeaveVersionDto } from './dispatch.dto';
import { DispatchEvent, DispatchMember, ExistingMemberRecord, type LeaveEnd, MemberLeave, positionLabel, Team } from './dispatch.entity';
import { memberPlace, onNotice } from './create-member';
export { onLeave, onLeaveSql } from './create-member';
import { lockAccount, syncSignIns, turnOffAccount } from './lead-sign-in';

const STALE = 'Someone else changed this record. Reload and try again.';
export const LEAVE_START_MAX_DAYS = 30, LEAVE_MAX_DAYS = 183;

/**
 * On leave (section 35, designed and approved 2026-11-11): a dispatcher, support or updater away for a while keeps their job,
 * their MC, team, drivers and supports. Their record stays ACTIVE; the open leave says they're away from its first day.
 * IT suspends the accounts they have and restores them when they're back. A team lead's sign-in turns off on the first day
 * away and IT is asked to turn it back on when they return. Reasons are staff text; events hold flags only.
 */
@Injectable()
export class LeaveService {
 private readonly logger = new Logger('Leave');
 constructor(private readonly db: DataSource, private readonly alerts: NotificationsService) {}

 async put(user: User, id: string, dto: LeaveDto) {
  const today = usDay('latest');
  if (dto.firstDay < today) throw new BadRequestException('The first day away can’t be in the past.');
  if (dto.firstDay > addDays(today, LEAVE_START_MAX_DAYS)) throw new BadRequestException(`The first day away can be up to ${LEAVE_START_MAX_DAYS} days ahead.`);
  if (dto.backOn <= dto.firstDay) throw new BadRequestException('They’re back after their first day away.');
  if (dto.backOn > addDays(dto.firstDay, LEAVE_MAX_DAYS)) throw new BadRequestException('A leave can be up to 6 months.');
  return this.withAlerts(async em => {
   // IT setups before the member row, the order leaving and promotions use: a setup still under way would add an account the
   // suspend checklist doesn't list, so leave waits for it.
   const setups = await lockSetupRequests(em, id);
   const member = await this.lockMember(em, id, dto.version);
   await sameSetups(em, id, setups);
   if (setups.some(setup => !setup.completedAt)) throw new ConflictException('IT is still setting something up for them. Put them on leave once it’s finished.');
   if (member.status !== 'ACTIVE') throw new ConflictException('Only someone who is working now can go on leave. Finish their IT setup first.');
   if (await onNotice(em, id)) throw new ConflictException('This person is leaving. Change their last day instead.');
   if (await this.openLeave(em, id)) throw new ConflictException('They’re already on leave. Change their return date instead.');
   const accounts = await this.accounts(em, member);
   const emailWhileAway = accounts.companyEmail ? dto.emailWhileAway ?? 'FORWARD' : null, callsWhileAway = accounts.ringCentralNumber ? dto.callsWhileAway ?? 'FORWARD' : null;
   // The recorder takes forwarded mail and calls; with nothing forwarded the leave sends them nothing (and hand-over leaves it alone).
   const forwards = emailWhileAway === 'FORWARD' || callsWhileAway === 'FORWARD';
   const leave = await em.getRepository(MemberLeave).save({ memberId: id, firstDay: dto.firstDay, backOn: dto.backOn, reason: dto.reason,
    emailWhileAway, callsWhileAway, forwardTo: forwards ? user.id : null, recordedBy: user.id, changes: [], startedAt: null, endedAt: null, endedHow: null, endedBy: null });
   const alerts = await createLeaveRequest(em, this.alerts, { leaveId: leave.id, memberId: id, kind: 'SUSPEND', keys: accounts.keys, profile: await this.profile(em, member, leave, accounts, user), dueOn: leave.firstDay, managerId: user.id, actorId: user.id });
   if (leave.firstDay <= today) await this.start(em, member, leave, user.id);
   member.version += 1; await em.save(member);
   await this.event(em, user.id, 'LEAVE_RECORDED', id, { itSuspend: accounts.keys.length > 0, startsToday: leave.firstDay <= today });
   return { result: { id, version: member.version }, alerts };
  });
 }

 /** Back today, early or on the day: Active now, and IT restores what it suspended. */
 async recordReturn(user: User, id: string, dto: LeaveVersionDto) {
  return this.withAlerts(async em => {
   const member = await this.lockMember(em, id, dto.version);
   const leave = await this.requireLeave(em, id);
   if (!leave.startedAt) throw new ConflictException('Their leave hasn’t started. Cancel it instead.');
   const alerts = await this.end(em, member, leave, 'RETURNED', user.id);
   member.version += 1; await em.save(member);
   return { result: { id, version: member.version }, alerts };
  });
 }

 /** They're not going after all, or IT hasn't suspended anything yet. The leave stays in their history. */
 async cancel(user: User, id: string, dto: LeaveVersionDto) {
  return this.withAlerts(async em => {
   const member = await this.lockMember(em, id, dto.version);
   const leave = await this.requireLeave(em, id);
   const suspend = await lockSuspend(em, leave.id);
   if (suspend.request?.completedAt || suspend.completed.length) throw new ConflictException('IT has already suspended some of their access. Record their return instead.');
   const alerts = await this.end(em, member, leave, 'CANCELLED', user.id, suspend);
   member.version += 1; await em.save(member);
   return { result: { id, version: member.version }, alerts };
  });
 }

 async changeBackOn(user: User, id: string, dto: BackOnDto) {
  return this.withAlerts(async em => {
   const member = await this.lockMember(em, id, dto.version);
   const leave = await this.requireLeave(em, id);
   const today = usDay('latest');
   if (dto.backOn <= today) throw new BadRequestException('Choose a day after today, or record their return.');
   if (dto.backOn <= leave.firstDay) throw new BadRequestException('They’re back after their first day away.');
   if (dto.backOn > addDays(leave.firstDay, LEAVE_MAX_DAYS)) throw new BadRequestException('A leave can be up to 6 months.');
   if (dto.backOn === leave.backOn) throw new BadRequestException('That is already their return date.');
   leave.changes = [...leave.changes, { kind: 'BACK_ON', from: leave.backOn, to: dto.backOn, reason: dto.reason, by: user.id, byName: `${user.firstName} ${user.lastName}`, at: new Date().toISOString() }];
   leave.backOn = dto.backOn; leave.version += 1; await em.getRepository(MemberLeave).save(leave);
   // IT's restore moves with it.
   const suspend = await lockSuspend(em, leave.id);
   if (suspend.request) {
    suspend.request.profile = { ...suspend.request.profile, backOn: dto.backOn }; suspend.request.version += 1; await em.save(suspend.request);
    await em.getRepository(ItLeaveActivity).save({ requestId: suspend.request.id, actorId: user.id, event: 'BACK_ON_CHANGED', metadata: {} });
   }
   member.version += 1; await em.save(member);
   await this.event(em, user.id, 'LEAVE_CHANGED', id, { fields: ['backOn'] });
   return { result: { id, version: member.version }, alerts: [] };
  });
 }

 async changeReason(user: User, id: string, dto: LeaveReasonDto) {
  return this.withAlerts(async em => {
   const member = await this.lockMember(em, id, dto.version);
   const leave = await this.requireLeave(em, id);
   if (dto.reason === leave.reason) throw new BadRequestException('Nothing changed.');
   leave.changes = [...leave.changes, { kind: 'REASON', from: leave.reason, to: dto.reason, reason: null, by: user.id, byName: `${user.firstName} ${user.lastName}`, at: new Date().toISOString() }];
   leave.reason = dto.reason; leave.version += 1; await em.getRepository(MemberLeave).save(leave);
   member.version += 1; await em.save(member);
   await this.event(em, user.id, 'LEAVE_CHANGED', id, { fields: ['reason'] });
   return { result: { id, version: member.version }, alerts: [] };
  });
 }

 /**
  * Called by leaving (Mark as leaving) in its transaction, after the member row is locked: the leave ends and an unfinished
  * suspend stops; nothing is restored, because IT's removal takes over. Returns whether IT had suspended anything.
  */
 async endForLeaving(em: EntityManager, member: DispatchMember, actorId: string) {
  const leave = await this.openLeave(em, member.id, true);
  if (!leave) return false;
  const suspend = await lockSuspend(em, leave.id);
  await this.end(em, member, leave, 'LEAVING', actorId, suspend);
  return !!suspend.request?.completedAt || suspend.toRestore.length > 0;
 }

 /**
  * Called by cancelling a notice, in its transaction after the member row is locked: a leave that notice ended (LEAVING) restored
  * nothing, because IT's removal was to take over. They're staying after all, so IT restores what it suspended. Returns whether it did, and the alerts.
  */
 async restoreAfterNotice(em: EntityManager, member: DispatchMember, actorId: string) {
  const leave = await em.getRepository(MemberLeave).findOne({ where: { memberId: member.id }, order: { createdAt: 'DESC' }, lock: { mode: 'pessimistic_write' } });
  const none = { restored: false, alerts: [] as string[] };
  if (!leave || leave.endedHow !== 'LEAVING') return none;
  if (await em.getRepository(ItLeaveRequest).existsBy({ leaveId: leave.id, kind: 'RESTORE' })) return none;
  const suspend = await lockSuspend(em, leave.id, true);
  if (!suspend.request || !suspend.toRestore.length) return none;
  const today = usDay('latest');
  return { restored: true, alerts: await createLeaveRequest(em, this.alerts, { leaveId: leave.id, memberId: member.id, kind: 'RESTORE', keys: suspend.toRestore,
   profile: { ...suspend.request.profile, backOn: today }, dueOn: today, managerId: suspend.request.managerId, actorId }) };
 }

 /**
  * The daily part (run with the last-day job): a leave whose first day has come starts (a team lead's sign-in turns off), and
  * one whose return day has come ends, with IT's restore alert. Each person is their own transaction.
  */
 async sweep() {
  const counts = { started: 0, returned: 0, failed: 0 }, today = usDay('latest');
  const due: { memberId: string; starting: boolean }[] = await this.db.query(`SELECT "memberId", "startedAt" IS NULL AND "firstDay" <= $1::date AS starting FROM member_leaves
   WHERE "endedAt" IS NULL AND (("startedAt" IS NULL AND "firstDay" <= $1::date) OR "backOn" <= $1::date)`, [today]);
  for (const { memberId } of due) {
   try {
    const outcome = await this.withAlerts(async em => {
     const member = await em.getRepository(DispatchMember).findOne({ where: { id: memberId }, lock: { mode: 'pessimistic_write' } });
     const leave = member ? await this.openLeave(em, memberId, true) : null;
     if (!member || !leave || member.status === 'LEFT') return { result: null, alerts: [] };
     let alerts: string[] = [], result: 'started' | 'returned' | null = null;
     if (!leave.startedAt && leave.firstDay <= today) { await this.start(em, member, leave, leave.recordedBy); result = 'started'; }
     if (leave.backOn <= today) { alerts = await this.end(em, member, leave, 'RETURNED', null); result = 'returned'; }
     if (result) { member.version += 1; await em.save(member); }
     return { result, alerts };
    });
    if (outcome === 'started') counts.started += 1; else if (outcome === 'returned') counts.returned += 1;
   } catch { counts.failed += 1; }
  }
  if (counts.failed) this.logger.warn(`Leave job: ${counts.failed} failed`);
  return counts;
 }

 // ── Inside the transaction ──
 private async start(em: EntityManager, member: DispatchMember, leave: MemberLeave, actorId: string) {
  leave.startedAt = new Date(); leave.version += 1; await em.getRepository(MemberLeave).save(leave);
  // A team lead can't sign in while away; IT is asked to turn it back on when they return.
  if (member.accountUserId) {
   const account = await lockAccount(em, member.accountUserId);
   if (account && account.status === UserStatus.ACTIVE) await turnOffAccount(em, account, actorId, 'member-on-leave');
  }
  await syncSignIns(em, [member.id], actorId);
 }
 /** Ends the leave; a caller that already locked the suspend checklist passes it, so it isn't locked and read again. */
 private async end(em: EntityManager, member: DispatchMember, leave: MemberLeave, how: LeaveEnd, actorId: string | null, locked?: Awaited<ReturnType<typeof lockSuspend>>) {
  const suspend = locked ?? await lockSuspend(em, leave.id);
  leave.endedAt = new Date(); leave.endedHow = how; leave.endedBy = actorId; leave.version += 1; await em.getRepository(MemberLeave).save(leave);
  let alerts: string[] = [], restoring = false;
  if (suspend.request) {
   // What IT finished or started is what IT restores (a cancelled leave too: forwarding may already be on); an unfinished suspend stops.
   const restore = suspend.toRestore;
   await cancelLeaveRequest(em, suspend.request, actorId, how);
   restoring = how !== 'LEAVING' && restore.length > 0;
   if (restoring) alerts = await createLeaveRequest(em, this.alerts, { leaveId: leave.id, memberId: member.id, kind: 'RESTORE', keys: restore,
    profile: { ...suspend.request.profile, backOn: usDay('latest') }, dueOn: usDay('latest'), managerId: suspend.request.managerId, actorId });
  }
  // Leaving records its own notice and sign-in change; otherwise someone back who still leads a team needs their sign-in again.
  if (how !== 'LEAVING') await syncSignIns(em, [member.id], actorId);
  await this.event(em, actorId, 'LEAVE_ENDED', member.id, { how, itRestore: restoring });
  return alerts;
 }
 /** The accounts IT would suspend: what IT set up, else what a manager recorded, and which tasks that means. */
 private async accounts(em: EntityManager, member: DispatchMember) {
  const setups = await memberSetups(em, member.id), fromSetups = setups.length ? setupAccounts(setups) : null;
  const record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId: member.id });
  const companyEmail = fromSetups?.companyEmail ?? record?.companyEmail ?? null, ringCentralNumber = fromSetups?.ringCentralNumber ?? record?.ringCentralNumber ?? null;
  const datEmail = fromSetups?.datEmail ?? record?.datEmail ?? null, truckstopEmail = fromSetups?.truckstopEmail ?? record?.truckstopEmail ?? null;
  const asked: string[] = setups.length ? (await em.query(`SELECT DISTINCT key FROM it_onboarding_tasks WHERE "requestId" = ANY($1)`, [setups.map(setup => setup.id)])).map((row: { key: string }) => row.key) : [];
  const keys = [...(companyEmail ? ['GOOGLE_WORKSPACE'] : []), ...(ringCentralNumber ? ['RINGCENTRAL'] : []),
   ...(member.position === 'DISPATCHER' || datEmail || truckstopEmail || asked.includes('BUSINESS_SOFTWARE') ? ['BUSINESS_SOFTWARE'] : [])];
  return { companyEmail, ringCentralNumber, datEmail, truckstopEmail, keys };
 }
 private async profile(em: EntityManager, member: DispatchMember, leave: MemberLeave, accounts: Awaited<ReturnType<LeaveService['accounts']>>, recorder: User): Promise<LeaveProfile> {
  const place = await memberPlace(em, member.id);
  return { displayName: `${member.firstName} ${member.lastName}`.trim(), position: positionLabel(member), companyEmail: accounts.companyEmail, ringCentralNumber: accounts.ringCentralNumber,
   mcName: place.mcName, teamName: place.teamName, firstDay: leave.firstDay, backOn: leave.backOn, emailWhileAway: leave.emailWhileAway, callsWhileAway: leave.callsWhileAway,
   forwardToName: leave.forwardTo ? `${recorder.firstName} ${recorder.lastName}` : null, datEmail: accounts.datEmail, truckstopEmail: accounts.truckstopEmail,
   teamLead: await em.getRepository(Team).existsBy({ leadMemberId: member.id, archivedAt: IsNull() }) };
 }
 private openLeave(em: EntityManager, memberId: string, lock = false) {
  return em.getRepository(MemberLeave).findOne({ where: { memberId, endedAt: IsNull() }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
 }
 private async requireLeave(em: EntityManager, memberId: string) {
  const leave = await this.openLeave(em, memberId, true);
  if (!leave) throw new ConflictException('They aren’t on leave any more. Reload the page.');
  return leave;
 }
 private async lockMember(em: EntityManager, id: string, version: number) {
  const member = await em.getRepository(DispatchMember).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
  if (member.version !== version) throw new ConflictException(STALE);
  if (member.status === 'LEFT') throw new ConflictException('This person has left; their record is kept for history.');
  return member;
 }
 private event(em: EntityManager, actorId: string | null, event: 'LEAVE_RECORDED' | 'LEAVE_CHANGED' | 'LEAVE_ENDED', memberId: string, metadata: Record<string, unknown>) {
  return em.getRepository(DispatchEvent).save({ memberId, teamId: null, event, actorId, metadata });
 }
 /** One transaction; its Telegram alerts go out after it commits. */
 private async withAlerts<T>(work: (em: EntityManager) => Promise<{ result: T; alerts: string[] }>): Promise<T> {
  let alerts: string[] = [];
  try {
   const result = await this.db.transaction(async em => { const outcome = await work(em); alerts = outcome.alerts; return outcome.result; });
   this.alerts.dispatch(alerts);
   return result;
  } catch (error) {
   if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23505') throw new ConflictException(STALE);
   throw error;
  }
 }
}

