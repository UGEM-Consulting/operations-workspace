import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import type { User } from '../users/user.entity';
import { Mc } from '../lists/lists.entity';
import { driverEvent, lockOpenDriver, writeDriver } from '../safety/driver-records';
import { Driver, DriverAssignment } from '../safety/safety.entity';
import { AssignDriverDto } from './dispatch.dto';
import { DispatchMember, MemberAssignment } from './dispatch.entity';
import { day, notBefore } from './dispatch.service';
import { ledTeams, lockTeam, onNotice } from './create-member';
import { onHoldSql } from '../safety/holds';

/** A team lead acts only inside the teams they lead; everyone else here is a dispatch manager or administrator. */
type Scope = { teamIds: string[] } | null;
const name = (alias: string) => `${alias}."firstName" || ' ' || ${alias}."lastName"`;

/**
 * Cleared drivers for Dispatch: Safety clears a driver, then a dispatch manager or administrator (anywhere) or a team lead
 * (inside their own teams) assigns an MC and a dispatcher working in a team under that MC, from a date, with an optional
 * truck. Changes close the open assignment and add a row, like owners and member moves. Dispatch sees only the name,
 * phone, driver type and license class, truck and Cleared status; never the application, scans, screening or clearance.
 */
@Injectable()
export class DriverAssignmentsService {
 constructor(private readonly db: DataSource) {}

 /** A team lead sees the drivers waiting for a dispatcher and the ones their teams' dispatchers work with. */
 async drivers(user: User | null) {
  const scope = await this.scope(this.db.manager, user);
  const items: Record<string, unknown>[] = await this.db.query(`SELECT d.id, d."firstName", d."lastName", d.phone, d."driverType", d."licenseType", d.version, d."clearedAt", ${onHoldSql()} AS "onHold",
    CASE WHEN k.id IS NULL THEN NULL ELSE ${name('k')} END AS "clearedBy",
    CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object('mcId', m.id, 'mc', m.name, 'memberId', x.id, 'dispatcher', ${name('x')}, 'teamId', t.id, 'team', t.name, 'truck', a.truck, 'startedAt', a."startedAt") END AS assignment
   FROM drivers d LEFT JOIN users k ON k.id = d."clearedBy"
   LEFT JOIN driver_assignments a ON a."driverId" = d.id AND a."endedAt" IS NULL LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN dispatch_members x ON x.id = a."memberId"
   LEFT JOIN member_assignments ma ON ma."memberId" = x.id AND ma."endedAt" IS NULL LEFT JOIN teams t ON t.id = ma."teamId"
   WHERE d.status = 'CLEARED' AND ($1::uuid[] IS NULL OR a.id IS NULL OR ma."teamId" = ANY($1::uuid[]))
   ORDER BY a.id IS NOT NULL, d."clearedAt" DESC LIMIT 1000`, [scope?.teamIds ?? null]);
  return { items };
 }

 /**
  * MCs with their active dispatchers, in a team or independent (no team), for the Assign dialog (a team lead: only their
  * teams). An archived
  * MC is listed (marked) only while drivers still work with it, because they may stay on it; nobody new is placed there.
  */
 async options(user: User | null) {
  const scope = await this.scope(this.db.manager, user);
  const rows: { mcId: string; mc: string; mcNumber: string | null; archived: boolean; memberId: string; dispatcher: string; teamId: string | null; team: string | null }[] = await this.db.query(`SELECT m.id AS "mcId", m.name AS mc, m."mcNumber", m."archivedAt" IS NOT NULL AS archived,
    x.id AS "memberId", ${name('x')} AS dispatcher, t.id AS "teamId", t.name AS team
   FROM member_assignments ma JOIN dispatch_members x ON x.id = ma."memberId" JOIN mcs m ON m.id = ma."mcId" LEFT JOIN teams t ON t.id = ma."teamId"
   WHERE ma."endedAt" IS NULL AND x.status = 'ACTIVE' AND x.position = 'DISPATCHER' AND (ma."teamId" IS NULL OR (t."archivedAt" IS NULL AND t."mcId" = m.id))
    AND NOT EXISTS(SELECT 1 FROM member_notices n WHERE n."memberId" = x.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL)
    AND (m."archivedAt" IS NULL OR EXISTS(SELECT 1 FROM driver_assignments a WHERE a."mcId" = m.id AND a."endedAt" IS NULL))
    AND ($1::uuid[] IS NULL OR t.id = ANY($1::uuid[]))
   ORDER BY m."nameKey", lower(x."firstName"), lower(x."lastName")`, [scope?.teamIds ?? null]);
  const mcs = new Map<string, { id: string; name: string; mcNumber: string | null; archived: boolean; dispatchers: { id: string; name: string; teamId: string | null; team: string | null }[] }>();
  for (const row of rows) {
   const mc = mcs.get(row.mcId) ?? { id: row.mcId, name: row.mc, mcNumber: row.mcNumber, archived: row.archived, dispatchers: [] };
   mc.dispatchers.push({ id: row.memberId, name: row.dispatcher, teamId: row.teamId, team: row.team });
   mcs.set(row.mcId, mc);
  }
  return { mcs: [...mcs.values()] };
 }

