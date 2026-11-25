import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, QueryFailedError } from 'typeorm';
import type { User } from '../users/user.entity';
import { JobTitle, Mc } from '../lists/lists.entity';
import { addDays, usDay } from '../safety/screening-rules';
import { NotificationsService } from '../updates/notifications.service';
import { lockSetupRequests, sameSetups } from '../it/removal';
import { createReturnSetup } from '../it/support-setup';
import { EmailDone, handedOver, ItOnboardingActivity, ItOnboardingRequest, ItOnboardingTask, ItRemovalActivity, ItRemovalRequest, ItRemovalTask, RemovalProfile } from '../it/it.entity';
import { DispatchEvent, DispatchEventType, DispatchMember, ExistingMemberRecord, MemberAssignment, MemberSupportLink, Team } from './dispatch.entity';
import { lockCatchUpLinks, lockTeam, onLeave, onNotice, supportedDispatcher, supportedTeam } from './create-member';
import { accountOwners } from './shared-accounts';
import { syncSignIns } from './lead-sign-in';
import { RehireDto, UndoLeavingDto } from './dispatch.dto';

/** Undo leaving is offered until this many days after the last day (US Eastern); Rehire any time. */
export const UNDO_DAYS = 30;
/** Google restores a deleted user for this many days; after that IT creates a new email instead. */
export const DELETED_EMAIL_DAYS = 20;
const REHIRE_MAX_DAYS = 90, STALE = 'Someone else changed this record. Reload and try again.';
const ON_RECORD = 'The record and its history stay as they are.';
/** A period or link that ended with the leaving: finishLeaving ends them at leftAt, or a moment after (same-day rule). History uses it too. */
export const WITH_LEAVING_MS = 36 * 3600_000;
// Setups the leaving cancelled were cancelled in the transaction that created the removal.
const WITH_REMOVAL_MS = 60_000;
// What IT did on the removal, task by task, and the setup tasks that bring each back.
const RESTORE_FOR: Record<string, string[]> = { GOOGLE_WORKSPACE: ['GOOGLE_WORKSPACE'], DISPATCH_GROUP: ['DISPATCH_GROUP'], RINGCENTRAL: ['RINGCENTRAL', 'SMS', 'CALL_RECORDING'], BUSINESS_SOFTWARE: ['BUSINESS_SOFTWARE'], EQUIPMENT: ['EQUIPMENT'] };
const day = (at: Date) => at.toISOString().slice(0, 10);
const easternDay = (at: Date) => usDay('latest', at);

interface Accounts {
 email: { value: string; was: EmailDone | null; deletedOn: string | null; restorableUntil: string | null; restorable: boolean; why: string | null } | null;
 ringCentral: { number: string; extension: string | null; restorable: boolean; why: string | null } | null;
}

/**
 * Bringing back someone who left (section 41, approved 2026-11-24). Undo leaving, within 30 days of the last day, puts the
 * record back as if they never left: their MC and team (or who they helped) carry on, IT's removal is cancelled or, when
 * finished, turned into a restore checklist. Rehire brings them back on the same record later, from a first day back, with
 * an IT setup that restores their old accounts where it can. Nobody is messaged; both keep a member_returns row and an event.
 */
@Injectable()
export class BringBackService {
 constructor(private readonly db: DataSource, private readonly alerts: NotificationsService) {}

 /** What the Undo leaving and Rehire dialogs show: whether each is possible, what comes back and what doesn't, and their old accounts. */
 async options(id: string) {
  const member = await this.db.getRepository(DispatchMember).findOneBy({ id });
  if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
  if (member.status !== 'LEFT' || !member.leftAt) throw new ConflictException('They haven’t left. Reload the page.');
  // Read without locks: the undo and rehire read everything again under their own.
  return this.describe(this.db.manager, member);
 }
 private async describe(em: EntityManager, member: DispatchMember) {
  const id = member.id, state = await this.state(em, member);
  const [comesBack, notBack, accounts] = await Promise.all([this.comesBack(em, member), this.notBack(em, member), this.accounts(em, member, state.removal)]);
  const plan = await this.undoPlan(em, member, state.removal, accounts);
  const [previous]: { mcId: string | null; teamId: string | null }[] = await em.query(`SELECT "mcId", "teamId" FROM member_assignments WHERE "memberId" = $1 ORDER BY "startedAt" DESC, "createdAt" DESC LIMIT 1`, [id]);
  const [link]: { dispatcherId: string | null; teamId: string | null }[] = await em.query(`SELECT "dispatcherId", "teamId" FROM member_support_links WHERE "supportId" = $1 ORDER BY "startedAt" DESC, "createdAt" DESC LIMIT 1`, [id]);
  // What the undo will do, worked out as the undo works it out: the status they come back to and the steps IT restores.
  return { undo: { allowed: !state.undoRefusal, why: state.undoRefusal, until: state.undoUntil, comesBack, notBack, status: plan.status, restore: plan.restore?.keys ?? [] },
   rehire: { allowed: !state.rehireRefusal, why: state.rehireRefusal, earliest: usDay('latest'), latest: addDays(usDay('latest'), REHIRE_MAX_DAYS),
    previous: { position: member.position === 'DISPATCHER' ? 'DISPATCHER' : member.supportType, mcId: previous?.mcId ?? null, teamId: previous?.teamId ?? null, jobTitleId: member.jobTitleId,
     supportsMemberId: link?.dispatcherId ?? null, supportsTeamId: link?.teamId ?? null } },
   removal: state.removal ? { open: !state.removal.completedAt, completedAt: state.removal.completedAt } : null, ...accounts };
 }

