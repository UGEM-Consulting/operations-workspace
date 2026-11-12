import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { User } from '../users/user.entity';
import { driverEvent, lockOpenDriver, ownsDriver, SCREENERS, writeDriver } from './driver-records';
import { NoSsn } from './pii';
import { usDay } from './screening-rules';
import { PERMITS_FOR, type UnitKind } from './units.dto';
import { personName } from './sql';

/** The steps Safety marks by hand; the unit, the acknowledgement and the permits are read from the records. */
export const MANUAL_STEPS = ['BINDER', 'SAMSARA', 'DECALS', 'ORIENTATION', 'TELEGRAM_GROUP'] as const;
export type ManualStep = typeof MANUAL_STEPS[number];
export const READY_STEPS = ['UNIT', 'ACKNOWLEDGEMENT', 'BINDER', 'PERMITS', 'SAMSARA', 'DECALS', 'ORIENTATION', 'TELEGRAM_GROUP'] as const;
export type ReadyStep = typeof READY_STEPS[number];
export class ReadyStepDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(['PENDING', 'IN_PROGRESS', 'COMPLETED']) status!: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
 @IsOptional() @IsString() @MaxLength(500) @NoSsn() note?: string;
}
export class ReadyUnitDto {
 @IsInt() @Min(1) version!: number;
 @IsUUID() unitId!: string;
}
export class GroupDoneDto { @IsInt() @Min(1) version!: number; }

type Step = { key: ReadyStep; status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'NOT_NEEDED'; note?: string | null; updatedAt?: Date | null; updatedBy?: string | null; detail?: Record<string, unknown> };
interface Inputs {
 unit: { id: string; number: string; kind: UnitKind; owner: string | null; ownerId: string | null; operatorId: string | null; fromDispatch: boolean } | null;
 contract: { id: string; driverSignedAt: Date | null; ownerSignedAt: Date | null; link: { purpose: string; email: string; expiresAt: Date; expired: boolean } | null } | null;
 permits: { kind: string; expiresOn: string }[]; rows: { key: string; status: Step['status']; note: string | null; updatedAt: Date; updatedBy: string | null }[];
}
/** The eight steps, in order, from what is recorded. Nothing here holds the driver for Dispatch. */
function steps(input: Inputs, today: string): Step[] {
 const manual = (key: ManualStep): Step => { const row = input.rows.find(item => item.key === key); return { key, status: row?.status ?? 'PENDING', note: row?.note ?? null, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null }; };
 const unit = input.unit, needed = unit ? PERMITS_FOR[unit.kind] : [];
 const missing = needed.filter(kind => !input.permits.some(permit => permit.kind === kind && permit.expiresOn >= today));
 const contract = input.contract;
 return [
  { key: 'UNIT', status: unit ? 'COMPLETED' : 'PENDING', detail: unit ? { ...unit } : undefined },
  // An owner-operator drives their own truck under their lease: no acknowledgement.
  { key: 'ACKNOWLEDGEMENT', status: !unit ? 'PENDING' : unit.operatorId ? 'NOT_NEEDED' : contract?.ownerSignedAt ? 'COMPLETED' : contract ? 'IN_PROGRESS' : 'PENDING', detail: contract ? { ...contract } : undefined },
  manual('BINDER'),
  { key: 'PERMITS', status: !unit ? 'PENDING' : missing.length ? 'PENDING' : 'COMPLETED', detail: { needed, missing } },
  manual('SAMSARA'), manual('DECALS'), manual('ORIENTATION'), manual('TELEGRAM_GROUP')];
}
const done = (step: Step) => step.status === 'COMPLETED' || step.status === 'NOT_NEEDED';
export const readyWords: Record<ReadyStep, string> = { UNIT: 'Unit', ACKNOWLEDGEMENT: 'Driver and Contractor Acknowledgement', BINDER: 'Truck binder and accident kit', PERMITS: 'Permits in the truck',
 SAMSARA: 'Samsara camera and ELD', DECALS: 'Decals and signs', ORIENTATION: 'Orientation', TELEGRAM_GROUP: 'Telegram group' };

/**
 * The inputs for many drivers at once: the unit each will drive (Dispatch's assignment, else Safety's pick), its owner and
 * permits, the latest acknowledgement for that unit, and the steps marked by hand. Only drivers with Ready for the road.
 */
