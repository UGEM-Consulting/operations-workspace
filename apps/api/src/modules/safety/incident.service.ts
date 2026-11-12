import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../users/user.entity';
import { CLEARERS } from './clearance.service';
import { driverEvent, lockOpenDriver, ownsDriver, writeDriver } from './driver-records';
import { RecordIncidentDto, SettleIncidentDto, VoidIncidentDto } from './incident.dto';
import { usDay } from './screening-rules';
import { personName } from './sql';

type Incident = { kind: string; preventable: string | null; disposition: string | null; voidedAt: Date | null };

/**
 * Accidents, violations and roadside inspections of cleared drivers. The owner, the Safety manager and administrators
 * record and settle them; only the Safety manager and administrators void an entry. Every Safety role reads them. An
 * accident with undetermined preventability or a violation still pending stays on the Safety follow-up list.
 */
@Injectable()
export class IncidentService {
 constructor(private readonly db: DataSource) {}

 private async write<T>(user: User, id: string, version: number, work: (em: Parameters<Parameters<typeof writeDriver>[1]>[0], driver: { version: number; clearedAt: Date | null; status: string }) => Promise<T>, voiding = false) {
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, version);
   if (voiding ? !CLEARERS.includes(user.role) : !CLEARERS.includes(user.role) && !await ownsDriver(em, user, id))
    throw new ForbiddenException(voiding ? 'Only the Safety Director can void an entry.' : 'Only the driver’s Safety Manager and the Safety Director can record incidents.');
   return work(em, driver);
  });
 }

 async record(user: User, id: string, dto: RecordIncidentDto) {
  if (dto.occurredOn > usDay('latest')) throw new BadRequestException('The date can’t be in the future.');
  return this.write(user, id, dto.version, async (em, driver) => {
   if (driver.status !== 'CLEARED' || !driver.clearedAt) throw new ConflictException('Incidents are recorded once the driver is cleared.');
   if (dto.occurredOn < usDay('latest', driver.clearedAt)) throw new BadRequestException('The date can’t be before the driver was cleared.');
   const accident = dto.kind === 'ACCIDENT', violation = dto.kind === 'VIOLATION', inspection = dto.kind === 'INSPECTION';
   await em.query(`INSERT INTO driver_incidents ("driverId", kind, "occurredOn", state, summary, note, preventable, injuries, fatalities, "towAway", disposition, "outOfService", "violationCount", "recordedBy")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, [id, dto.kind, dto.occurredOn, dto.state || null, dto.summary, dto.note || null,
     accident ? dto.preventable : null, accident ? dto.injuries : null, accident ? dto.fatalities : null, accident ? dto.towAway : null, violation ? dto.disposition : null,
     inspection ? dto.outOfService : null, inspection ? dto.violationCount : null, user.id]);
   await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [id]);
   await driverEvent(em, user.id, id, 'INCIDENT_RECORDED', { kind: dto.kind });
   return { id, version: driver.version + 1 };
  });
 }

 /** Settles an accident's preventability (from undetermined) or a pending violation's outcome. Once. */
 async settle(user: User, id: string, incidentId: string, dto: SettleIncidentDto) {
  if (!!dto.preventable === !!dto.disposition) throw new BadRequestException('Choose the preventability of an accident, or the outcome of a violation.');
  return this.write(user, id, dto.version, async (em, driver) => {
   const [row] = await em.query(`SELECT kind, preventable, disposition, "voidedAt" FROM driver_incidents WHERE id = $1 AND "driverId" = $2 FOR UPDATE`, [incidentId, id]) as Incident[];
   if (!row) throw new NotFoundException('This entry no longer exists.');
   if (row.voidedAt) throw new ConflictException('This entry is voided.');
   if (dto.preventable && (row.kind !== 'ACCIDENT' || row.preventable !== 'UNDETERMINED')) throw new ConflictException('Only an accident with undetermined preventability can be settled.');
   if (dto.disposition && (row.kind !== 'VIOLATION' || row.disposition !== 'PENDING')) throw new ConflictException('Only a pending violation can be settled.');
   await em.query(`UPDATE driver_incidents SET preventable = COALESCE($2, preventable), disposition = COALESCE($3, disposition), "settledAt" = now(), "settledBy" = $4 WHERE id = $1`,
    [incidentId, dto.preventable ?? null, dto.disposition ?? null, user.id]);
   await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [id]);
   await driverEvent(em, user.id, id, 'INCIDENT_UPDATED', { kind: row.kind });
   return { id, version: driver.version + 1 };
  });
 }

 async void(user: User, id: string, incidentId: string, dto: VoidIncidentDto) {
  return this.write(user, id, dto.version, async (em, driver) => {
   const [row] = await em.query(`SELECT "voidedAt" FROM driver_incidents WHERE id = $1 AND "driverId" = $2 FOR UPDATE`, [incidentId, id]) as { voidedAt: Date | null }[];
   if (!row) throw new NotFoundException('This entry no longer exists.');
   if (row.voidedAt) throw new ConflictException('This entry is already voided.');
   await em.query(`UPDATE driver_incidents SET "voidedAt" = now(), "voidedBy" = $2, "voidReason" = $3 WHERE id = $1`, [incidentId, user.id, dto.reason]);
   await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [id]);
   await driverEvent(em, user.id, id, 'INCIDENT_VOIDED', {});
   return { id, version: driver.version + 1 };
  }, true);
 }

 async forDriver(id: string) {
  const items = await this.db.query(`SELECT i.id, i.kind, to_char(i."occurredOn", 'YYYY-MM-DD') AS "occurredOn", i.state, i.summary, i.note, i.preventable, i.injuries, i.fatalities, i."towAway",
    i.disposition, i."outOfService", i."violationCount", i."createdAt", i."settledAt", i."voidedAt", i."voidReason",
    ${personName('u')} AS "recordedBy"
   FROM driver_incidents i LEFT JOIN users u ON u.id = i."recordedBy" WHERE i."driverId" = $1 ORDER BY i."occurredOn" DESC, i."createdAt" DESC`, [id]);
  return { items };
 }

 /** Accidents not yet judged preventable or not, and violations still pending, for cleared drivers. */
 async attention() {
  return await this.db.query(`SELECT i.id AS "incidentId", d.id AS "driverId", d."firstName", d."lastName", i.kind, to_char(i."occurredOn", 'YYYY-MM-DD') AS "occurredOn",
    ${personName('o')} AS owner
   FROM driver_incidents i JOIN drivers d ON d.id = i."driverId" LEFT JOIN driver_owners w ON w."driverId" = d.id AND w."endedAt" IS NULL LEFT JOIN users o ON o.id = w."ownerId"
   WHERE d.status = 'CLEARED' AND i."voidedAt" IS NULL AND (i.preventable = 'UNDETERMINED' OR i.disposition = 'PENDING') ORDER BY i."occurredOn"`) as { incidentId: string }[];
 }
}
