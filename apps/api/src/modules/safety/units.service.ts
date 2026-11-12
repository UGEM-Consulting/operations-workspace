import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { changedRows } from '../../common/changed-rows';
import type { FileResult } from '../documents/documents.service';
import { sha256 } from '../documents/images';
import { onboardingLimit } from '../onboarding/rate-limit';
import { ownerContractKey, StorageService, unitFileKey } from '../storage/storage.service';
import { Role, User, UserStatus } from '../users/user.entity';
import { driverEvent, ownsDriver, SCREENERS } from './driver-records';
import { oneUpload, uploadedPdf } from './scan';
import { usDay } from './screening-rules';
import { OwnerContractDto, OwnerVersionDto, PERMITS_FOR, RenewPermitsDto, TruckOwnerDto, type UnitKind, UnitDatesDto, UnitDto, UnitFileDto, UnitResponsibleDto, UnitStatusDto } from './units.dto';
import { personName } from './sql';

// Unit numbers are checked and handed out under one lock, so two people can't add the same number at once.
export const UNIT_NUMBER_LOCK = 42002040;
const STALE = 'This unit changed since you opened it. Reload to see the latest, then try again.';
const OWNER_STALE = 'This owner changed since you opened it. Reload to see the latest, then try again.';
const clean = (value: string) => value.trim().replace(/\s+/g, ' '), nameKey = (value: string) => clean(value).toLowerCase();
type UnitRow = { id: string; unit: string; kind: UnitKind; driverId: string | null; ownerId: string | null; company: boolean; archivedAt: Date | null; outOfServiceAt: Date | null; responsibleId: string | null; version: number };
type Event = 'ADDED' | 'UPDATED' | 'DATES_RECORDED' | 'PERMITS_RENEWED' | 'FILE_ADDED' | 'FILE_VIEWED' | 'OUT_OF_SERVICE' | 'IN_SERVICE' | 'ARCHIVED' | 'RESPONSIBLE_CHANGED' | 'OWNER_ADDED' | 'OWNER_UPDATED' | 'OWNER_ARCHIVED'
 | 'CONTRACT_ADDED' | 'CONTRACT_VIEWED';

/** The permits a unit's type carries, as SQL (from PERMITS_FOR, so the lists live in one place). */
const permitsSql = (kind: string) => `CASE ${kind} ${Object.entries(PERMITS_FOR).map(([type, permits]) => `WHEN '${type}' THEN ARRAY[${permits.map(permit => `'${permit}'`).join(',')}]::text[]`).join(' ')} ELSE ARRAY[]::text[] END`;
/** Every unit date that can come due ($2 is this year's Dec 31: the year-end permits are left out, see expiringUnits). */
const UNIT_DUE = `WITH due AS (
   SELECT t.id, 'REGISTRATION' AS document, t."registrationExpiresOn" AS "dueOn" FROM driver_trucks t
    WHERE t."registrationExpiresOn" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM driver_owner_documents d WHERE d."truckId" = t.id AND d.kind = 'REGISTRATION' AND d."replacedAt" IS NULL)
   UNION ALL SELECT t.id, 'INSPECTION', (t."inspectedOn" + interval '1 year')::date FROM driver_trucks t WHERE t."inspectedOn" IS NOT NULL
   UNION ALL SELECT p."unitId", 'PERMIT:' || p.kind, p."expiresOn" FROM unit_permits p JOIN driver_trucks pt ON pt.id = p."unitId"
    WHERE p."expiresOn" <> $2::date AND p.kind = ANY(${permitsSql('pt.kind')}))`;

/**
 * Unit dates that have passed or come within `until` (ExpiringUnitsScreen): the registration (an owner-operator's truck
 * whose registration is on file with its lease and insurance is listed with the driver's documents instead), the yearly
 * inspection (due a year after the last one) and permits. Permits that end on Dec 31 this year are the year-end batch
 * (PermitsYearEndScreen), counted apart in `yearEnd` so dozens of rows don't fill the list.
 */
export async function expiringUnits(em: EntityManager, today: string, until: string) {
 const yearEnd = `${today.slice(0, 4)}-12-31`;
 const items: { unitId: string; number: string; kind: string; document: string; dueOn: string; responsibleId: string | null; responsible: string | null; owner: string | null; driverNow: string | null }[] = await em.query(`${UNIT_DUE}
  SELECT t.id AS "unitId", t.unit AS number, t.kind, d.document, to_char(d."dueOn", 'YYYY-MM-DD') AS "dueOn", t."responsibleId", ${personName('r')} AS responsible,
   coalesce(o.name, ${personName('od')}) AS owner,
   (SELECT string_agg(${personName('x')}, ' and ' ORDER BY x."lastName") FROM driver_assignments a JOIN drivers x ON x.id = a."driverId" WHERE a."endedAt" IS NULL AND x.status = 'CLEARED' AND (a."unitId" = t.id OR a."trailerId" = t.id)) AS "driverNow"
  FROM due d JOIN driver_trucks t ON t.id = d.id LEFT JOIN users r ON r.id = t."responsibleId" LEFT JOIN truck_owners o ON o.id = t."ownerId" LEFT JOIN drivers od ON od.id = t."driverId"
  WHERE t."archivedAt" IS NULL AND d."dueOn" <= $1::date ORDER BY d."dueOn", lower(t.unit)`, [until, yearEnd]);
 const [batch]: { due: number; units: number }[] = await em.query(`SELECT count(*)::int AS due, count(DISTINCT t.id)::int AS units FROM driver_trucks t
   CROSS JOIN LATERAL unnest(${permitsSql('t.kind')}) k(kind)
   LEFT JOIN unit_permits p ON p."unitId" = t.id AND p.kind = k.kind WHERE t."archivedAt" IS NULL AND (p."expiresOn" IS NULL OR p."expiresOn" = $1::date
    -- One on another date before the year end that the list above already shows isn't counted again.
    OR (p."expiresOn" < $1::date AND p."expiresOn" > $2::date))`, [yearEnd, until]);
 return { items: items.map(item => ({ ...item, expired: item.dueOn < today })), yearEnd: { on: yearEnd, due: batch?.due ?? 0, units: batch?.units ?? 0 } };
}

/** Trucks and trailers in service, for Dispatch's assignment: the number and type only, whose they are for an owner-operator,
 * and which drivers have them now (team drivers share a truck). */