 /**
  * Locks the driver (who must be Cleared), then the dispatcher's record and their team for share, so the dispatcher can't
  * leave, move to another MC or out of a team lead's scope before this commits (leave and move lock the member first).
  */
 async assign(user: User, scoped: boolean, id: string, dto: AssignDriverDto) {
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   const scope = await this.scope(em, scoped ? user : null);
   if (scope && !scope.teamIds.length) throw new ForbiddenException('Your account isn’t linked to a team you lead.');
   if (driver.status !== 'CLEARED') throw new ConflictException('Only a driver Safety has cleared can be assigned.');
   const assignments = em.getRepository(DriverAssignment);
   const current = await assignments.findOneBy({ driverId: id, endedAt: IsNull() });
   // On hold (a failed or refused test, not qualified at the yearly review or an expired document): Safety lifts it, and
   // Dispatch isn't told why. Nobody new takes them on, but one already assigned can be handed to another dispatcher, so
   // their dispatcher can still leave or change MC.
   const [{ held }] = await em.query(`SELECT ${onHoldSql()} AS held FROM drivers d WHERE d.id = $1`, [id]) as { held: boolean }[];
   if (held && !current) throw new ConflictException('Safety has put this driver on hold, so they can’t be assigned. Ask Safety.');
   // A team lead may change only a driver who works with their own teams (or no one yet).
   if (scope && current && !await em.getRepository(MemberAssignment).createQueryBuilder('a')
    .where('a.memberId = :member AND a.endedAt IS NULL AND a.teamId IN (:...teams)', { member: current.memberId, teams: scope.teamIds }).getExists())
    throw new NotFoundException('This driver works with another team.');
   const mc = await em.getRepository(Mc).findOneBy({ id: dto.mcId });
   // A driver may stay on an MC archived since they were placed; nobody moves onto an archived one.
   if (!mc || (mc.archivedAt && current?.mcId !== mc.id)) throw new BadRequestException('Choose an active MC.');
   const member = await em.getRepository(DispatchMember).findOne({ where: { id: dto.memberId }, lock: { mode: 'pessimistic_read' } });
   const placed = member && await em.getRepository(MemberAssignment).findOneBy({ memberId: member.id, endedAt: IsNull() });
   // In a team of this MC, or independent (no team) under it; a team lead only within their teams.
   const team = placed?.teamId ? await lockTeam(em, placed.teamId) : null;
   if (!member || member.position !== 'DISPATCHER' || member.status !== 'ACTIVE' || !placed || placed.mcId !== mc.id || (placed.teamId && (!team || team.archivedAt || team.mcId !== mc.id))
    || (scope && (!team || !scope.teamIds.includes(team.id)))) throw new BadRequestException(scope ? 'Choose an active dispatcher in your team.' : 'Choose an active dispatcher under this MC.');
   // Someone leaving keeps the drivers they have, but takes on no new ones.
   if (current?.memberId !== member.id && await onNotice(em, member.id)) throw new BadRequestException('This dispatcher is leaving. Choose another dispatcher.');
   const truck = dto.truck || null;
   if (current && current.mcId === mc.id && current.memberId === member.id && current.truck === truck) throw new BadRequestException('The driver already works with this MC, dispatcher and truck.');
   if (current && !dto.reason) throw new BadRequestException('Say why the driver is changing MC, dispatcher or truck.');
   let startedAt = notBefore(day(dto.startsOn), driver.clearedAt!, 'The start date can’t be before Safety cleared the driver.');
   if (current) startedAt = notBefore(startedAt, current.startedAt, 'The change can’t start before the current assignment did.');
   if (current) { current.endedAt = startedAt; await em.save(current); }
   await assignments.save({ driverId: id, mcId: mc.id, memberId: member.id, truck, startedAt, reason: dto.reason || null, actorId: user.id });
   await em.getRepository(Driver).update(id, { version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'DISPATCH_ASSIGNED', { first: !current, truck: !!truck });
   return { id, version: driver.version + 1 };
  });
 }

 private async scope(em: EntityManager, user: User | null): Promise<Scope> {
  return user ? { teamIds: (await ledTeams(em, user.id)).map(team => team.id) } : null;
 }
}