async function inputs(em: EntityManager, driverIds: string[]): Promise<Map<string, Inputs>> {
 const map = new Map<string, Inputs>();
 if (!driverIds.length) return map;
 const units = await em.query(`SELECT r."driverId", t.id, t.unit AS number, t.kind, t."ownerId", t."driverId" AS "operatorId", a."unitId" IS NOT NULL AS "fromDispatch",
   coalesce(o.name, od."firstName" || ' ' || od."lastName") AS owner
  FROM driver_road_ready r LEFT JOIN driver_assignments a ON a."driverId" = r."driverId" AND a."endedAt" IS NULL JOIN driver_trucks t ON t.id = coalesce(a."unitId", r."unitId")
  LEFT JOIN truck_owners o ON o.id = t."ownerId" LEFT JOIN drivers od ON od.id = t."driverId" WHERE r."driverId" = ANY($1::uuid[])`, [driverIds]) as (NonNullable<Inputs['unit']> & { driverId: string })[];
 const unitIds = units.map(unit => unit.id);
 const [contracts, permits, rows] = await Promise.all([
  em.query(`SELECT DISTINCT ON (c."driverId", c."unitId") c."driverId", c."unitId", c.id, c."driverSignedAt", c."ownerSignedAt",
    (SELECT json_build_object('purpose', l.purpose, 'email', l.email, 'expiresAt', l."expiresAt", 'expired', l."expiresAt" <= now()) FROM driver_links l
     WHERE l."contractId" = c.id AND l."revokedAt" IS NULL AND l."completedAt" IS NULL ORDER BY l."createdAt" DESC LIMIT 1) AS link
   FROM driver_contracts c WHERE c."driverId" = ANY($1::uuid[]) AND c."cancelledAt" IS NULL ORDER BY c."driverId", c."unitId", c."createdAt" DESC`, [driverIds]) as Promise<(NonNullable<Inputs['contract']> & { driverId: string; unitId: string })[]>,
  unitIds.length ? em.query(`SELECT "unitId", kind, to_char("expiresOn", 'YYYY-MM-DD') AS "expiresOn" FROM unit_permits WHERE "unitId" = ANY($1::uuid[])`, [unitIds]) as Promise<{ unitId: string; kind: string; expiresOn: string }[]> : [],
  em.query(`SELECT s."driverId", s.key, s.status, s.note, s."updatedAt", ${personName('u')} AS "updatedBy"
   FROM driver_road_ready_steps s LEFT JOIN users u ON u.id = s."updatedBy" WHERE s."driverId" = ANY($1::uuid[])`, [driverIds]) as Promise<(Inputs['rows'][number] & { driverId: string })[]>]);
 const started = await em.query(`SELECT "driverId" FROM driver_road_ready WHERE "driverId" = ANY($1::uuid[])`, [driverIds]) as { driverId: string }[];
 for (const { driverId } of started) {
  const found = units.find(unit => unit.driverId === driverId);
  const unit = found ? { id: found.id, number: found.number, kind: found.kind, owner: found.owner, ownerId: found.ownerId, operatorId: found.operatorId, fromDispatch: found.fromDispatch } : null;
  const contract = unit ? contracts.find(row => row.driverId === driverId && row.unitId === unit.id) ?? null : null;
  map.set(driverId, { unit, contract: contract && { id: contract.id, driverSignedAt: contract.driverSignedAt, ownerSignedAt: contract.ownerSignedAt, link: contract.link },
   permits: unit ? permits.filter(row => row.unitId === unit.id) : [], rows: rows.filter(row => row.driverId === driverId) });
 }
 return map;
}
/** For lists (Getting ready, Dispatch): how many steps are done and the next one, for drivers with Ready for the road. */
export async function readySummaries(em: EntityManager, driverIds: string[]) {
 const today = usDay('latest'), result = new Map<string, { done: number; total: number; next: ReadyStep | null; unit: string | null }>();
 for (const [driverId, input] of await inputs(em, driverIds)) {
  const list = steps(input, today);
  result.set(driverId, { done: list.filter(done).length, total: list.length, next: list.find(step => !done(step))?.key ?? null, unit: input.unit?.number ?? null });
 }
 return result;
}

/**
 * Asks the driver's Safety Manager to update the truck's Telegram group (GroupChangeTaskScreen) when a driver changes
 * dispatcher or truck, or leaves, once the group was made. The workspace can't change groups, so it is marked by hand.
 * Called in the transaction that makes the change.
 */
