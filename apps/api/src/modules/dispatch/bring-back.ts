import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, QueryFailedError } from 'typeorm';
import type { User } from '../users/user.entity';
import { JobTitle, Mc } from '../lists/lists.entity';
import { addDays, usDay } from '../safety/screening-rules';
import { NotificationsService } from '../updates/notifications.service';
import { lockSetupRequests, sameSetups } from '../it/removal';
import { askToCloseAccount, mainAccounts, seatsUsing } from '../company-accounts/account-requests';
import { CompanyAccount } from '../company-accounts/company-accounts.entity';
import { createReturnSetup } from '../it/support-setup';
import { EmailDone, handedOver, ItOnboardingActivity, ItOnboardingRequest, ItOnboardingTask, ItRemovalActivity, ItRemovalRequest, ItRemovalTask, RemovalProfile } from '../it/it.entity';
import { DispatchEvent, DispatchEventType, DispatchMember, ExistingMemberRecord, MemberAssignment, MemberSupportLink, Team } from './dispatch.entity';
import { lockCatchUpLinks, lockTeam, onLeave, onNotice, supportedDispatcher, supportedTeam } from './create-member';
import { accountOwners } from './shared-accounts';
import { syncSignIns } from './lead-sign-in';
import { phoneSqlOf } from '../onboarding/already-here';
import { RehireDto, UndoLeavingDto } from './dispatch.dto';
import { lockForRename, renameMember } from './corrections';

/**
 * Where an email or number is already held on an open account of theirs at another company (its MC's name, or the company
 * typed), so a rehire leaves it there and asks IT nothing. Numbers compare by digits, without a leading US 1.
 */
async function heldAt(em: EntityManager, memberId: string, email: string | null, number: string | null): Promise<{ email: string | null; number: string | null }> {
 if (!email && !number) return { email: null, number: null };
 const rows: { email: boolean; number: boolean; company: string }[] = await em.query(`SELECT lower(a."companyEmail") = lower($2) AS email,
   ${phoneSqlOf('a."ringCentralNumber"')} = ${phoneSqlOf('$3')} AS number, coalesce(m.name, a."companyName") AS company
  FROM member_company_accounts a LEFT JOIN mcs m ON m.id = a."mcId" WHERE a."memberId" = $1 AND a.status <> 'CLOSED' ORDER BY a."createdAt", a.id`, [memberId, email ?? '', number ?? '']);
 return { email: email ? rows.find(row => row.email)?.company ?? null : null, number: number ? rows.find(row => row.number)?.company ?? null : null };
}
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
/** The first day back a rehire accepts: its midday (how first days are stored) must be after they left. */
const firstDayAfter = (leftAt: Date) => new Date(`${day(leftAt)}T12:00:00Z`).getTime() > leftAt.getTime() ? day(leftAt) : addDays(day(leftAt), 1);