export function unitChoices(em: EntityManager): Promise<{ id: string; number: string; kind: UnitKind; trailerType: string | null; driverId: string | null; withDrivers: string[] }[]> {
 return em.query(`SELECT t.id, t.unit AS number, t.kind, t."trailerType", t."driverId",
   coalesce((SELECT json_agg(a."driverId") FROM driver_assignments a JOIN drivers d ON d.id = a."driverId" WHERE a."endedAt" IS NULL AND d.status = 'CLEARED' AND (a."unitId" = t.id OR a."trailerId" = t.id)), '[]') AS "withDrivers"
  FROM driver_trucks t WHERE t."archivedAt" IS NULL AND t."outOfServiceAt" IS NULL ORDER BY t.kind = 'TRAILER', lower(t.unit) LIMIT 3000`);
}

/** Refuses a number another current unit has (compared ignoring case); call it under UNIT_NUMBER_LOCK. */
export async function numberFree(em: EntityManager, number: string, kind: UnitKind, unitId: string | null) {
 const [taken] = await em.query(`SELECT 1 FROM driver_trucks WHERE lower(unit) = lower($1) AND "archivedAt" IS NULL AND id <> $2 LIMIT 1`, [number, unitId ?? '00000000-0000-0000-0000-000000000000']) as unknown[];
 if (taken) throw new ConflictException(`Unit ${number} is already on the list. The next free number is ${await nextUnitNumber(em, kind)}.`);
}

/**
 * Whether a cleared driver has this unit: as truck or trailer on an open assignment, or as Safety's pick on Ready for the
 * road while Dispatch hasn't given them a truck (the acknowledgement and the group are for that truck).
 */
export async function assigned(em: EntityManager, unitId: string) {
 return (await em.query(`SELECT 1 FROM driver_assignments a JOIN drivers d ON d.id = a."driverId" WHERE a."endedAt" IS NULL AND d.status = 'CLEARED' AND (a."unitId" = $1 OR a."trailerId" = $1)
  UNION ALL SELECT 1 FROM driver_road_ready r JOIN drivers d ON d.id = r."driverId" WHERE r."unitId" = $1 AND d.status = 'CLEARED'
   AND NOT EXISTS(SELECT 1 FROM driver_assignments a WHERE a."driverId" = d.id AND a."endedAt" IS NULL AND a."unitId" IS NOT NULL) LIMIT 1`, [unitId]) as unknown[]).length > 0;
}

/** For the sidebar: how many unit dates expiringUnits lists, counted in the database (no names, no year-end batch). */
export async function expiringUnitsCount(em: EntityManager, today: string, until: string) {
 const [row]: { n: number }[] = await em.query(`${UNIT_DUE} SELECT count(*)::int AS n FROM due d JOIN driver_trucks t ON t.id = d.id WHERE t."archivedAt" IS NULL AND d."dueOn" <= $1::date`,
  [until, `${today.slice(0, 4)}-12-31`]);
 return row.n;
}

/** The next free number: the highest number used for that sort of unit, plus one (trucks plain digits, trailers T-<digits>). */
export async function nextUnitNumber(em: EntityManager, kind: UnitKind): Promise<string> {
 const trailer = kind === 'TRAILER';
 const [row]: { top: number | null }[] = await em.query(`SELECT max(substring(unit FROM '(\\d+)$')::bigint) AS top FROM driver_trucks
  WHERE (kind = 'TRAILER') = $1 AND unit ~ $2`, [trailer, trailer ? '^[Tt]-?\\d{1,9}$' : '^\\d{1,9}$']);
 const next = Number(row?.top ?? 0) + 1;
 return trailer ? `T-${next}` : String(next);
}

/**
 * Units (section 34, revised 2026-11-12): trucks and trailers with their owner, the dates that matter and an optional copy
 * of each paper. Every Safety role reads them; any Safety role may add one; changes are for Safety leads, the Safety
 * Director, administrators, the responsible Safety Manager and, for an owner-operator's truck, the driver's Safety Manager.
 * Every write locks the unit, checks its version and records a metadata-only event (field names, never values).
 */