export async function askGroupChange(em: EntityManager, driverId: string, change: { reason: 'DISPATCHER_CHANGED' | 'TRUCK_CHANGED' | 'DRIVER_LEFT'; unitId: string | null;
 removeMemberId?: string | null; addMemberId?: string | null; newUnitId?: string | null }) {
 const [made] = await em.query(`SELECT 1 FROM driver_road_ready_steps WHERE "driverId" = $1 AND key = 'TELEGRAM_GROUP' AND status = 'COMPLETED'`, [driverId]) as unknown[];
 if (!made) return;
 await em.query(`INSERT INTO telegram_group_changes ("driverId", "unitId", reason, "removeMemberId", "addMemberId", "newUnitId") VALUES ($1, $2, $3, $4, $5, $6)`,
  [driverId, change.unitId, change.reason, change.removeMemberId ?? null, change.addMemberId ?? null, change.newUnitId ?? null]);
}
/** The truck the group was made for before Dispatch assigns one: Safety's pick on Ready for the road, if any. */
export async function pickedUnitId(em: EntityManager, driverId: string): Promise<string | null> {
 const [row] = await em.query(`SELECT "unitId" FROM driver_road_ready WHERE "driverId" = $1`, [driverId]) as { unitId: string | null }[];
 return row?.unitId ?? null;
}
/** Starts Ready for the road for a driver Safety just cleared, in the clearing transaction. */
export async function startRoadReady(em: EntityManager, driverId: string) {
 await em.query(`INSERT INTO driver_road_ready ("driverId") VALUES ($1) ON CONFLICT DO NOTHING`, [driverId]);
}

/**
 * Ready for the road (section 39, RoadReadyScreen and its group): after Cleared, the driver's Safety Manager (and Safety
 * leads, the Safety Director and administrators) works through eight steps. Each records who did it and when; none holds
 * the driver for Dispatch. ROAD_READY_RECORDED and GROUP_UPDATED events hold the step and status, never notes.
 */
@Injectable()
export class RoadReadyService {
 constructor(private readonly db: DataSource) {}

 async forDriver(driverId: string) {
  const input = (await inputs(this.db.manager, [driverId])).get(driverId);
  if (!input) return null;
  const list = steps(input, usDay('latest'));
  const changes = await this.db.query(`SELECT g.id, g.reason, t.unit, n.unit AS "newUnit", g."createdAt", g."doneAt", ${personName('u')} AS "doneBy",
    ${personName('rm')} AS remove, ${personName('am')} AS add
   FROM telegram_group_changes g LEFT JOIN driver_trucks t ON t.id = g."unitId" LEFT JOIN driver_trucks n ON n.id = g."newUnitId" LEFT JOIN users u ON u.id = g."doneBy"
   LEFT JOIN dispatch_members rm ON rm.id = g."removeMemberId" LEFT JOIN dispatch_members am ON am.id = g."addMemberId" WHERE g."driverId" = $1 ORDER BY g."createdAt" DESC`, [driverId]);
  // Someone else in the same truck now (team drivers share one group).
  const sharing = input.unit ? await this.db.query(`SELECT d."firstName" || ' ' || d."lastName" AS name FROM driver_assignments a JOIN drivers d ON d.id = a."driverId"
   WHERE a."unitId" = $1 AND a."endedAt" IS NULL AND a."driverId" <> $2 AND d.status = 'CLEARED'`, [input.unit.id, driverId]) as { name: string }[] : [];
  // What Choose unit offers while Dispatch hasn't assigned a truck: an owner-operator's own trucks, else truck owners' trucks in service.
  const choices = input.unit?.fromDispatch ? [] : await this.db.query(`SELECT t.id, t.unit AS number, t.kind, coalesce(o.name, od."firstName" || ' ' || od."lastName") AS owner FROM driver_trucks t
   LEFT JOIN truck_owners o ON o.id = t."ownerId" LEFT JOIN drivers od ON od.id = t."driverId" JOIN drivers d ON d.id = $1
   WHERE t."archivedAt" IS NULL AND t."outOfServiceAt" IS NULL AND t.kind <> 'TRAILER' AND (CASE WHEN d."driverType" = 'OWNER_OPERATOR' THEN t."driverId" = d.id ELSE t."driverId" IS NULL END) ORDER BY lower(t.unit) LIMIT 3000`, [driverId]);
  return { steps: list, done: list.filter(done).length, total: list.length, ready: list.every(done), unit: input.unit, groupChanges: changes, sharing: sharing.map(row => row.name), choices };
 }