interface Accounts {
 // notClosed: IT has no removal for them, so the account was never closed here: IT checks it before turning it back on, or is asked to close it.
 // keptFor: the load board accounts an email IT never closed still signs in to; not getting it back keeps it for them, so IT isn't asked to close it.
 // heldAt: the company of an open account of theirs at another company that already holds it; it stays there and IT isn't asked.
 email: { value: string; was: EmailDone | null; deletedOn: string | null; restorableUntil: string | null; restorable: boolean; why: string | null; notClosed?: boolean; keptFor?: string[]; heldAt?: string | null } | null;
 ringCentral: { number: string; extension: string | null; restorable: boolean; why: string | null; notClosed?: boolean; heldAt?: string | null } | null;
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
  const [comesBack, notBack, accounts] = await Promise.all([this.comesBack(em, member), this.notBack(em, member), this.accounts(em, member, state.removal, { recorded: true })]);
  const plan = await this.undoPlan(em, member, state.removal, accounts);
  const [previous]: { mcId: string | null; teamId: string | null }[] = await em.query(`SELECT "mcId", "teamId" FROM member_assignments WHERE "memberId" = $1 ORDER BY "startedAt" DESC, "createdAt" DESC LIMIT 1`, [id]);
  const [link]: { dispatcherId: string | null; teamId: string | null }[] = await em.query(`SELECT "dispatcherId", "teamId" FROM member_support_links WHERE "supportId" = $1 ORDER BY "startedAt" DESC, "createdAt" DESC LIMIT 1`, [id]);
  // What the undo will do, worked out as the undo works it out: the status they come back to and the steps IT restores.
  return { undo: { allowed: !state.undoRefusal, why: state.undoRefusal, until: state.undoUntil, comesBack, notBack, status: plan.status, restore: plan.restore?.keys ?? [] },
   rehire: { allowed: !state.rehireRefusal, why: state.rehireRefusal, earliest: [usDay('latest'), member.leftAt ? firstDayAfter(member.leftAt) : ''].sort().at(-1)!, latest: addDays(usDay('latest'), REHIRE_MAX_DAYS),
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
   // A new name may rename a team lead's sign-in: user administration's lock comes first (section 45).
   if (dto.newName) await lockForRename(em);
   const setups = await lockSetupRequests(em, id);
   await lockCatchUpLinks(em, id);
   const member = await this.lockLeft(em, id, dto.version);
   await sameSetups(em, id, setups);
   const state = await this.state(em, member, true);
   if (state.rehireRefusal) throw new ConflictException(state.rehireRefusal);
   const leftAt = member.leftAt!, startedAt = new Date(`${firstDay}T12:00:00Z`);
   // The same rule the dialog's earliest day comes from.
   if (firstDay < firstDayAfter(leftAt)) throw new BadRequestException('Their first day back must be after the day they left.');
   const record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId: id });
   const accounts = await this.accounts(em, member, state.removal, { recorded: true, record });
   if (dto.email === 'RESTORE' && !accounts.email?.restorable) throw new BadRequestException(accounts.email?.why ?? 'There’s no company email of theirs to restore. Choose a new email or none.');
   if (dto.ringCentral === 'RESTORE' && !accounts.ringCentral?.restorable) throw new BadRequestException(accounts.ringCentral?.why ?? 'There’s no RingCentral user of theirs to enable. Choose a new number or none.');
   // An account IT never closed, and nobody else owns, that they don't get back: IT is asked to close it (below), so it's never left open untracked.
   const close = { email: dto.email !== 'RESTORE' && accounts.email?.notClosed && accounts.email.restorable ? accounts.email.value : null,
    number: dto.ringCentral !== 'RESTORE' && accounts.ringCentral?.notClosed && accounts.ringCentral.restorable ? accounts.ringCentral : null };
   // Where those accounts were, read before this rehire places them again.
   const place = close.email || close.number ? await this.lastPlace(em, member) : null;
   // A new name (section 45): the old one is kept as an other name at the MC they left, and on an account kept there.
   const formerName = dto.newName ? `${member.firstName} ${member.lastName}`.trim() : null;
   // Only a known MC: lastPlace's "Earlier company" stands for a place nobody recorded, which the other name shows as Place not recorded.
   const formerMc = dto.newName ? (place ?? await this.lastPlace(em, member)).mcId : null;
   const wasPosition = member.position === 'DISPATCHER' ? 'DISPATCHER' as const : member.supportType;
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
   const previousJoinedAt = member.joinedAt;
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
   const closeAsked = place ? await this.keepOldAccounts(em, user, member, place, wasPosition, close, dto.closeEmailAction, formerName) : false;
   // Named before IT's checklist is made, so IT sets them up under the new name.
   if (dto.newName) {
    await renameMember(em, member, { ...dto.newName, kind: 'NEW', place: { mcId: formerMc, companyName: null }, reason: 'Rehired with a new name.', context: 'REHIRE', on: state.leftKnown ? leftAt : null },
     user.id, setups.filter(row => !row.completedAt && !row.cancelledAt));
    await em.save(member);
   }
   const setup = keys.length ? await createReturnSetup(em, { purpose: 'REHIRE', member, keys, restoreKeys, managerId: user.id, actorId: user.id,
    accounts: { companyEmail: dto.email === 'RESTORE' ? accounts.email!.value : null, ringCentralNumber: dto.ringCentral === 'RESTORE' ? accounts.ringCentral!.number : null, ringCentralExtension: dto.ringCentral === 'RESTORE' ? accounts.ringCentral!.extension : null },
    returning: { kind: 'REHIRE', leftOn: state.leftKnown ? day(leftAt) : null, firstDay, emailWas: accounts.email?.was ?? null, emailDeletedOn: accounts.email?.deletedOn ?? null, by: `${user.firstName} ${user.lastName}`,
     notClosed: [...(dto.email === 'RESTORE' && accounts.email?.notClosed ? ['EMAIL' as const] : []), ...(dto.ringCentral === 'RESTORE' && accounts.ringCentral?.notClosed ? ['RINGCENTRAL' as const] : [])] } }) : null;
   if (setup) alerts = await this.alerts.queueItSetupWaiting(em, setup);
   await em.query(`INSERT INTO member_returns ("memberId", kind, "leftAt", "leftKnown", "leftReason", "previousJoinedAt", "previousStartKnown", "firstDay", "removalId", "setupRequestId", "actorId") VALUES ($1, 'REHIRE', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, leftAt, state.leftKnown, state.leftReason, previousJoinedAt, record?.startDateKnown !== false, firstDay, removal?.id ?? null, setup?.id ?? null, user.id]);
   await this.event(em, user, 'REHIRED', id, { position: dto.position, itSetup: !!setup, ...(dto.newName ? { newName: true } : {}), restored: restoreKeys.length > 0, ...(closeAsked ? { closeAsked: true } : {}), assists: dispatcher ? null : dto.supportsTeamId ? 'TEAM' : 'DISPATCHER' });
   await syncSignIns(em, [id], user.id);
   return { id, version: member.version, closeAsked };
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
  * Where their old accounts were: the MC of their last period or, for a support or updater, of the team they last helped or
  * of their dispatcher at the time. Read before the rehire places them again; another company's name only when none is known.
  */
 private async lastPlace(em: EntityManager, member: DispatchMember): Promise<{ mcId: string; companyName: null } | { mcId: null; companyName: string }> {
  // As of when the link ended: a whole team's MC from the MC periods its people had in that team then (a team may change MC
  // once nobody is in it or assists it), else its MC now unless it changed since (then the place isn't known); a dispatcher's
  // from their own period then.
  const helped: { mcId: string | null }[] = member.position === 'DISPATCHER' ? [] : await em.query(`SELECT CASE WHEN l."teamId" IS NOT NULL THEN coalesce(
     (SELECT a."mcId" FROM member_assignments a WHERE a."teamId" = l."teamId" AND a."startedAt" <= coalesce(l."endedAt", now()) AND (a."endedAt" IS NULL OR a."endedAt" >= coalesce(l."endedAt", now()))
      ORDER BY a."startedAt" DESC, a."createdAt" DESC LIMIT 1),
     CASE WHEN l."endedAt" IS NULL OR NOT EXISTS (SELECT 1 FROM dispatch_events e WHERE e."teamId" = l."teamId" AND e.event = 'TEAM_UPDATED'
      AND e.metadata->'fields' ? 'mcId' AND e."createdAt" >= l."endedAt") THEN t."mcId" END)
    ELSE (SELECT a."mcId" FROM member_assignments a WHERE a."memberId" = l."dispatcherId" AND a."startedAt" <= coalesce(l."endedAt", now()) ORDER BY a."startedAt" DESC, a."createdAt" DESC LIMIT 1) END AS "mcId"
   FROM member_support_links l LEFT JOIN teams t ON t.id = l."teamId" WHERE l."supportId" = $1 ORDER BY l."startedAt" DESC, l."createdAt" DESC LIMIT 1`, [member.id]);
  const [own]: { mcId: string | null }[] = helped[0]?.mcId ? [] : await em.query(`SELECT "mcId" FROM member_assignments WHERE "memberId" = $1 ORDER BY "startedAt" DESC, "createdAt" DESC LIMIT 1`, [member.id]);
  const mcId = helped[0]?.mcId ?? own?.mcId ?? null;
  return mcId ? { mcId, companyName: null } : { mcId: null, companyName: 'Earlier company' };
 }
 /**
  * An email or number IT never closed that a rehire doesn't get back stays on record as their account where they were, with IT
  * asked to close it (CLOSE request), so it's never left open untracked. One already on an open account of theirs at another
  * company stays there. An email that still signs in to an open load board seat is kept for it, as a move keeps one, on its own
  * row so closing the number leaves it. Returns whether IT was asked to close anything.
  */
 private async keepOldAccounts(em: EntityManager, user: User, member: DispatchMember, place: { mcId: string | null; companyName: string | null }, position: 'DISPATCHER' | 'SUPPORT' | 'UPDATER',
  old: { email: string | null; number: { number: string; extension: string | null } | null }, emailAction: RehireDto['closeEmailAction'], nameUsed: string | null = null) {
  const held = await heldAt(em, member.id, old.email, old.number?.number ?? null);
  const email = old.email && !held.email ? old.email : null, number = old.number && !held.number ? old.number : null;
  const kept = !!email && (await seatsUsing(em, email)).length > 0;
  const add = async (fields: Pick<CompanyAccount, 'companyEmail' | 'ringCentralNumber' | 'ringCentralExtension' | 'status'>) => {
   const account = await em.getRepository(CompanyAccount).save({ memberId: member.id, ...place, nameUsed, position, ...fields, createdBy: user.id, sourceName: null });
   await em.getRepository(DispatchEvent).save({ memberId: member.id, teamId: null, event: 'COMPANY_ACCOUNT_ADDED', actorId: user.id, metadata: { accountId: account.id, status: fields.status, fields: [], from: 'rehire' } });
   return account;
  };
  if (kept) await add({ companyEmail: email, ringCentralNumber: null, ringCentralExtension: null, status: 'KEPT_FOR_LOAD_BOARDS' });
  const closing = { email: kept ? null : email, number };
  if (!closing.email && !closing.number) return false;
  const account = await add({ companyEmail: closing.email, ringCentralNumber: closing.number?.number ?? null, ringCentralExtension: closing.number?.extension ?? null, status: 'ACTIVE' });
  await askToCloseAccount(em, user.id, member, account, { emailAfter: 'SUSPEND', emailAction: closing.email ? emailAction : undefined, note: null }, 'rehire');
  return true;
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
  // Undo is offered as the way round only when it's possible now.
  const rehireRefusal = facts.later ? later : removal && !removal.completedAt ? `IT is still removing their access. ${undoRefusal ? 'Rehire them' : 'Undo leaving instead, or rehire them'} once IT finishes.` : null;
  return { removal, undoUntil: marked ? undoUntil : null, undoRefusal, rehireRefusal, leftKnown: facts.leftKnown, leftReason: member.leftReason };
 }

 /**
  * Their company email and RingCentral user as IT left them, and whether each can come back as it was. With no removal, a
  * rehire (recorded) reads the accounts on their record instead; an undo has nothing to restore. `record` is theirs when read.
  */
 private async accounts(em: EntityManager, member: DispatchMember, removal: ItRemovalRequest | null, rehire?: { recorded: true; record?: ExistingMemberRecord | null }): Promise<Accounts> {
  if (!removal) return rehire ? this.recordedAccounts(em, member, rehire.record) : { email: null, ringCentral: null };
  const profile = removal.profile, tasks = await em.getRepository(ItRemovalTask).findBy({ requestId: removal.id });
  const task = (key: string) => tasks.find(item => item.key === key);
  let email: Accounts['email'] = null, ringCentral: Accounts['ringCentral'] = null;
  if (profile.companyEmail && !handedOver(profile, 'EMAIL')) {
   const google = task('GOOGLE_WORKSPACE'), done = google?.status === 'COMPLETED' ? removal.emailDone ?? 'SUSPENDED' : null;
   // Deleted when IT first recorded Deleted, which can be before the task was completed; the task's own time only when no record says.
   const [recorded]: { at: Date }[] = done === 'DELETED' ? await em.query(`SELECT min("createdAt") AS at FROM it_removal_activity WHERE "requestId" = $1 AND metadata->>'key' = 'GOOGLE_WORKSPACE' AND metadata->>'emailDone' = 'DELETED'`, [removal.id]) : [];
   const deletedOn = done === 'DELETED' ? easternDay(recorded?.at ?? google!.updatedAt) : null, restorableUntil = deletedOn ? addDays(deletedOn, DELETED_EMAIL_DAYS) : null;
   const why = await this.takenWhy(em, member, 'EMAIL', profile.companyEmail)
    ?? (restorableUntil && usDay('latest') > restorableUntil ? `${profile.companyEmail} was deleted on ${deletedOn}, so IT can no longer restore it.` : null);
   email = { value: profile.companyEmail, was: done, deletedOn, restorableUntil, restorable: !why, why };
  }
  if (profile.ringCentralNumber && !handedOver(profile, 'RINGCENTRAL')) {
   const why = await this.takenWhy(em, member, 'RINGCENTRAL', profile.ringCentralNumber);
   ringCentral = { number: profile.ringCentralNumber, extension: profile.ringCentralExtension ?? null, restorable: !why, why };
  }
  return { email, ringCentral };
 }
 /** Why an old email or number can't come back because it is someone else's now, or null when nobody else owns it. */
 private async takenWhy(em: EntityManager, member: DispatchMember, kind: 'EMAIL' | 'RINGCENTRAL', value: string) {
  const owners = (await accountOwners(em, kind, value, member.id)).map(owner => owner.name);
  return owners.length ? `${value} is someone else’s now (${owners.join(', ')}).` : null;
 }
 /**
  * IT was never asked to remove their access (someone added from a file as Left): their email and number are their main
  * accounts as everything else reads them (mainAccounts). Nothing says they were closed, so IT is told to check one that comes
  * back, and asked to close one that doesn't.
  */
 private async recordedAccounts(em: EntityManager, member: DispatchMember, record?: ExistingMemberRecord | null): Promise<Accounts> {
  const main = await mainAccounts(em, member.id, record);
  const [emailWhy, numberWhy, keptFor, held] = await Promise.all([main.companyEmail ? this.takenWhy(em, member, 'EMAIL', main.companyEmail) : null,
   main.ringCentralNumber ? this.takenWhy(em, member, 'RINGCENTRAL', main.ringCentralNumber) : null, seatsUsing(em, main.companyEmail), heldAt(em, member.id, main.companyEmail, main.ringCentralNumber)]);
  return { email: main.companyEmail ? { value: main.companyEmail, was: null, deletedOn: null, restorableUntil: null, restorable: !emailWhy, why: emailWhy, notClosed: true, keptFor, heldAt: held.email } : null,
   ringCentral: main.ringCentralNumber ? { number: main.ringCentralNumber, extension: main.ringCentralExtension, restorable: !numberWhy, why: numberWhy, notClosed: true, heldAt: held.number } : null };
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

/**
 * Every time someone came back (section 41), newest first, for the dispatcher page: undone leavings and rehires, with who and
 * why, and the IT checklist each one asked for (setup: its progress, null when IT wasn't asked), so the page words what IT does.
 */
export function memberReturns(db: Pick<EntityManager, 'query'>, memberId: string): Promise<{ id: string; kind: 'UNDO' | 'REHIRE'; leftAt: Date; leftKnown: boolean; previousJoinedAt: Date; previousStartKnown: boolean; firstDay: string | null; reason: string | null; createdAt: Date; by: string | null;
  setup: { done: number; total: number; completedAt: Date | null; cancelledAt: Date | null } | null }[]> {
 return db.query(`SELECT r.id, r.kind, r."leftAt", r."leftKnown", r."leftReason", r."previousJoinedAt", r."previousStartKnown", r."firstDay"::text AS "firstDay", r.reason, r."createdAt",
   CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS by,
   CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('done', (SELECT count(*) FROM it_onboarding_tasks t WHERE t."requestId" = s.id AND t.status IN ('COMPLETED', 'NOT_NEEDED'))::int,
    'total', (SELECT count(*) FROM it_onboarding_tasks t WHERE t."requestId" = s.id)::int, 'completedAt', s."completedAt", 'cancelledAt', s."cancelledAt") END AS setup
  FROM member_returns r LEFT JOIN users u ON u.id = r."actorId" LEFT JOIN it_onboarding_requests s ON s.id = r."setupRequestId" WHERE r."memberId" = $1 ORDER BY r."createdAt" DESC`, [memberId]);
}