@Injectable()
export class UnitsService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService) {}

 /** Every unit (archived ones too, marked) for the Units page; the page filters. */
 async list() {
  const items = await this.db.query(`SELECT t.id, t.unit AS number, t.kind, t."trailerType", t.year, t.make, t.vin, t.plate, t."plateState", t.version,
    CASE WHEN t.company THEN 'COMPANY' WHEN t."ownerId" IS NOT NULL THEN 'OWNER' ELSE 'DRIVER' END AS "ownerKind", t."ownerId", t."driverId",
    coalesce(o.name, ${personName('od')}) AS owner, to_char(coalesce(reg."expiresOn", t."registrationExpiresOn"), 'YYYY-MM-DD') AS "registrationExpiresOn",
    to_char(t."inspectedOn", 'YYYY-MM-DD') AS "inspectedOn", t."outOfServiceAt", t."archivedAt", t."responsibleId", ${personName('r')} AS responsible,
    coalesce((SELECT json_agg(json_build_object('kind', p.kind, 'expiresOn', to_char(p."expiresOn", 'YYYY-MM-DD'))) FROM unit_permits p WHERE p."unitId" = t.id), '[]') AS permits,
    (SELECT string_agg(${personName('d')}, ' and ' ORDER BY d."lastName") FROM driver_assignments a JOIN drivers d ON d.id = a."driverId"
      WHERE a."endedAt" IS NULL AND d.status = 'CLEARED' AND (a."unitId" = t.id OR a."trailerId" = t.id)) AS "driverNow"
   FROM driver_trucks t LEFT JOIN truck_owners o ON o.id = t."ownerId" LEFT JOIN drivers od ON od.id = t."driverId" LEFT JOIN users r ON r.id = t."responsibleId"
   LEFT JOIN driver_owner_documents reg ON reg."truckId" = t.id AND reg.kind = 'REGISTRATION' AND reg."replacedAt" IS NULL
   ORDER BY (t."archivedAt" IS NOT NULL), t.kind = 'TRAILER', lower(t.unit) LIMIT 3000`);
  const em = this.db.manager;
  // What the Add unit form picks from: truck owners, approved or cleared owner-operators and Safety Managers.
  const [owners, operators, staff] = await Promise.all([
   em.query(`SELECT id, name FROM truck_owners WHERE "archivedAt" IS NULL ORDER BY "nameKey"`),
   em.query(`SELECT id, ${personName('d')} AS name FROM drivers d WHERE d."driverType" = 'OWNER_OPERATOR' AND d.status IN ('APPROVED','CLEARED') ORDER BY lower(d."lastName"), lower(d."firstName")`),
   em.query(`SELECT id, ${personName('u')} AS name FROM users u WHERE u.status = 'ACTIVE' AND u.role::text = 'SAFETY_STAFF' ORDER BY lower(u."firstName"), lower(u."lastName")`)]);
  return { today: usDay('latest'), items, next: { truck: await nextUnitNumber(em, 'SEMI'), trailer: await nextUnitNumber(em, 'TRAILER') }, permitsFor: PERMITS_FOR, choices: { owners, operators, staff } };
 }

 /** One unit's page: details, dates, permits, files, who drove or pulled it, and its history (values never kept there). */
 async unit(id: string) {
  const [unit] = await this.db.query(`SELECT t.id, t.unit AS number, t.kind, t."trailerType", t.year, t.make, t.vin, t.plate, t."plateState", t.version, t."ownerId", t."driverId", t.company,
    CASE WHEN t.company THEN 'COMPANY' WHEN t."ownerId" IS NOT NULL THEN 'OWNER' ELSE 'DRIVER' END AS "ownerKind", coalesce(o.name, ${personName('od')}) AS owner,
    to_char(coalesce(reg."expiresOn", t."registrationExpiresOn"), 'YYYY-MM-DD') AS "registrationExpiresOn", to_char(t."inspectedOn", 'YYYY-MM-DD') AS "inspectedOn",
    t."outOfServiceAt", t."archivedAt", t."createdAt", t."responsibleId", ${personName('r')} AS responsible
   FROM driver_trucks t LEFT JOIN truck_owners o ON o.id = t."ownerId" LEFT JOIN drivers od ON od.id = t."driverId" LEFT JOIN users r ON r.id = t."responsibleId"
   LEFT JOIN driver_owner_documents reg ON reg."truckId" = t.id AND reg.kind = 'REGISTRATION' AND reg."replacedAt" IS NULL WHERE t.id = $1`, [id]);
  if (!unit) throw new NotFoundException('This unit is no longer on the list.');
  const [permits, files, drivers, trailerNow, events, ownerDocuments] = await Promise.all([
   this.db.query(`SELECT kind, to_char("expiresOn", 'YYYY-MM-DD') AS "expiresOn" FROM unit_permits WHERE "unitId" = $1`, [id]),
   this.db.query(`SELECT f.id, f.kind, f."pageCount", f."createdAt", ${personName('u')} AS "uploadedBy" FROM unit_files f LEFT JOIN users u ON u.id = f."uploadedBy" WHERE f."unitId" = $1 AND f."replacedAt" IS NULL ORDER BY f."createdAt"`, [id]),
   // From Dispatch's assignments: who drove the truck or pulled the trailer, newest first.
   this.db.query(`SELECT a.id, a."driverId", ${personName('d')} AS driver, a."startedAt", a."endedAt", ${personName('x')} AS dispatcher, m.name AS mc
    FROM driver_assignments a JOIN drivers d ON d.id = a."driverId" JOIN dispatch_members x ON x.id = a."memberId" JOIN mcs m ON m.id = a."mcId"
    WHERE a."unitId" = $1 OR a."trailerId" = $1 ORDER BY a."startedAt" DESC LIMIT 50`, [id]),
   this.db.query(`SELECT DISTINCT tr.id, tr.unit AS number, tr."trailerType" FROM driver_assignments a JOIN driver_trucks tr ON tr.id = a."trailerId" WHERE a."unitId" = $1 AND a."endedAt" IS NULL`, [id]),
   this.db.query(`SELECT e.id, e.event, e.metadata, e."createdAt", ${personName('u')} AS actor FROM unit_events e LEFT JOIN users u ON u.id = e."actorId" WHERE e."unitId" = $1 ORDER BY e."createdAt" DESC LIMIT 100`, [id]),
   // An owner-operator's truck keeps its lease and insurance from section 33.
   this.db.query(`SELECT id, kind, to_char("expiresOn", 'YYYY-MM-DD') AS "expiresOn", "pageCount", "createdAt" FROM driver_owner_documents WHERE "truckId" = $1 AND "replacedAt" IS NULL`, [id]),
  ]);
  return { ...unit, today: usDay('latest'), permitsNeeded: PERMITS_FOR[unit.kind as UnitKind], permits, files, drivers, trailerNow, events, ownerDocuments, storageEnabled: this.storage.enabled };
 }

 async create(user: User, dto: UnitDto) {
  return this.db.transaction(async em => {
   await this.lockOperators(em, user, [dto.driverId]);
   await em.query('SELECT pg_advisory_xact_lock($1)', [UNIT_NUMBER_LOCK]);
   await this.checkUnit(em, dto, null);
   const id = await insertUnit(em, user, { number: dto.number, kind: dto.kind, ownerId: dto.ownerId ?? null, driverId: dto.driverId ?? null, company: dto.company === true, vin: dto.vin, year: dto.year,
    make: dto.make, plate: dto.plate || null, plateState: dto.plateState || null, trailerType: dto.trailerType || null, registrationExpiresOn: dto.registrationExpiresOn || null,
    inspectedOn: dto.inspectedOn || null, responsibleId: dto.responsibleId ?? null });
   return { id, version: 1 };
  });
 }

 async update(user: User, id: string, dto: UnitDto) {
  // An owner-operator's truck is also on their driver record: their row is locked first, as TruckService does.
  const [stored] = await this.db.query(`SELECT "driverId" FROM driver_trucks WHERE id = $1`, [id]) as { driverId: string | null }[];
  return this.write(user, id, dto.version, async (em, unit) => {
   if (unit.driverId !== (stored?.driverId ?? null)) throw new ConflictException(STALE);
   if (unit.archivedAt) throw new ConflictException('This unit is archived.');
   await em.query('SELECT pg_advisory_xact_lock($1)', [UNIT_NUMBER_LOCK]);
   await this.checkUnit(em, dto, unit);
   // A driver's assignment names this unit as a truck or a trailer, with its owner's rules and its type's permits.
   const sameOwner = (dto.ownerId ?? null) === unit.ownerId && (dto.driverId ?? null) === unit.driverId && (dto.company === true) === unit.company;
   if ((dto.kind !== unit.kind || !sameOwner) && await assigned(em, id)) throw new ConflictException('A driver has this unit now, so its type and owner stay. Ask Dispatch to change their unit first.');
   // Only what really changed is recorded; a save with nothing new keeps the version, so other open pages stay current.
   const [now] = await em.query(`SELECT vin, year, make, plate, "plateState", "trailerType" FROM driver_trucks WHERE id = $1`, [id]) as { vin: string; year: number; make: string; plate: string | null; plateState: string | null; trailerType: string | null }[];
   const next = { number: dto.number, kind: dto.kind, vin: dto.vin, year: dto.year, make: dto.make, plate: dto.plate || null, plateState: dto.plateState || null, trailerType: dto.kind === 'TRAILER' ? dto.trailerType || null : null };
   const before = { number: unit.unit, kind: unit.kind, vin: now.vin, year: now.year, make: now.make, plate: now.plate, plateState: now.plateState, trailerType: now.trailerType };
   const changed = [...(Object.keys(next) as (keyof typeof next)[]).filter(key => next[key] !== before[key]), ...(sameOwner ? [] : ['owner'])];
   if (!changed.length) return { id, version: unit.version };
   // A truck moving to another owner leaves the former owner-operator's lease, insurance and registration behind (kept,
   // marked replaced), so their reminders stop and the unit's own registration date shows again.
   if (unit.driverId && unit.driverId !== (dto.driverId ?? null))
    await em.query(`UPDATE driver_owner_documents SET "replacedAt" = now() WHERE "truckId" = $1 AND "replacedAt" IS NULL`, [id]);
   await em.query(`UPDATE driver_trucks SET unit = $2, kind = $3, "ownerId" = $4, "driverId" = $5, company = $6, vin = $7, year = $8, make = $9, plate = $10, "plateState" = $11, "trailerType" = $12,
     version = version + 1, "updatedAt" = now() WHERE id = $1`,
    [id, dto.number, dto.kind, dto.ownerId ?? null, dto.driverId ?? null, dto.company === true, dto.vin, dto.year, dto.make, dto.plate || null, dto.plateState || null, dto.kind === 'TRAILER' ? dto.trailerType || null : null]).catch(duplicate);
   // A new type carries its own permits: dates of ones it doesn't carry go, so they stop showing and reminding.
   const removed = dto.kind === unit.kind ? 0 : await changedRows(em, `DELETE FROM unit_permits WHERE "unitId" = $1 AND NOT (kind = ANY($2::text[]))`, [id, PERMITS_FOR[dto.kind]]);
   await this.event(em, user, { unitId: id }, 'UPDATED', { fields: changed, ...(removed ? { permitsRemoved: removed } : {}) });
   for (const driverId of new Set([unit.driverId, dto.driverId ?? null])) if (driverId) await this.operatorChanged(em, user, driverId, driverId === dto.driverId ? 'updated' : 'moved');
   return { id, version: unit.version + 1 };
  }, [stored?.driverId, dto.driverId]);
 }

 /** Update dates (UnitProfileScreen's main button): the registration, the yearly inspection and the permits its type carries. */
 async dates(user: User, id: string, dto: UnitDatesDto) {
  return this.write(user, id, dto.version, async (em, unit) => {
   if (unit.archivedAt) throw new ConflictException('This unit is archived.');
   const fields: string[] = [], today = usDay('latest');
   if (dto.inspectedOn && dto.inspectedOn > today) throw new BadRequestException('The inspection date can’t be in the future.');
   // An owner-operator's registration on file with the lease and insurance is the date that counts (Expiring documents
   // reads it), so it is changed by uploading the new one there.
   if (dto.registrationExpiresOn !== undefined && (await em.query(`SELECT 1 FROM driver_owner_documents WHERE "truckId" = $1 AND kind = 'REGISTRATION' AND "replacedAt" IS NULL`, [id]) as unknown[]).length)
    throw new ConflictException('This registration is on file with the owner-operator’s lease and insurance. Upload the new registration on the driver’s page.');
   if (dto.registrationExpiresOn !== undefined) { await em.query(`UPDATE driver_trucks SET "registrationExpiresOn" = $2 WHERE id = $1`, [id, dto.registrationExpiresOn || null]); fields.push('registration'); }
   if (dto.inspectedOn !== undefined) { await em.query(`UPDATE driver_trucks SET "inspectedOn" = $2 WHERE id = $1`, [id, dto.inspectedOn || null]); fields.push('inspection'); }
   for (const permit of dto.permits ?? []) {
    if (!PERMITS_FOR[unit.kind].includes(permit.kind)) throw new BadRequestException('A permit this type of unit doesn’t carry can’t be recorded.');
    await em.query(`INSERT INTO unit_permits ("unitId", kind, "expiresOn", "updatedBy") VALUES ($1, $2, $3, $4) ON CONFLICT ("unitId", kind) DO UPDATE SET "expiresOn" = $3, "updatedBy" = $4, "updatedAt" = now()`,
     [id, permit.kind, permit.expiresOn, user.id]);
   }
   if (dto.permits?.length) fields.push('permits');
   if (!fields.length) return { id, version: unit.version };
   await em.query(`UPDATE driver_trucks SET version = version + 1, "updatedAt" = now() WHERE id = $1`, [id]);
   await this.event(em, user, { unitId: id }, 'DATES_RECORDED', { fields, permits: dto.permits?.length ?? 0 });
   return { id, version: unit.version + 1 };
  });
 }

 async status(user: User, id: string, dto: UnitStatusDto) {
  return this.write(user, id, dto.version, async (em, unit) => {
   if (unit.archivedAt) throw new ConflictException('This unit is archived.');
   let change: string;
   if (dto.status === 'ARCHIVED') {
    if (await assigned(em, id)) throw new ConflictException('A driver still has this unit. Ask Dispatch to change their unit first.');
    change = '"archivedAt" = now()';
   } else if (dto.status === 'OUT_OF_SERVICE') {
    if (unit.outOfServiceAt) throw new ConflictException('This unit is already out of service.');
    change = '"outOfServiceAt" = now()';
   } else {
    if (!unit.outOfServiceAt) throw new ConflictException('This unit is already in service.');
    change = '"outOfServiceAt" = NULL';
   }
   await em.query(`UPDATE driver_trucks SET ${change}, version = version + 1, "updatedAt" = now() WHERE id = $1`, [id]);
   await this.event(em, user, { unitId: id }, dto.status === 'ARCHIVED' ? 'ARCHIVED' : dto.status, {});
   return { id, version: unit.version + 1 };
  });
 }

 async responsible(user: User, id: string, dto: UnitResponsibleDto) {
  return this.write(user, id, dto.version, async (em, unit) => {
   if (unit.archivedAt) throw new ConflictException('This unit is archived.');
   await this.safetyManager(em, dto.responsibleId);
   if (unit.responsibleId === dto.responsibleId) return { id, version: unit.version };
   await em.query(`UPDATE driver_trucks SET "responsibleId" = $2, version = version + 1, "updatedAt" = now() WHERE id = $1`, [id, dto.responsibleId]);
   await this.event(em, user, { unitId: id }, 'RESPONSIBLE_CHANGED', {});
   return { id, version: unit.version + 1 };
  });
 }

 /** An optional copy of a paper, stored before the transaction (checks first), replacing the current copy of its kind. */
 async upload(user: User, id: string, dto: UnitFileDto) {
  if (!this.storage.enabled) throw new ServiceUnavailableException('Uploads aren’t available right now.');
  const upload = oneUpload(dto, 'Add the paper: a PDF or photos of its pages.');
  await this.mayChange(this.db.manager, user, await this.load(this.db.manager, id, false));
  await onboardingLimit(this.db, `unit-file:${user.id}`, 30, 3600);
  const { body, pageCount } = await uploadedPdf(upload, 30);
  const stored = { id: randomUUID(), kind: dto.kind, unitId: id };
  await this.storage.put(unitFileKey(stored), body, 'application/pdf');
  try {
   return await this.write(user, id, dto.version, async (em, unit) => {
    if (unit.archivedAt) throw new ConflictException('This unit is archived.');
    await em.query(`UPDATE unit_files SET "replacedAt" = now() WHERE "unitId" = $1 AND kind = $2 AND "replacedAt" IS NULL`, [id, dto.kind]);
    await em.query(`INSERT INTO unit_files (id, "unitId", kind, "pageCount", sha256, "byteSize", "uploadedBy") VALUES ($1, $2, $3, $4, $5, $6, $7)`, [stored.id, id, dto.kind, pageCount, sha256(body), body.length, user.id]);
    await em.query(`UPDATE driver_trucks SET version = version + 1, "updatedAt" = now() WHERE id = $1`, [id]);
    await this.event(em, user, { unitId: id }, 'FILE_ADDED', { kind: dto.kind, pages: pageCount });
    return { id, version: unit.version + 1 };
   });
  } catch (error) { await this.storage.remove(unitFileKey(stored)); throw error; }
 }

 async file(user: User, id: string, fileId: string): Promise<FileResult> {
  await onboardingLimit(this.db, `unit-file-view:${user.id}`, 60, 900);
  const [row] = await this.db.query(`SELECT id, kind, "unitId" FROM unit_files WHERE id = $1 AND "unitId" = $2`, [fileId, id]) as { id: string; kind: string; unitId: string }[];
  if (!row) throw new NotFoundException('This file no longer exists.');
  const body = await this.storage.get(unitFileKey(row));
  await this.event(this.db.manager, user, { unitId: id }, 'FILE_VIEWED', { kind: row.kind });
  return { body, type: 'application/pdf', filename: `${row.kind.toLowerCase()}.pdf` };
 }

 /** Permits for the year (PermitsYearEndScreen): every truck and pickup in use, with each permit its type carries. */
 async permits() {
  const today = usDay('latest'), yearEnd = `${today.slice(0, 4)}-12-31`;
  const items = await this.db.query(`SELECT t.id, t.unit AS number, t.kind, coalesce(o.name, ${personName('od')}) AS owner, t."responsibleId",
    coalesce((SELECT json_agg(json_build_object('kind', p.kind, 'expiresOn', to_char(p."expiresOn", 'YYYY-MM-DD'))) FROM unit_permits p WHERE p."unitId" = t.id), '[]') AS permits
   FROM driver_trucks t LEFT JOIN truck_owners o ON o.id = t."ownerId" LEFT JOIN drivers od ON od.id = t."driverId"
   WHERE t."archivedAt" IS NULL AND t.kind IN ('SEMI','PICKUP') ORDER BY lower(t.unit)`);
  return { today, yearEnd, permitsFor: PERMITS_FOR, items };
 }

 /** Marks the chosen units' permits renewed together, with the new expiration (after today). */
 async renewPermits(user: User, dto: RenewPermitsDto) {
  if (dto.expiresOn <= usDay('latest')) throw new BadRequestException('The new expiration has to be after today.');
  return this.db.transaction(async em => {
   let count = 0;
   for (const id of [...new Set(dto.unitIds)].sort()) {
    const unit = await this.load(em, id, true);
    if (unit.archivedAt) throw new ConflictException(`Unit ${unit.unit} is archived.`);
    await this.mayChange(em, user, unit);
    const kinds = (dto.kinds ?? PERMITS_FOR[unit.kind]).filter(kind => PERMITS_FOR[unit.kind].includes(kind));
    for (const kind of kinds) await em.query(`INSERT INTO unit_permits ("unitId", kind, "expiresOn", "updatedBy") VALUES ($1, $2, $3, $4) ON CONFLICT ("unitId", kind) DO UPDATE SET "expiresOn" = $3, "updatedBy" = $4, "updatedAt" = now()`,
     [id, kind, dto.expiresOn, user.id]);
    if (!kinds.length) continue;
    await em.query(`UPDATE driver_trucks SET version = version + 1, "updatedAt" = now() WHERE id = $1`, [id]);
    await this.event(em, user, { unitId: id }, 'PERMITS_RENEWED', { count: kinds.length });
    count += kinds.length;
   }
   return { renewed: count };
  });
 }

 // ── Truck owners ─────────────────────────────────────────────────────────────────────────────────────────────────
 /** Truck owners with their trucks and drivers, and owner-operators as their own owner (TruckOwnersScreen). */
 async owners() {
  const companies = await this.db.query(`SELECT o.id, o.name, o."signerName", o.email, o.phone, o."archivedAt", o.version, 'OWNER' AS kind,
    (SELECT count(*)::int FROM driver_trucks t WHERE t."ownerId" = o.id AND t."archivedAt" IS NULL) AS trucks,
    (SELECT count(DISTINCT a."driverId")::int FROM driver_assignments a JOIN driver_trucks t ON t.id = a."unitId" JOIN drivers d ON d.id = a."driverId" WHERE t."ownerId" = o.id AND a."endedAt" IS NULL AND d.status = 'CLEARED') AS drivers
   FROM truck_owners o ORDER BY (o."archivedAt" IS NOT NULL), o."nameKey"`);
  const operators = await this.db.query(`SELECT d.id, ${personName('d')} AS name, 'DRIVER' AS kind, count(t.id)::int AS trucks, 1 AS drivers
   FROM drivers d JOIN driver_trucks t ON t."driverId" = d.id AND t."archivedAt" IS NULL WHERE d.status IN ('APPROVED','CLEARED') GROUP BY d.id ORDER BY lower(d."lastName"), lower(d."firstName")`);
  return { items: [...companies, ...operators] };
 }
 async owner(id: string) {
  const [owner] = await this.db.query(`SELECT id, name, "signerName", "signerTitle", email, phone, "archivedAt", version, "createdAt" FROM truck_owners WHERE id = $1`, [id]);
  if (!owner) throw new NotFoundException('This owner is no longer on the list.');
  const trucks = await this.db.query(`SELECT t.id, t.unit AS number, t.kind, t.year, t.make, t."archivedAt",
    (SELECT string_agg(${personName('d')}, ' and ' ORDER BY d."lastName") FROM driver_assignments a JOIN drivers d ON d.id = a."driverId" WHERE a."unitId" = t.id AND a."endedAt" IS NULL AND d.status = 'CLEARED') AS "driverNow"
   FROM driver_trucks t WHERE t."ownerId" = $1 ORDER BY (t."archivedAt" IS NOT NULL), lower(t.unit)`, [id]);
  const events = await this.db.query(`SELECT e.id, e.event, e.metadata, e."createdAt", ${personName('u')} AS actor FROM unit_events e LEFT JOIN users u ON u.id = e."actorId" WHERE e."ownerId" = $1 ORDER BY e."createdAt" DESC LIMIT 50`, [id]);
  // Contracts signed on paper (current ones; a replaced copy stays stored) and, per truck, where its acknowledgement stands.
  const [contracts, acknowledgements] = await Promise.all([
   this.db.query(`SELECT f.id, f.kind, f.title, to_char(f."signedOn", 'YYYY-MM-DD') AS "signedOn", f."pageCount", f."createdAt", t.unit, ${personName('u')} AS "uploadedBy"
    FROM owner_contract_files f LEFT JOIN driver_trucks t ON t.id = f."unitId" LEFT JOIN users u ON u.id = f."uploadedBy" WHERE f."ownerId" = $1 AND f."replacedAt" IS NULL ORDER BY f."signedOn" DESC`, [id]),
   this.db.query(`SELECT DISTINCT ON (c."unitId") c."unitId", c."driverSignedAt", c."ownerSignedAt" FROM driver_contracts c WHERE c."ownerId" = $1 AND c."cancelledAt" IS NULL ORDER BY c."unitId", c."createdAt" DESC`, [id]) as Promise<{ unitId: string; driverSignedAt: Date | null; ownerSignedAt: Date | null }[]>]);
  const acknowledgement = (unitId: string) => { const row = acknowledgements.find(item => item.unitId === unitId); return row ? row.ownerSignedAt ? 'SIGNED' : row.driverSignedAt ? 'OWNER_TO_SIGN' : 'DRIVER_TO_SIGN' : null; };
  return { ...owner, trucks: trucks.map((truck: { id: string }) => ({ ...truck, acknowledgement: acknowledgement(truck.id) })), events, contracts, storageEnabled: this.storage.enabled };
 }
 /** A contract signed on paper, stored before the transaction; a newer copy of the same kind (and truck) replaces it, and both stay. */
 async uploadContract(user: User, ownerId: string, dto: OwnerContractDto) {
  if (!this.storage.enabled) throw new ServiceUnavailableException('Uploads aren’t available right now.');
  if (dto.signedOn > usDay('latest')) throw new BadRequestException('The date signed can’t be in the future.');
  if (dto.kind === 'OTHER' && !dto.title) throw new BadRequestException('Name the contract, for example Addendum.');
  const upload = oneUpload(dto, 'Add the signed contract: a PDF or photos of its pages.');
  // Checked again under the owner lock; this early check keeps someone who'd be refused from storing a file first.
  await this.mayChangeOwner(this.db.manager, user, ownerId);
  await onboardingLimit(this.db, `owner-contract:${user.id}`, 30, 3600);
  const { body, pageCount } = await uploadedPdf(upload, 60);
  const stored = { id: randomUUID(), kind: dto.kind, ownerId };
  await this.storage.put(ownerContractKey(stored), body, 'application/pdf');
  try {
   return await this.db.transaction(async em => {
    const owner = await this.lockOwner(em, ownerId, dto.version);
    await this.mayChangeOwner(em, user, ownerId);
    if (owner.archivedAt) throw new ConflictException('This owner is archived.');
    if (dto.unitId && !(await em.query(`SELECT 1 FROM driver_trucks WHERE id = $1 AND "ownerId" = $2`, [dto.unitId, ownerId]) as unknown[]).length) throw new BadRequestException('Choose one of this owner’s trucks.');
    if (dto.kind !== 'OTHER') await em.query(`UPDATE owner_contract_files SET "replacedAt" = now() WHERE "ownerId" = $1 AND kind = $2 AND "unitId" IS NOT DISTINCT FROM $3 AND "replacedAt" IS NULL`, [ownerId, dto.kind, dto.unitId ?? null]);
    await em.query(`INSERT INTO owner_contract_files (id, "ownerId", kind, title, "unitId", "signedOn", "pageCount", sha256, "byteSize", "uploadedBy") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
     [stored.id, ownerId, dto.kind, dto.kind === 'OTHER' ? dto.title : null, dto.unitId ?? null, dto.signedOn, pageCount, sha256(body), body.length, user.id]);
    await em.query(`UPDATE truck_owners SET version = version + 1, "updatedAt" = now() WHERE id = $1`, [ownerId]);
    await this.event(em, user, { ownerId }, 'CONTRACT_ADDED', { kind: dto.kind, pages: pageCount });
    return { id: ownerId, version: owner.version + 1 };
   });
  } catch (error) { await this.storage.remove(ownerContractKey(stored)); throw error; }
 }
 async contractFile(user: User, ownerId: string, fileId: string): Promise<FileResult> {
  await onboardingLimit(this.db, `owner-contract-view:${user.id}`, 60, 900);
  const [row] = await this.db.query(`SELECT id, kind, "ownerId" FROM owner_contract_files WHERE id = $1 AND "ownerId" = $2`, [fileId, ownerId]) as { id: string; kind: string; ownerId: string }[];
  if (!row) throw new NotFoundException('This contract no longer exists.');
  const body = await this.storage.get(ownerContractKey(row));
  await this.event(this.db.manager, user, { ownerId }, 'CONTRACT_VIEWED', { kind: row.kind });
  return { body, type: 'application/pdf', filename: `${row.kind.toLowerCase().replace(/_/g, '-')}.pdf` };
 }
 async createOwner(user: User, dto: TruckOwnerDto) {
  return this.db.transaction(async em => {
   return { id: await insertOwner(em, user, dto), version: 1 };
  });
 }
 async updateOwner(user: User, id: string, dto: TruckOwnerDto) {
  return this.db.transaction(async em => {
   const owner = await this.lockOwner(em, id, dto.version);
   await this.mayChangeOwner(em, user, id);
   const [now] = await em.query(`SELECT name, "signerName", "signerTitle", email, phone FROM truck_owners WHERE id = $1`, [id]) as Record<'name' | 'signerName' | 'signerTitle' | 'email' | 'phone', string | null>[];
   const next = { name: clean(dto.name), signerName: dto.signerName || null, signerTitle: dto.signerTitle || null, email: dto.email || null, phone: dto.phone || null };
   // Only what really changed is recorded; a save with nothing new keeps the version.
   const fields = (Object.keys(next) as (keyof typeof next)[]).filter(key => next[key] !== now[key]);
   if (!fields.length) return { id, version: owner.version };
   // An open signing link is bound to the email it went to: a corrected address stops it, and Safety sends a new one.
   const linksStopped = (now.email ?? '').toLowerCase() !== (next.email ?? '').toLowerCase() ? await changedRows(em, `UPDATE driver_links l SET "revokedAt" = now() FROM driver_contracts c
     WHERE c.id = l."contractId" AND c."ownerId" = $1 AND l.purpose = 'CONTRACT_OWNER' AND l."revokedAt" IS NULL AND l."completedAt" IS NULL`, [id]) : 0;
   await em.query(`UPDATE truck_owners SET name = $2, "nameKey" = $3, "signerName" = $4, "signerTitle" = $5, email = $6, phone = $7, version = version + 1, "updatedAt" = now() WHERE id = $1`,
    [id, next.name, nameKey(dto.name), next.signerName, next.signerTitle, next.email, next.phone]).catch(duplicateOwner);
   await this.event(em, user, { ownerId: id }, 'OWNER_UPDATED', { fields, ...(linksStopped ? { linksStopped } : {}) });
   return { id, version: owner.version + 1 };
  });
 }
 async archiveOwner(user: User, id: string, dto: OwnerVersionDto) {
  if (!SCREENERS.includes(user.role)) throw new ForbiddenException('Only Safety leads, the Safety Director and administrators can archive an owner.');
  return this.db.transaction(async em => {
   const owner = await this.lockOwner(em, id, dto.version);
   if (owner.archivedAt) throw new ConflictException('This owner is already archived.');
   const [busy] = await em.query(`SELECT 1 FROM driver_trucks WHERE "ownerId" = $1 AND "archivedAt" IS NULL LIMIT 1`, [id]) as unknown[];
   if (busy) throw new ConflictException('Archive or move this owner’s trucks first.');
   await em.query(`UPDATE truck_owners SET "archivedAt" = now(), version = version + 1 WHERE id = $1`, [id]);
   await this.event(em, user, { ownerId: id }, 'OWNER_ARCHIVED', {});
   return { id, version: owner.version + 1 };
  });
 }

 // ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
 private async write<T>(user: User, id: string, version: number | undefined, work: (em: EntityManager, unit: UnitRow) => Promise<T>, operators: (string | null | undefined)[] = []) {
  if (!version) throw new BadRequestException('Reload the unit and try again.');
  return this.db.transaction(async em => {
   await this.lockOperators(em, user, operators);
   const unit = await this.load(em, id, true);
   if (unit.version !== version) throw new ConflictException(STALE);
   await this.mayChange(em, user, unit);
   return work(em, unit);
  });
 }
 /**
  * The shared owner-operator rules (below), which the file import uses too.
  */
 private lockOperators(em: EntityManager, user: User, driverIds: (string | null | undefined)[]) { return lockOperators(em, user, driverIds); }
 private operatorChanged(em: EntityManager, user: User, driverId: string, action: 'added' | 'updated' | 'moved') { return operatorChanged(em, user, driverId, action); }
 private async load(em: EntityManager, id: string, lock: boolean): Promise<UnitRow> {
  const [unit] = await em.query(`SELECT id, unit, kind, "driverId", "ownerId", company, "archivedAt", "outOfServiceAt", "responsibleId", version FROM driver_trucks WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]) as UnitRow[];
  if (!unit) throw new NotFoundException('This unit is no longer on the list.');
  return unit;
 }
 /** Safety leads, the Safety Director, administrators, the responsible Safety Manager, and the Safety Manager of an owner-operator's driver. */
 private async mayChange(em: EntityManager, user: User, unit: UnitRow) {
  if (SCREENERS.includes(user.role) || unit.responsibleId === user.id) return;
  if (unit.driverId && (await em.query(`SELECT 1 FROM driver_owners WHERE "driverId" = $1 AND "ownerId" = $2 AND "endedAt" IS NULL`, [unit.driverId, user.id]) as unknown[]).length) return;
  throw new ForbiddenException('Only Safety leads, the Safety Director, administrators and the unit’s responsible Safety Manager can change it.');
 }
 /**
  * A truck owner's details (their email decides where the signing link goes) and signed contracts: Safety leads, the
  * Safety Director, administrators, and a Safety Manager responsible for one of the owner's current trucks or for a
  * driver who drives one (Dispatch's assignment or Safety's pick). Anyone in Safety may still add a new owner.
  */
 private async mayChangeOwner(em: EntityManager, user: User, ownerId: string) {
  if (SCREENERS.includes(user.role)) return;
  const [theirs] = await em.query(`SELECT 1 FROM driver_trucks t WHERE t."ownerId" = $1 AND t."archivedAt" IS NULL AND (t."responsibleId" = $2
    OR EXISTS(SELECT 1 FROM driver_owners w WHERE w."ownerId" = $2 AND w."endedAt" IS NULL AND (
     EXISTS(SELECT 1 FROM driver_assignments a WHERE a."driverId" = w."driverId" AND a."endedAt" IS NULL AND a."unitId" = t.id)
     OR EXISTS(SELECT 1 FROM driver_road_ready r WHERE r."driverId" = w."driverId" AND r."unitId" = t.id)))) LIMIT 1`, [ownerId, user.id]) as unknown[];
  if (!theirs) throw new ForbiddenException('Only Safety leads, the Safety Director, administrators and the Safety Manager of one of this owner’s trucks or its driver can change the owner.');
 }
 /** The owner fits the type, the number is free among current units, and the people and owner named exist. */
 private async checkUnit(em: EntityManager, dto: UnitDto, current: UnitRow | null) {
  const owners = [dto.ownerId ? 1 : 0, dto.driverId ? 1 : 0, dto.company ? 1 : 0].reduce((a, b) => a + b, 0);
  if (owners !== 1) throw new BadRequestException('Choose who owns the unit: a truck owner, an owner-operator, or the company for its own trailers.');
  if (dto.company && dto.kind !== 'TRAILER') throw new BadRequestException('The company owns trailers only. A truck belongs to a truck owner or an owner-operator.');
  if ((dto.plate ? 1 : 0) !== (dto.plateState ? 1 : 0)) throw new BadRequestException('Enter the plate and its state together.');
  if (dto.inspectedOn && dto.inspectedOn > usDay('latest')) throw new BadRequestException('The inspection date can’t be in the future.');
  // Duplicates the Units migration kept stay editable: the number is checked only when it changes.
  if (!current || current.unit.toLowerCase() !== dto.number.toLowerCase()) await numberFree(em, dto.number, dto.kind, current?.id ?? null);
  if (dto.ownerId) {
   const [owner] = await em.query(`SELECT "archivedAt" FROM truck_owners WHERE id = $1 FOR SHARE`, [dto.ownerId]) as { archivedAt: Date | null }[];
   if (!owner || (owner.archivedAt && current?.ownerId !== dto.ownerId)) throw new BadRequestException('Choose a truck owner on the list.');
  }
  if (dto.driverId) {
   const [driver] = await em.query(`SELECT "driverType", status FROM drivers WHERE id = $1 FOR SHARE`, [dto.driverId]) as { driverType: string; status: string }[];
   if (!driver || driver.driverType !== 'OWNER_OPERATOR' || !['APPROVED', 'CLEARED'].includes(driver.status)) throw new BadRequestException('Choose an approved or cleared owner-operator.');
  }
  if (dto.responsibleId && !current) await this.safetyManager(em, dto.responsibleId);
 }
 private async safetyManager(em: EntityManager, id: string) {
  const [user] = await em.query(`SELECT role::text AS role, status FROM users WHERE id = $1 FOR SHARE`, [id]) as { role: string; status: string }[];
  if (!user || user.role !== Role.SAFETY_STAFF || user.status !== UserStatus.ACTIVE) throw new BadRequestException('Choose an active Safety Manager.');
 }
 private async lockOwner(em: EntityManager, id: string, version: number | undefined) {
  const [owner] = await em.query(`SELECT id, version, "archivedAt" FROM truck_owners WHERE id = $1 FOR UPDATE`, [id]) as { id: string; version: number; archivedAt: Date | null }[];
  if (!owner) throw new NotFoundException('This owner is no longer on the list.');
  if (owner.version !== version) throw new ConflictException(OWNER_STALE);
  return owner;
 }
 private event(em: EntityManager, user: User, about: { unitId: string } | { ownerId: string }, event: Event, metadata: Record<string, unknown>) { return unitEvent(em, user, about, event, metadata); }
}

/**
 * An owner-operator's truck is also on their driver record (TruckService): only Safety leads, the Safety Director,
 * administrators and that driver's Safety Manager add, move or change it, under the driver's lock, in driver id order.
 * Callers take these locks before the unit number lock, as TruckService does.
 */
export async function lockOperators(em: EntityManager, user: User, driverIds: (string | null | undefined)[]) {
 for (const driverId of [...new Set(driverIds.filter((value): value is string => !!value))].sort()) {
  await em.query(`SELECT id FROM drivers WHERE id = $1 FOR UPDATE`, [driverId]);
  if (!SCREENERS.includes(user.role) && !await ownsDriver(em, user, driverId)) throw new ForbiddenException('Only Safety leads, the Safety Director and the driver’s Safety Manager can change an owner-operator’s trucks.');
 }
}
/** The driver record's side of a truck change: their version moves on and their history says so (TRUCK_SAVED, as TruckService writes). */
export async function operatorChanged(em: EntityManager, user: User, driverId: string, action: 'added' | 'updated' | 'moved') {
 await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [driverId]);
 await driverEvent(em, user.id, driverId, 'TRUCK_SAVED', { action });
}
export function unitEvent(em: EntityManager, user: User, about: { unitId: string } | { ownerId: string }, event: Event, metadata: Record<string, unknown>) {
 return em.query(`INSERT INTO unit_events ("unitId", "ownerId", "actorId", event, metadata) VALUES ($1, $2, $3, $4, $5)`,
  ['unitId' in about ? about.unitId : null, 'ownerId' in about ? about.ownerId : null, user.id, event, JSON.stringify(metadata)]);
}
export interface NewUnit { number: string; kind: UnitKind; ownerId: string | null; driverId: string | null; company: boolean; vin: string; year: number; make: string; plate: string | null;
 plateState: string | null; trailerType: string | null; registrationExpiresOn: string | null; inspectedOn: string | null; responsibleId: string | null }