 async record(user: User, driverId: string, key: string, dto: ReadyStepDto) {
  if (!(MANUAL_STEPS as readonly string[]).includes(key)) throw new NotFoundException();
  return writeDriver(this.db, async em => {
   const driver = await this.lock(em, user, driverId, dto.version);
   if (driver.status !== 'CLEARED') throw new ConflictException('Ready for the road follows Cleared.');
   // Only the camera install waits on others (box photo, install video), so only it says what's happening (section 39).
   if (key === 'SAMSARA' && dto.status === 'IN_PROGRESS' && !dto.note?.trim()) throw new BadRequestException('Say what’s happening, for example Box photo posted, waiting for the install video.');
   await em.query(`INSERT INTO driver_road_ready_steps ("driverId", key, status, note, "updatedBy", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT ("driverId", key) DO UPDATE SET status = $3, note = $4, "updatedBy" = $5, "updatedAt" = now()`, [driverId, key, dto.status, dto.note?.trim() || null, user.id]);
   await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [driverId]);
   await driverEvent(em, user.id, driverId, 'ROAD_READY_RECORDED', { step: key, status: dto.status });
   return { id: driverId, version: driver.version + 1 };
  });
 }

 /** Safety's pick of the truck before Dispatch assigns one; once Dispatch has, Dispatch changes it. */
 async setUnit(user: User, driverId: string, dto: ReadyUnitDto) {
  return writeDriver(this.db, async em => {
   const driver = await this.lock(em, user, driverId, dto.version);
   if (driver.status !== 'CLEARED') throw new ConflictException('Ready for the road follows Cleared.');
   const [assigned] = await em.query(`SELECT 1 FROM driver_assignments WHERE "driverId" = $1 AND "endedAt" IS NULL AND "unitId" IS NOT NULL`, [driverId]) as unknown[];
   if (assigned) throw new ConflictException('Dispatch assigned this driver a truck. Dispatch changes it, with the driver’s other assignment details.');
   const [unit] = await em.query(`SELECT kind, "driverId", "archivedAt", "outOfServiceAt" FROM driver_trucks WHERE id = $1 FOR SHARE`, [dto.unitId]) as { kind: string; driverId: string | null; archivedAt: Date | null; outOfServiceAt: Date | null }[];
   if (!unit || unit.kind === 'TRAILER' || unit.archivedAt || unit.outOfServiceAt) throw new BadRequestException('Choose a truck in service from Units.');
   if (driver.driverType === 'OWNER_OPERATOR' ? unit.driverId !== driverId : !!unit.driverId) throw new BadRequestException(driver.driverType === 'OWNER_OPERATOR' ? 'An owner-operator drives their own truck. Choose one of theirs.' : 'This truck belongs to an owner-operator. Choose a truck owner’s truck.');
   await em.query(`UPDATE driver_road_ready SET "unitId" = $2 WHERE "driverId" = $1`, [driverId, dto.unitId]);
   await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [driverId]);
   await driverEvent(em, user.id, driverId, 'ROAD_READY_RECORDED', { step: 'UNIT', status: 'COMPLETED' });
   return { id: driverId, version: driver.version + 1 };
  });
 }

 async groupDone(user: User, driverId: string, changeId: string, dto: GroupDoneDto) {
  return writeDriver(this.db, async em => {
   const driver = await this.lock(em, user, driverId, dto.version, true);
   const [change] = await em.query(`SELECT "doneAt" FROM telegram_group_changes WHERE id = $1 AND "driverId" = $2 FOR UPDATE`, [changeId, driverId]) as { doneAt: Date | null }[];
   if (!change) throw new NotFoundException('This group change no longer exists.');
   if (change.doneAt) throw new ConflictException('Someone already marked this group updated.');
   await em.query(`UPDATE telegram_group_changes SET "doneAt" = now(), "doneBy" = $2 WHERE id = $1`, [changeId, user.id]);
   await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [driverId]);
   await driverEvent(em, user.id, driverId, 'GROUP_UPDATED', {});
   return { id: driverId, version: driver.version + 1 };
  });
 }

 /** Locks the driver; leads, the Safety Director, administrators and the driver's Safety Manager. A driver who left still has group changes to finish. */
 private async lock(em: EntityManager, user: User, driverId: string, version: number, closedToo = false) {
  const driver = closedToo ? await em.query(`SELECT id, version, status, "driverType" FROM drivers WHERE id = $1 FOR UPDATE`, [driverId]).then(rows => (rows as { id: string; version: number; status: string; driverType: string }[])[0])
   : await lockOpenDriver(em, driverId, version);
  if (!driver) throw new NotFoundException('This driver record no longer exists.');
  if (driver.version !== version) throw new ConflictException('Someone else changed this driver. Reload and try again.');
  // After a driver leaves, their last Safety Manager still finishes the group updates their leaving asked for.
  const mine = closedToo && driver.status === 'LEFT' ? (await em.query(`SELECT "ownerId" FROM driver_owners WHERE "driverId" = $1 ORDER BY "startedAt" DESC, "createdAt" DESC LIMIT 1`, [driverId]) as { ownerId: string | null }[])[0]?.ownerId === user.id
   : await ownsDriver(em, user, driverId);
  if (!SCREENERS.includes(user.role) && !mine) throw new ForbiddenException('Only Safety leads, the Safety Director and the driver’s Safety Manager can do this.');
  if (!(await em.query(`SELECT 1 FROM driver_road_ready WHERE "driverId" = $1`, [driverId]) as unknown[]).length) throw new ConflictException('Ready for the road starts when the driver is cleared.');
  return driver;
 }
}
