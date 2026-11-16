import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { driverEvent } from '../safety/driver-records';
import { Driver, DriverAssignment } from '../safety/safety.entity';
import { askGroupChange } from '../safety/road-ready';
import { usDay } from '../safety/screening-rules';
import { DispatchMember, DriverLeaveCover, type LeaveEnd, MemberLeave } from './dispatch.entity';
import { day } from './dispatch.service';
import { onLeave, onLeaveSql, onNotice } from './create-member';

/**
 * Drivers while their dispatcher is away (section 34, approved 2026-11-16). Putting a dispatcher on leave names who covers
 * each of their drivers: another active dispatcher under the driver's MC who isn't away or leaving. From the first day away
 * the driver's assignment moves to them; on the return day it moves back, unless the driver was reassigned for good
 * meanwhile. If the person on leave is marked as leaving, the drivers stay with whoever covers them. Every move is an
 * ordinary driver_assignments row, so the driver's history keeps it, and a truck's Telegram group gets the usual request.
 *
 * Locks: drivers before the member on leave (the order Assign takes, driver then dispatcher), then the covering dispatcher's
 * row for share. A driver assigned between the read and the member lock answers 409, so nothing is moved unlocked.
 */
export interface CoverChoice { driverId: string; memberId: string }

const STALE = 'Someone else changed this record. Reload and try again.';
const name = (member: Pick<DispatchMember, 'firstName' | 'lastName'>) => `${member.firstName} ${member.lastName}`.trim();
/** The later of a day (midday UTC) and one millisecond after the assignment it follows, like every other move. */
const after = (date: Date, previous: Date) => new Date(Math.max(date.getTime(), previous.getTime() + 1));