/**
 * Adds a checked unit, its ADDED history and, for an owner-operator's truck, the driver record's side (operatorChanged).
 * Callers hold lockOperators and the number lock and have checked the unit (checkUnit here, the rows in the file import).
 */
export async function insertUnit(em: EntityManager, user: User, unit: NewUnit, imported = false) {
 const [row]: { id: string }[] = await em.query(`INSERT INTO driver_trucks (unit, kind, "ownerId", "driverId", company, vin, year, make, plate, "plateState", "trailerType", "registrationExpiresOn", "inspectedOn", "responsibleId", "createdBy")
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
  [unit.number, unit.kind, unit.ownerId, unit.driverId, unit.company, unit.vin, unit.year, unit.make, unit.plate, unit.plateState, unit.kind === 'TRAILER' ? unit.trailerType : null,
   unit.registrationExpiresOn, unit.inspectedOn, unit.responsibleId, user.id]).catch(duplicate);
 await unitEvent(em, user, { unitId: row.id }, 'ADDED', { kind: unit.kind, owner: unit.company ? 'company' : unit.ownerId ? 'owner' : 'driver', ...(imported ? { imported: true } : {}) });
 if (unit.driverId) await operatorChanged(em, user, unit.driverId, 'added');
 return row.id;
}
/** Adds a truck owner (its name kept as typed, compared ignoring case and spacing) with its OWNER_ADDED history. */
export async function insertOwner(em: EntityManager, user: User, owner: { name: string; signerName?: string; signerTitle?: string; email?: string; phone?: string }, imported = false) {
 const [row]: { id: string }[] = await em.query(`INSERT INTO truck_owners (name, "nameKey", "signerName", "signerTitle", email, phone, "createdBy") VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
  [clean(owner.name), nameKey(owner.name), owner.signerName || null, owner.signerTitle || null, owner.email || null, owner.phone || null, user.id]).catch(duplicateOwner);
 await unitEvent(em, user, { ownerId: row.id }, 'OWNER_ADDED', imported ? { imported: true } : {});
 return row.id;
}
function duplicate(error: unknown): never {
 const driver = error instanceof QueryFailedError ? error.driverError as { code?: string; constraint?: string } : null;
 if (driver?.code === '23505' && driver.constraint === 'UQ_driver_trucks_vin') throw new ConflictException('Another unit on the list already has this VIN.');
 throw error;
}
function duplicateOwner(error: unknown): never {
 const driver = error instanceof QueryFailedError ? error.driverError as { code?: string; constraint?: string } : null;
 if (driver?.code === '23505' && driver.constraint === 'UQ_truck_owners_name') throw new ConflictException('A truck owner with this name is already on the list.');
 throw error;
}