 /** Undo leaving (UndoLeavingScreen). The member's setups and catch-up links are locked before the member, as leaving takes them. */
 async undo(user: User, id: string, dto: UndoLeavingDto) {
  let alerts: string[] = [];
  const result = await this.write(async em => {
   const setups = await lockSetupRequests(em, id);
   await lockCatchUpLinks(em, id);
   const member = await this.lockLeft(em, id, dto.version);
   await sameSetups(em, id, setups);
   const state = await this.state(em, member, true);
   if (state.undoRefusal) throw new ConflictException(state.undoRefusal);
   const leftAt = member.leftAt!, removal = state.removal;
   const accounts = await this.accounts(em, member, removal);
   // Their place carries on: the period (or a support's link) that ended with the leaving opens again, when it still can.
   const period = await this.endedPeriod(em, member);
   const periodBack = !!period && await this.periodCanCarryOn(em, period);
   if (period && periodBack) { period.endedAt = null; await em.save(period); }
   const link = await this.endedLink(em, member);
   const linkBack = !!link && await this.linkCanCarryOn(em, link);
   if (link && linkBack) { link.endedAt = null; await em.save(link); }
   const plan = await this.undoPlan(em, member, removal, accounts), restore = plan.restore;
   // IT's removal: an open one is cancelled and what IT already did comes back; a finished one is reversed in full.
   if (removal) {
    removal.cancelledAt = new Date(); if (removal.completedAt) removal.reversedAt = removal.cancelledAt; removal.version += 1; await em.save(removal);
    await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId: user.id, event: removal.completedAt ? 'REMOVAL_REVERSED' : 'REMOVAL_CANCELLED', metadata: { leavingUndone: true } });
   }
   // Every setup the leaving cancelled before it finished carries on.
   if (plan.revived.length) await em.query(`UPDATE it_onboarding_requests SET "cancelledAt" = NULL, version = version + 1, "updatedAt" = now() WHERE id = ANY($1)`, [plan.revived.map(row => row.id)]);
   const setupBack = plan.revived.length > 0;
   member.status = plan.status; member.leftAt = null; member.leftReason = null; member.version += 1; await em.save(member);
   // A return checklist that carries on takes the restore tasks itself: there is one open return checklist per person.
   const openReturn = plan.revived.find(row => row.purpose === 'REHIRE' || row.purpose === 'RESTORE') ?? null;
   let setup: { id: string } | null = null;
   if (restore?.keys.length && openReturn) setup = await this.addRestoreTasks(em, openReturn.id, restore, user.id);
   else if (restore?.keys.length) {
    const created = await createReturnSetup(em, { purpose: 'RESTORE', member, keys: restore.keys, restoreKeys: restore.restoreKeys, managerId: user.id, actorId: user.id, accounts: restore.accounts,
     returning: { kind: 'UNDO', leftOn: day(leftAt), firstDay: null, emailWas: accounts.email?.was ?? null, emailDeletedOn: accounts.email?.deletedOn ?? null, by: `${user.firstName} ${user.lastName}` } });
    alerts = await this.alerts.queueItSetupWaiting(em, created);
    setup = created;
   }
   await em.query(`INSERT INTO member_returns ("memberId", kind, "leftAt", "leftReason", "previousJoinedAt", reason, "removalId", "setupRequestId", "actorId") VALUES ($1, 'UNDO', $2, $3, $4, $5, $6, $7, $8)`,
    [id, leftAt, state.leftReason, member.joinedAt, dto.reason, removal?.id ?? null, setup?.id ?? null, user.id]);
   await this.event(em, user, 'LEAVING_UNDONE', id, { periodBack, linkBack, itRestore: !!setup, removalCancelled: !!removal && !removal.reversedAt, setupBack });
   // A team lead's sign-in is asked for again only when they lead a team again, which a manager chooses.
   await syncSignIns(em, [id], user.id);
   return { id, version: member.version };
  });
  this.alerts.dispatch(alerts);
  return result;
 }

 /** Rehire (RehireScreen): back on the same record from their first day back, placed again, with IT asked to restore or create their accounts. */
 async rehire(user: User, id: string, dto: RehireDto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dto.firstDay.slice(0, 10))) throw new BadRequestException('Choose a valid first day back.');
  const firstDay = dto.firstDay.slice(0, 10), today = usDay('latest');
  if (firstDay < today) throw new BadRequestException('Their first day back can’t be in the past.');
  if (firstDay > addDays(today, REHIRE_MAX_DAYS)) throw new BadRequestException(`Their first day back can be up to ${REHIRE_MAX_DAYS} days ahead.`);
  const dispatcher = dto.position === 'DISPATCHER';
  if (dispatcher && (!dto.mcId || !dto.jobTitleId)) throw new BadRequestException('Choose their MC and job title.');
  if (!dispatcher && !!dto.supportsMemberId === !!dto.supportsTeamId) throw new BadRequestException('Choose the dispatcher or team they help.');
  let alerts: string[] = [];
  const result = await this.write(async em => {
   const setups = await lockSetupRequests(em, id);
   await lockCatchUpLinks(em, id);
   const member = await this.lockLeft(em, id, dto.version);
   await sameSetups(em, id, setups);
   const state = await this.state(em, member, true);
   if (state.rehireRefusal) throw new ConflictException(state.rehireRefusal);
   const leftAt = member.leftAt!, startedAt = new Date(`${firstDay}T12:00:00Z`);
   if (startedAt.getTime() <= leftAt.getTime()) throw new BadRequestException('Their first day back must be after the day they left.');
   const accounts = await this.accounts(em, member, state.removal);
   if (dto.email === 'RESTORE' && !accounts.email?.restorable) throw new BadRequestException(accounts.email?.why ?? 'There’s no company email of theirs to restore. Choose a new email or none.');
   if (dto.ringCentral === 'RESTORE' && !accounts.ringCentral?.restorable) throw new BadRequestException(accounts.ringCentral?.why ?? 'There’s no RingCentral user of theirs to enable. Choose a new number or none.');
   // Placed again: a dispatcher under an MC (and a team of it, or Independent) with a job title; a support or updater with who they help.
   if (dispatcher) {
    // FOR SHARE, as periodCanCarryOn reads it, so the MC can't be archived before this commits.
    const mc = await em.getRepository(Mc).findOne({ where: { id: dto.mcId! }, lock: { mode: 'pessimistic_read' } });
    if (!mc || mc.archivedAt) throw new BadRequestException('Choose an active MC.');
    const title = await em.getRepository(JobTitle).findOneBy({ id: dto.jobTitleId! });
    if (!title || title.archivedAt) throw new BadRequestException('Choose an active job title.');
    if (dto.teamId) { const team = await lockTeam(em, dto.teamId); if (!team || team.archivedAt || team.mcId !== mc.id) throw new BadRequestException('Choose an active team of that MC, or Independent.'); }
    await em.getRepository(MemberAssignment).save({ memberId: id, mcId: mc.id, teamId: dto.teamId ?? null, startedAt, reason: 'Rehired.', actorId: user.id });
   } else {
    if (dto.supportsMemberId) { if (dto.supportsMemberId === id) throw new BadRequestException('Choose someone else for them to help.'); await supportedDispatcher(em, dto.supportsMemberId); } else await supportedTeam(em, dto.supportsTeamId!);
    await em.getRepository(MemberSupportLink).save({ supportId: id, dispatcherId: dto.supportsMemberId ?? null, teamId: dto.supportsTeamId ?? null, startedAt, reason: 'Rehired.', actorId: user.id });
   }
   const removal = state.removal, removed = removal ? (await em.getRepository(ItRemovalTask).findBy({ requestId: removal.id, status: 'COMPLETED' })).map(task => task.key) : [];
   // IT: the accounts chosen, the Dispatch group for a dispatcher, and the ticks. What IT removed before comes back rather than new.
   const keys = [...(dto.email !== 'NONE' ? ['GOOGLE_WORKSPACE'] : []), ...(dispatcher ? ['DISPATCH_GROUP'] : []), ...(dto.ringCentral !== 'NONE' ? RESTORE_FOR.RINGCENTRAL : []),
    ...(dto.businessSoftware ? ['BUSINESS_SOFTWARE'] : []), ...(dto.equipment ? ['EQUIPMENT'] : [])];
   // Only tasks on the checklist can restore anything, so the event and IT's activity never claim a restore that isn't asked for.
   const restoreKeys = [...(dto.email === 'RESTORE' ? ['GOOGLE_WORKSPACE'] : []), ...(dto.ringCentral === 'RESTORE' ? RESTORE_FOR.RINGCENTRAL : []), ...['DISPATCH_GROUP', 'BUSINESS_SOFTWARE'].filter(key => removed.includes(key))]
    .filter(key => keys.includes(key));
   const previousJoinedAt = member.joinedAt, record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId: id });
   const position = dto.position === 'DISPATCHER' ? 'DISPATCHER' as const : 'SUPPORT' as const;
   Object.assign(member, { position, supportType: dto.position === 'UPDATER' ? 'UPDATER' : 'SUPPORT', jobTitleId: dispatcher ? dto.jobTitleId : null, joinedAt: startedAt, leftAt: null, leftReason: null,
    status: keys.length || firstDay > today ? 'ONBOARDING' : 'ACTIVE', version: member.version + 1 });
   await em.save(member);
   // Their first day back is known; the earlier stay keeps whether its dates were, on the return row.
   if (record) { await em.update(ExistingMemberRecord, { memberId: id }, { startDateKnown: true, leftDateKnown: true }); }
   if (removal) {
    removal.cancelledAt = new Date(); removal.reversedAt = removal.cancelledAt; removal.version += 1; await em.save(removal);
    await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId: user.id, event: 'REMOVAL_REVERSED', metadata: { rehired: true } });
   }
   // An old email or number they don't get back stops being theirs, on every earlier setup and the manager's record (kept as retired).
   await this.retireOldAccounts(em, id, setups.map(row => row.id), { email: dto.email !== 'RESTORE', number: dto.ringCentral !== 'RESTORE' });
   const setup = keys.length ? await createReturnSetup(em, { purpose: 'REHIRE', member, keys, restoreKeys, managerId: user.id, actorId: user.id,
    accounts: { companyEmail: dto.email === 'RESTORE' ? accounts.email!.value : null, ringCentralNumber: dto.ringCentral === 'RESTORE' ? accounts.ringCentral!.number : null, ringCentralExtension: dto.ringCentral === 'RESTORE' ? accounts.ringCentral!.extension : null },
    returning: { kind: 'REHIRE', leftOn: state.leftKnown ? day(leftAt) : null, firstDay, emailWas: accounts.email?.was ?? null, emailDeletedOn: accounts.email?.deletedOn ?? null, by: `${user.firstName} ${user.lastName}` } }) : null;
   if (setup) alerts = await this.alerts.queueItSetupWaiting(em, setup);
   await em.query(`INSERT INTO member_returns ("memberId", kind, "leftAt", "leftKnown", "leftReason", "previousJoinedAt", "previousStartKnown", "firstDay", "removalId", "setupRequestId", "actorId") VALUES ($1, 'REHIRE', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, leftAt, state.leftKnown, state.leftReason, previousJoinedAt, record?.startDateKnown !== false, firstDay, removal?.id ?? null, setup?.id ?? null, user.id]);
   await this.event(em, user, 'REHIRED', id, { position: dto.position, itSetup: !!setup, restored: restoreKeys.length > 0, assists: dispatcher ? null : dto.supportsTeamId ? 'TEAM' : 'DISPATCHER' });
   await syncSignIns(em, [id], user.id);
   return { id, version: member.version };
  });
  this.alerts.dispatch(alerts);
  return result;
 }

 /**
  * With the last-day job: someone rehired is Onboarding until their first day back (US Eastern) and, when IT was asked for
  * something, until IT finishes too; then Active. IT finishing on or after the first day makes them Active there.
  */
 async sweep() {
  // An UPDATE answers [rows, count].
  const [rows]: [{ id: string }[], number] = await this.db.query(`UPDATE dispatch_members d SET status = 'ACTIVE', version = version + 1, "updatedAt" = now()
   FROM (SELECT DISTINCT ON ("memberId") "memberId", kind, "firstDay" FROM member_returns ORDER BY "memberId", "createdAt" DESC) r
   WHERE r."memberId" = d.id AND r.kind = 'REHIRE' AND r."firstDay" <= $1::date AND d.status = 'ONBOARDING'
    AND NOT EXISTS (SELECT 1 FROM it_onboarding_requests x WHERE x."memberId" = d.id AND x."completedAt" IS NULL AND x."cancelledAt" IS NULL) RETURNING d.id`, [usDay('latest')]);
  return rows.length;
 }

 /** For the dispatcher page of someone who left: whether Undo leaving (and until when) and Rehire are offered. */
 async summary(member: DispatchMember) {
  const state = await this.state(this.db.manager, member);
  return { undoUntil: state.undoUntil, canUndo: !state.undoRefusal, canRehire: !state.rehireRefusal, rehireWhy: state.rehireRefusal };
 }
 /**
  * A rehire that doesn't restore their old company email or RingCentral number (a new one, or none): the old value moves to the
  * retired columns of their earlier setups (locked by the caller) and of the manager's record, so nothing reads it as theirs any
  * more: the page, a team lead sign-in, who owns an email or number, and their next removal. Nothing is deleted.
  */
 private async retireOldAccounts(em: EntityManager, memberId: string, setupIds: string[], retire: { email: boolean; number: boolean }) {
  if (!retire.email && !retire.number) return;
  const sets = [...(retire.email ? [`"retiredCompanyEmail" = coalesce("companyEmail", "retiredCompanyEmail"), "companyEmail" = NULL`] : []),
   ...(retire.number ? [`"retiredRingCentralNumber" = coalesce("assignedRingCentralPhoneNumber", "retiredRingCentralNumber"), "retiredRingCentralExtension" = coalesce("ringCentralExtension", "retiredRingCentralExtension"), "assignedRingCentralPhoneNumber" = NULL, "ringCentralExtension" = NULL`] : [])];
  const held = [...(retire.email ? [`"companyEmail" IS NOT NULL`] : []), ...(retire.number ? [`"assignedRingCentralPhoneNumber" IS NOT NULL`] : [])].join(' OR ');
  if (setupIds.length) await em.query(`UPDATE it_onboarding_requests SET ${sets.join(', ')}, "accountsRetiredAt" = now(), version = version + 1, "updatedAt" = now() WHERE id = ANY($1) AND (${held})`, [setupIds]);
  const recorded = [...(retire.email ? [`"retiredCompanyEmail" = coalesce("companyEmail", "retiredCompanyEmail"), "companyEmail" = NULL`] : []),
   ...(retire.number ? [`"retiredRingCentralNumber" = coalesce("ringCentralNumber", "retiredRingCentralNumber"), "retiredRingCentralExtension" = coalesce("ringCentralExtension", "retiredRingCentralExtension"), "ringCentralNumber" = NULL, "ringCentralExtension" = NULL`] : [])];
  const recordHeld = [...(retire.email ? [`"companyEmail" IS NOT NULL`] : []), ...(retire.number ? [`"ringCentralNumber" IS NOT NULL`] : [])].join(' OR ');
  await em.query(`UPDATE existing_member_records SET ${recorded.join(', ')}, "accountsRetiredAt" = now() WHERE "memberId" = $1 AND (${recordHeld})`, [memberId]);
 }
 /** Why each is or isn't possible now, read again inside the transaction (removal locked) before either changes anything. */
 private async state(em: EntityManager, member: DispatchMember, lock = false) {
  const id = member.id, leftDay = day(member.leftAt!), undoUntil = addDays(leftDay, UNDO_DAYS);
  const [facts]: { markedHere: boolean; later: boolean; leftKnown: boolean }[] = await em.query(`SELECT
    EXISTS (SELECT 1 FROM dispatch_events e WHERE e."memberId" = $1 AND e.event = 'MEMBER_LEFT') AS "markedHere",
    EXISTS (SELECT 1 FROM dispatch_members l WHERE l."previousMemberId" = $1) AS later,
    coalesce((SELECT r."leftDateKnown" FROM existing_member_records r WHERE r."memberId" = $1), true) AS "leftKnown"`, [id]);
  const removal = await em.getRepository(ItRemovalRequest).findOne({ where: { memberId: id, cancelledAt: IsNull() }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  // The last leaving was marked here (MEMBER_LEFT is written only when leaving here) and nobody came back since. Someone added
  // from a file as Left has no MEMBER_LEFT until they're rehired and leave again here, and that leaving can be undone.
  const marked = facts.markedHere && !(await em.query(`SELECT 1 FROM member_returns WHERE "memberId" = $1 AND "createdAt" > (SELECT max("createdAt") FROM dispatch_events WHERE "memberId" = $1 AND event = 'MEMBER_LEFT')`, [id])).length;
  const later = 'They came back as a newer record. Bring them back from that record instead.';
  const undoRefusal = facts.later ? later : !marked ? 'Only a leaving recorded here can be undone. Rehire brings them back.'
   : usDay('latest') > undoUntil ? `Undo leaving was possible until ${undoUntil}. Rehire brings them back.` : null;
  const rehireRefusal = facts.later ? later : removal && !removal.completedAt ? 'IT is still removing their access. Undo leaving instead, or rehire once IT finishes.' : null;
  return { removal, undoUntil: marked ? undoUntil : null, undoRefusal, rehireRefusal, leftKnown: facts.leftKnown, leftReason: member.leftReason };
 }

 /** Their company email and RingCentral user as IT left them, and whether each can come back as it was. */
 private async accounts(em: EntityManager, member: DispatchMember, removal: ItRemovalRequest | null): Promise<Accounts> {
  if (!removal) return { email: null, ringCentral: null };
  const profile = removal.profile, tasks = await em.getRepository(ItRemovalTask).findBy({ requestId: removal.id });
  const task = (key: string) => tasks.find(item => item.key === key);
  const taken = async (kind: 'EMAIL' | 'RINGCENTRAL', value: string) => (await accountOwners(em, kind, value, member.id)).map(owner => owner.name);
  let email: Accounts['email'] = null, ringCentral: Accounts['ringCentral'] = null;
  if (profile.companyEmail && !handedOver(profile, 'EMAIL')) {
   const google = task('GOOGLE_WORKSPACE'), done = google?.status === 'COMPLETED' ? removal.emailDone ?? 'SUSPENDED' : null;
   // Deleted when IT first recorded Deleted, which can be before the task was completed; the task's own time only when no record says.
   const [recorded]: { at: Date }[] = done === 'DELETED' ? await em.query(`SELECT min("createdAt") AS at FROM it_removal_activity WHERE "requestId" = $1 AND metadata->>'key' = 'GOOGLE_WORKSPACE' AND metadata->>'emailDone' = 'DELETED'`, [removal.id]) : [];
   const deletedOn = done === 'DELETED' ? easternDay(recorded?.at ?? google!.updatedAt) : null, restorableUntil = deletedOn ? addDays(deletedOn, DELETED_EMAIL_DAYS) : null;
   const owners = await taken('EMAIL', profile.companyEmail);
   const why = owners.length ? `${profile.companyEmail} is someone else’s now (${owners.join(', ')}).` : restorableUntil && usDay('latest') > restorableUntil ? `${profile.companyEmail} was deleted on ${deletedOn}, so IT can no longer restore it.` : null;
   email = { value: profile.companyEmail, was: done, deletedOn, restorableUntil, restorable: !why, why };
  }
  if (profile.ringCentralNumber && !handedOver(profile, 'RINGCENTRAL')) {
   const owners = await taken('RINGCENTRAL', profile.ringCentralNumber);
   const why = owners.length ? `${profile.ringCentralNumber} is someone else’s now (${owners.join(', ')}).` : null;
   ringCentral = { number: profile.ringCentralNumber, extension: profile.ringCentralExtension ?? null, restorable: !why, why };
  }
  return { email, ringCentral };
 }

 /** The restore checklist for an undone leaving: each step IT did (or started) comes back; an old email or number IT can't restore is made new. */
 private restorePlan(profile: RemovalProfile, done: string[], accounts: Accounts) {
  const keys = [...new Set(done.flatMap(key => RESTORE_FOR[key] ?? []))].filter(key => (key !== 'GOOGLE_WORKSPACE' || !!accounts.email) && (!RESTORE_FOR.RINGCENTRAL.includes(key) || !!accounts.ringCentral));
  const emailBack = !!accounts.email?.restorable, numberBack = !!accounts.ringCentral?.restorable;
  const restoreKeys = keys.filter(key => key === 'GOOGLE_WORKSPACE' ? emailBack : RESTORE_FOR.RINGCENTRAL.includes(key) ? numberBack : true);
  return { keys, restoreKeys, accounts: { companyEmail: emailBack && keys.includes('GOOGLE_WORKSPACE') ? accounts.email!.value : null,
   ringCentralNumber: numberBack && keys.includes('RINGCENTRAL') ? profile.ringCentralNumber : null, ringCentralExtension: numberBack && keys.includes('RINGCENTRAL') ? profile.ringCentralExtension ?? null : null } };
 }

 /**
  * What an undo does, for the undo and for its dialog: the steps IT restores, the setups the leaving cancelled that carry on
  * (every one cancelled with the removal, not only the one it names) and the status they come back to. Only a new hire's
  * setup or a rehire's makes someone Active when IT finishes, so only those bring them back as Onboarding.
  */
 private async undoPlan(em: EntityManager, member: DispatchMember, removal: ItRemovalRequest | null, accounts: Accounts) {
  if (!removal) return { restore: null, revived: [] as { id: string; purpose: string }[], status: 'ACTIVE' as const };
  const tasks = await em.getRepository(ItRemovalTask).findBy({ requestId: removal.id });
  // Not needed means IT had nothing to remove there, so nothing comes back.
  const restoreFrom = tasks.filter(task => removal.completedAt ? task.status === 'COMPLETED' : task.status !== 'NOT_NEEDED' && (task.status !== 'PENDING' || !!task.notes.trim())).map(task => task.key);
  const revived: { id: string; purpose: string }[] = await em.query(`SELECT r.id, r.purpose FROM it_onboarding_requests r
   WHERE (r."memberId" = $1 OR r."applicationId" = $2) AND r."completedAt" IS NULL AND r."cancelledAt" IS NOT NULL AND abs(extract(epoch FROM r."cancelledAt" - $3::timestamptz)) * 1000 <= $4`,
   [member.id, member.applicationId, removal.createdAt, WITH_REMOVAL_MS]);
  const status = revived.some(row => row.purpose === 'DISPATCHER' || row.purpose === 'REHIRE') ? 'ONBOARDING' as const : 'ACTIVE' as const;
  return { restore: this.restorePlan(removal.profile, restoreFrom, accounts), revived, status };
 }

 /** Adds an undo's restore tasks to the return checklist that carries on: tasks it lacks, what they restore, and the old accounts IT confirms. */
 private async addRestoreTasks(em: EntityManager, requestId: string, restore: ReturnType<BringBackService['restorePlan']>, actorId: string) {
  const request = await em.getRepository(ItOnboardingRequest).findOneByOrFail({ id: requestId });
  const have = new Set((await em.getRepository(ItOnboardingTask).findBy({ requestId })).map(task => task.key));
  const added = restore.keys.filter(key => !have.has(key));
  if (added.length) await em.getRepository(ItOnboardingTask).save(added.map(key => ({ requestId, key, status: 'PENDING' as const, notes: '' })));
  request.restoreKeys = [...new Set([...request.restoreKeys, ...restore.restoreKeys])];
  request.companyEmail ??= restore.accounts.companyEmail;
  request.assignedRingCentralPhoneNumber ??= restore.accounts.ringCentralNumber;
  request.ringCentralExtension ??= restore.accounts.ringCentralExtension;
  request.version += 1; await em.save(request);
  await em.getRepository(ItOnboardingActivity).save({ requestId, actorId, event: 'IT_REQUEST_CREATED', metadata: { returning: 'UNDO', restore: restore.restoreKeys.length > 0, added: added.join(',') } });
  return request;
 }

 /** What comes back with an undo: where they worked (when it still exists), their job title, and who a support helped. */
 private async comesBack(em: EntityManager, member: DispatchMember) {
  const period = await this.endedPeriod(em, member), link = await this.endedLink(em, member);
  const [place] = period ? await em.query(`SELECT m.name AS mc, t.name AS team FROM mcs m LEFT JOIN teams t ON t.id = $2 WHERE m.id = $1`, [period.mcId, period.teamId]) : [];
  const [helps] = link ? await em.query(`SELECT coalesce(t.name, d."firstName" || ' ' || d."lastName") AS name FROM member_support_links l LEFT JOIN teams t ON t.id = l."teamId" LEFT JOIN dispatch_members d ON d.id = l."dispatcherId" WHERE l.id = $1`, [link.id]) : [];
  const [title]: { name: string }[] = member.jobTitleId ? await em.query(`SELECT name FROM job_titles WHERE id = $1`, [member.jobTitleId]) : [];
  return { place: period ? { mc: place?.mc ?? null, team: place?.team ?? null, carriesOn: await this.periodCanCarryOn(em, period, false) } : null,
   jobTitle: member.position === 'DISPATCHER' ? title?.name ?? null : null, helps: link ? { name: helps?.name ?? null, carriesOn: await this.linkCanCarryOn(em, link, false) } : null };
 }

 /**
  * What doesn't come back by itself, because others took it over when they left (from their notice, or the day they left):
  * drivers and supports who were reassigned, leading a team, load board seats IT ended and sharing of email or number that
  * stopped. Names, accounts and kinds for the dialog; never a sign-in, email or number.
  */
 private async notBack(em: EntityManager, member: DispatchMember) {
  const [notice]: { since: Date }[] = await em.query(`SELECT "createdAt" AS since FROM member_notices WHERE "memberId" = $1 AND "finishedAt" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 1`, [member.id]);
  const since = notice && notice.since.getTime() < member.leftAt!.getTime() ? notice.since : new Date(member.leftAt!.getTime() - WITH_LEAVING_MS);
  const [drivers, supports, teams, seats, sharing] = await Promise.all([
   em.query(`SELECT DISTINCT ON (d.id) d."firstName" || ' ' || d."lastName" AS name, CASE WHEN n.id IS NULL THEN NULL ELSE n."firstName" || ' ' || n."lastName" END AS "now"
    FROM driver_assignments a JOIN drivers d ON d.id = a."driverId" LEFT JOIN driver_assignments o ON o."driverId" = d.id AND o."endedAt" IS NULL LEFT JOIN dispatch_members n ON n.id = o."memberId"
    WHERE a."memberId" = $1 AND a."endedAt" >= $2 ORDER BY d.id`, [member.id, since]),
   em.query(`SELECT DISTINCT ON (s.id) s."firstName" || ' ' || s."lastName" AS name, s."supportType", s.status, coalesce(t.name, n."firstName" || ' ' || n."lastName") AS "now"
    FROM member_support_links l JOIN dispatch_members s ON s.id = l."supportId" LEFT JOIN member_support_links o ON o."supportId" = s.id AND o."endedAt" IS NULL
    LEFT JOIN dispatch_members n ON n.id = o."dispatcherId" LEFT JOIN teams t ON t.id = o."teamId" WHERE l."dispatcherId" = $1 AND l."endedAt" >= $2 ORDER BY s.id`, [member.id, since]),
   em.query(`SELECT DISTINCT t.name FROM dispatch_events e JOIN teams t ON t.id = e."teamId" WHERE e."memberId" = $1 AND e.event = 'TEAM_LEAD_CLEARED' AND e."createdAt" >= $2`, [member.id, since]),
   // Seats IT ended when it finished removing their access (endSeatsOnLeaving).
   em.query(`SELECT DISTINCT a.provider, a.name FROM member_load_board_seats s JOIN load_board_accounts a ON a.id = s."accountId" WHERE s."memberId" = $1 AND s."endedHow" = 'LEFT' AND s."endedAt" >= $2 ORDER BY a.provider, a.name`, [member.id, since]),
   // Colleagues who stopped using their email or number, and what of others' they stopped using (sharingOnLeft).
   em.query(`SELECT s.kind, CASE WHEN s."ownerMemberId" = $1 THEN u."firstName" || ' ' || u."lastName" END AS "user", CASE WHEN s."memberId" = $1 THEN o."firstName" || ' ' || o."lastName" END AS owner
    FROM member_shared_accounts s LEFT JOIN dispatch_members u ON u.id = s."memberId" LEFT JOIN dispatch_members o ON o.id = s."ownerMemberId"
    WHERE ((s."ownerMemberId" = $1 AND s."endedHow" = 'OWNER_LEFT') OR (s."memberId" = $1 AND s."endedHow" = 'LEFT')) AND s."endedAt" >= $2 ORDER BY s.kind`, [member.id, since]),
  ]);
  return { drivers, supports, ledTeams: teams.map((row: { name: string }) => row.name), seats, sharing };
 }

 /** Their last MC and team, when it ended with the leaving. */
 private async endedPeriod(em: EntityManager, member: DispatchMember) {
  const [last] = await em.getRepository(MemberAssignment).find({ where: { memberId: member.id }, order: { startedAt: 'DESC', createdAt: 'DESC' }, take: 1 });
  return last?.endedAt && Math.abs(last.endedAt.getTime() - member.leftAt!.getTime()) <= WITH_LEAVING_MS ? last : null;
 }
 private async endedLink(em: EntityManager, member: DispatchMember) {
  if (member.position !== 'SUPPORT') return null;
  const [last] = await em.getRepository(MemberSupportLink).find({ where: { supportId: member.id }, order: { startedAt: 'DESC', createdAt: 'DESC' }, take: 1 });
  return last?.endedAt && Math.abs(last.endedAt.getTime() - member.leftAt!.getTime()) <= WITH_LEAVING_MS ? last : null;
 }
 /** Their MC (and team, when they had one) still active: the undo reads them FOR SHARE, as placing someone does, so neither is archived meanwhile. */
 private async periodCanCarryOn(em: EntityManager, period: MemberAssignment, lock = true) {
  if (!period.mcId) return false;
  const [mc] = await em.query(`SELECT "archivedAt" FROM mcs WHERE id = $1${lock ? ' FOR SHARE' : ''}`, [period.mcId]);
  if (!mc || mc.archivedAt) return false;
  if (!period.teamId) return true;
  const team = lock ? await lockTeam(em, period.teamId) : await em.getRepository(Team).findOneBy({ id: period.teamId });
  return !!team && !team.archivedAt && team.mcId === period.mcId;
 }
 /** The dispatcher a support helped is still here and can take a support (not leaving or away), or the team they helped is still active. */
 private async linkCanCarryOn(em: EntityManager, link: MemberSupportLink, lock = true) {
  if (link.teamId) { const team = lock ? await lockTeam(em, link.teamId) : await em.getRepository(Team).findOneBy({ id: link.teamId }); return !!team && !team.archivedAt; }
  const dispatcher = await em.getRepository(DispatchMember).findOne({ where: { id: link.dispatcherId! }, ...(lock ? { lock: { mode: 'pessimistic_read' as const } } : {}) });
  return !!dispatcher && dispatcher.position === 'DISPATCHER' && dispatcher.status !== 'LEFT' && !await onNotice(em, dispatcher.id) && !await onLeave(em, dispatcher.id);
 }
 private async lockLeft(em: EntityManager, id: string, version: number) {
  const member = await em.getRepository(DispatchMember).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
  if (member.version !== version) throw new ConflictException(STALE);
  if (member.status !== 'LEFT' || !member.leftAt) throw new ConflictException(`They haven’t left. ${ON_RECORD}`);
  return member;
 }
 private event(em: EntityManager, user: Pick<User, 'id'>, event: DispatchEventType, memberId: string, metadata: Record<string, unknown>) {
  return em.getRepository(DispatchEvent).save({ memberId, teamId: null, event, actorId: user.id, metadata });
 }
 private async write<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
  try { return await this.db.transaction(work); }
  catch (error) {
   if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23505') throw new ConflictException('This record changed at the same time. Reload and try again.');
   throw error;
  }
 }
}

/** Every time someone came back (section 41), newest first, for the dispatcher page: undone leavings and rehires, with who and why. */
export function memberReturns(db: Pick<EntityManager, 'query'>, memberId: string): Promise<{ id: string; kind: 'UNDO' | 'REHIRE'; leftAt: Date; leftKnown: boolean; previousJoinedAt: Date; previousStartKnown: boolean; firstDay: string | null; reason: string | null; createdAt: Date; by: string | null }[]> {
 return db.query(`SELECT r.id, r.kind, r."leftAt", r."leftKnown", r."leftReason", r."previousJoinedAt", r."previousStartKnown", r."firstDay"::text AS "firstDay", r.reason, r."createdAt",
   CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS by
  FROM member_returns r LEFT JOIN users u ON u.id = r."actorId" WHERE r."memberId" = $1 ORDER BY r."createdAt" DESC`, [memberId]);
}