/** Their drivers now, and the ones an open leave of theirs covers. */
async function leaveDriverIds(em: EntityManager, memberId: string): Promise<string[]> {
 const rows: { id: string }[] = await em.query(`SELECT "driverId" AS id FROM driver_assignments WHERE "memberId" = $1 AND "endedAt" IS NULL
  UNION SELECT c."driverId" FROM driver_leave_covers c JOIN member_leaves l ON l.id = c."leaveId" WHERE l."memberId" = $1 AND l."endedAt" IS NULL AND c."endedAt" IS NULL`, [memberId]);
 return rows.map(row => row.id).sort();
}
/** Locks those drivers before the member row; call sameLeaveDrivers once the member is locked. */
export async function lockLeaveDrivers(em: EntityManager, memberId: string) {
 const ids = await leaveDriverIds(em, memberId);
 if (ids.length) await em.query(`SELECT id FROM drivers WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids]);
 return ids;
}
export async function sameLeaveDrivers(em: EntityManager, memberId: string, locked: string[]) {
 const now = await leaveDriverIds(em, memberId);
 if (now.some(id => !locked.includes(id))) throw new ConflictException(STALE);
}

/** A dispatcher who may cover a driver on this MC: active, under it now, not away, not leaving, and not the person on leave. */
async function coverable(em: EntityManager, coverId: string, mcId: string, awayId: string) {
 if (coverId === awayId) return false;
 const cover = await em.getRepository(DispatchMember).findOne({ where: { id: coverId }, lock: { mode: 'pessimistic_read' } });
 if (!cover || cover.status !== 'ACTIVE' || cover.position !== 'DISPATCHER') return false;
 const [placed] = await em.query(`SELECT 1 FROM member_assignments WHERE "memberId" = $1 AND "endedAt" IS NULL AND "mcId" = $2`, [coverId, mcId]);
 return !!placed && !await onNotice(em, coverId) && !await onLeave(em, coverId);
}

/**
 * The plan, when the leave is recorded: every driver they have now, each with who covers them. An older page sends none,
 * and their drivers stay with them as before.
 */
export async function planCovers(em: EntityManager, leave: MemberLeave, member: DispatchMember, choices: CoverChoice[] | undefined, actorId: string) {
 if (!choices || member.position !== 'DISPATCHER') return 0;
 const current = await em.getRepository(DriverAssignment).findBy({ memberId: member.id, endedAt: IsNull() });
 const chosen = new Map(choices.map(choice => [choice.driverId, choice.memberId]));
 if (chosen.size !== choices.length || current.length !== chosen.size || current.some(row => !chosen.has(row.driverId))) throw new BadRequestException('Choose who covers each of their drivers.');
 for (const row of current) {
  if (!await coverable(em, chosen.get(row.driverId)!, row.mcId, member.id)) throw new BadRequestException('Choose an active dispatcher under the driver’s MC who isn’t away or leaving.');
  await em.getRepository(DriverLeaveCover).save({ leaveId: leave.id, driverId: row.driverId, coverMemberId: chosen.get(row.driverId)!, coverAssignmentId: null, startedAt: null, endedAt: null, endedHow: null, createdBy: actorId });
 }
 return current.length;
}

/** Moves one driver from their open assignment to the covering dispatcher. */
async function moveTo(em: EntityManager, current: DriverAssignment, to: string, at: Date, reason: string, actorId: string | null, group: { add: string | null; remove: string | null }) {
 current.endedAt = after(at, current.startedAt); await em.save(current);
 const next = await em.getRepository(DriverAssignment).save({ driverId: current.driverId, mcId: current.mcId, memberId: to, truck: current.truck, unitId: current.unitId, trailerId: current.trailerId,
  startedAt: new Date(current.endedAt.getTime()), reason, actorId });
 await askGroupChange(em, current.driverId, { reason: 'DISPATCHER_CHANGED', unitId: current.unitId, addMemberId: group.add, removeMemberId: group.remove });
 await em.getRepository(Driver).increment({ id: current.driverId }, 'version', 1);
 await driverEvent(em, actorId, current.driverId, 'DISPATCH_ASSIGNED', { first: false, truck: !!current.truck, trailer: !!current.trailerId, cover: true });
 return next;
}

/** The first day away: each planned driver moves to who covers them. A driver who moved meanwhile, or whose cover can't now, stays. */
export async function startCovers(em: EntityManager, leave: MemberLeave, member: DispatchMember, actorId: string) {
 const at = day(leave.firstDay <= usDay('latest') ? leave.firstDay : usDay('latest'));
 for (const cover of await em.getRepository(DriverLeaveCover).findBy({ leaveId: leave.id, startedAt: IsNull(), endedAt: IsNull() })) {
  const current = await em.getRepository(DriverAssignment).findOneBy({ driverId: cover.driverId, endedAt: IsNull() });
  if (!current || current.memberId !== member.id) { await end(em, cover, 'REASSIGNED'); continue; }
  if (!await coverable(em, cover.coverMemberId, current.mcId, member.id)) { await end(em, cover, 'SKIPPED'); continue; }
  const moved = await moveTo(em, current, cover.coverMemberId, at, `Covering while ${name(member)} is away.`, actorId, { add: cover.coverMemberId, remove: null });
  cover.startedAt = moved.startedAt; cover.coverAssignmentId = moved.id; await em.save(cover);
 }
}

/**
 * The leave ends. Back (or cancelled once started): a driver still with who covered them comes back; one reassigned meanwhile
 * stays. Leaving: they stay with who covers them, now for good. A plan that never started just ends.
 */
export async function endCovers(em: EntityManager, leave: MemberLeave, member: DispatchMember, how: LeaveEnd, actorId: string | null) {
 const today = day(usDay('latest'));
 for (const cover of await em.getRepository(DriverLeaveCover).findBy({ leaveId: leave.id, endedAt: IsNull() })) {
  if (!cover.startedAt) { await end(em, cover, 'CANCELLED'); continue; }
  if (how === 'LEAVING') { await end(em, cover, 'KEPT'); continue; }
  const current = await em.getRepository(DriverAssignment).findOneBy({ driverId: cover.driverId, endedAt: IsNull() });
  if (!current || current.id !== cover.coverAssignmentId) { await end(em, cover, 'REASSIGNED'); continue; }
  await moveTo(em, current, member.id, today, `Back with ${name(member)} after their leave.`, actorId, { add: null, remove: cover.coverMemberId });
  await end(em, cover, 'RETURNED');
 }
}
async function end(em: EntityManager, cover: DriverLeaveCover, how: DriverLeaveCover['endedHow']) {
 cover.endedAt = new Date(); cover.endedHow = how; await em.save(cover);
}

/**
 * Change who covers (OnLeaveCoveredScreen's More actions): before the leave starts this only changes the plan; once it has,
 * a driver still with who covered them moves to the new one. A driver given to them after the leave was recorded can be
 * added. Returns how many changed.
 */
export async function changeCovers(em: EntityManager, leave: MemberLeave, member: DispatchMember, choices: CoverChoice[], actorId: string) {
 const covers = await em.getRepository(DriverLeaveCover).findBy({ leaveId: leave.id, endedAt: IsNull() });
 let changed = 0;
 for (const choice of choices) {
  const cover = covers.find(item => item.driverId === choice.driverId);
  const current = await em.getRepository(DriverAssignment).findOneBy({ driverId: choice.driverId, endedAt: IsNull() });
  // Covered now, or still theirs (not covered yet); anyone else's driver isn't part of this leave.
  const theirs = !!current && current.memberId === member.id, covering = !!cover?.startedAt && current?.id === cover.coverAssignmentId;
  if (!current || (!theirs && !covering) || (cover && cover.startedAt && !covering)) throw new BadRequestException('This driver isn’t covered for this leave any more. Reload the page.');
  if (cover?.coverMemberId === choice.memberId) continue;
  if (!await coverable(em, choice.memberId, current.mcId, member.id)) throw new BadRequestException('Choose an active dispatcher under the driver’s MC who isn’t away or leaving.');
  if (cover && covering) {
   const moved = await moveTo(em, current, choice.memberId, day(usDay('latest')), `Covering while ${name(member)} is away.`, actorId, { add: choice.memberId, remove: cover.coverMemberId });
   cover.coverMemberId = choice.memberId; cover.coverAssignmentId = moved.id; await em.save(cover);
  } else if (cover) { cover.coverMemberId = choice.memberId; await em.save(cover); }
  else {
   const added: DriverLeaveCover = await em.getRepository(DriverLeaveCover).save(em.getRepository(DriverLeaveCover).create({ leaveId: leave.id, driverId: choice.driverId, coverMemberId: choice.memberId, coverAssignmentId: null, startedAt: null, endedAt: null, endedHow: null, createdBy: actorId }));
   if (leave.startedAt) {
    const moved = await moveTo(em, current, choice.memberId, day(usDay('latest')), `Covering while ${name(member)} is away.`, actorId, { add: choice.memberId, remove: null });
    added.startedAt = moved.startedAt; added.coverAssignmentId = moved.id; await em.save(added);
   }
  }
  changed += 1;
 }
 return changed;
}

/** For the leave dialog and Change who covers: their drivers, and who may cover each (by MC). */
export async function coverOptions(em: Pick<EntityManager, 'query'>, memberId: string) {
 const drivers: { id: string; name: string; truck: string | null; mcId: string; mc: string; coverId: string | null }[] = await em.query(`SELECT d.id, d."firstName" || ' ' || d."lastName" AS name, a.truck, a."mcId", m.name AS mc, c."coverMemberId" AS "coverId"
  FROM driver_assignments a JOIN drivers d ON d.id = a."driverId" JOIN mcs m ON m.id = a."mcId"
  LEFT JOIN member_leaves l ON l."memberId" = $1 AND l."endedAt" IS NULL
  LEFT JOIN driver_leave_covers c ON c."leaveId" = l.id AND c."driverId" = d.id AND c."endedAt" IS NULL
  WHERE a."endedAt" IS NULL AND (a."memberId" = $1 OR (c."startedAt" IS NOT NULL AND a.id = c."coverAssignmentId"))
  ORDER BY lower(d."firstName"), lower(d."lastName")`, [memberId]);
 const mcIds = [...new Set(drivers.map(item => item.mcId))];
 const dispatchers: { id: string; name: string; mcId: string; team: string | null }[] = mcIds.length ? await em.query(`SELECT x.id, x."firstName" || ' ' || x."lastName" AS name, ma."mcId", t.name AS team
  FROM dispatch_members x JOIN member_assignments ma ON ma."memberId" = x.id AND ma."endedAt" IS NULL LEFT JOIN teams t ON t.id = ma."teamId"
  WHERE x.id <> $1 AND x.status = 'ACTIVE' AND x.position = 'DISPATCHER' AND ma."mcId" = ANY($2) AND NOT ${onLeaveSql('x')}
   AND NOT EXISTS(SELECT 1 FROM member_notices n WHERE n."memberId" = x.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL)
  ORDER BY t.name NULLS LAST, lower(x."firstName"), lower(x."lastName")`, [memberId, mcIds]) : [];
 return { drivers, dispatchers };
}

/** The open leave's covers for their page (OnLeaveCoveredScreen) and the return dialog (ReturnDriversBackScreen). */
export async function leaveCovers(em: Pick<EntityManager, 'query'>, leaveId: string, memberId: string) {
 const covers: { driverId: string; driver: string; truck: string | null; cover: string; coverTeam: string | null; started: boolean; with: string | null; stays: boolean }[] = await em.query(`SELECT c."driverId", d."firstName" || ' ' || d."lastName" AS driver,
   a.truck, x."firstName" || ' ' || x."lastName" AS cover, t.name AS "coverTeam", c."startedAt" IS NOT NULL AS started,
   CASE WHEN w.id IS NULL THEN NULL ELSE w."firstName" || ' ' || w."lastName" END AS "with",
   (c."startedAt" IS NOT NULL AND a.id IS DISTINCT FROM c."coverAssignmentId") AS stays
  FROM driver_leave_covers c JOIN drivers d ON d.id = c."driverId" JOIN dispatch_members x ON x.id = c."coverMemberId"
  LEFT JOIN member_assignments ma ON ma."memberId" = x.id AND ma."endedAt" IS NULL LEFT JOIN teams t ON t.id = ma."teamId"
  LEFT JOIN driver_assignments a ON a."driverId" = c."driverId" AND a."endedAt" IS NULL LEFT JOIN dispatch_members w ON w.id = a."memberId"
  WHERE c."leaveId" = $1 AND c."endedAt" IS NULL ORDER BY lower(d."firstName"), lower(d."lastName")`, [leaveId]);
 // Drivers given to them after the plan was made, who nobody covers yet.
 const uncovered: { driverId: string; driver: string; truck: string | null }[] = await em.query(`SELECT a."driverId", d."firstName" || ' ' || d."lastName" AS driver, a.truck FROM driver_assignments a JOIN drivers d ON d.id = a."driverId"
  WHERE a."memberId" = $1 AND a."endedAt" IS NULL AND NOT EXISTS(SELECT 1 FROM driver_leave_covers c WHERE c."leaveId" = $2 AND c."driverId" = a."driverId" AND c."endedAt" IS NULL)
  ORDER BY lower(d."firstName"), lower(d."lastName")`, [memberId, leaveId]);
 return { covers, uncovered };
}
