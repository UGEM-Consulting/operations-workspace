import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../users/user.entity';
import { CLEARERS } from './clearance.service';
import { driverEvent, lockOpenDriver, ownsDriver, writeDriver } from './driver-records';
import { RecordTestDto, VoidTestDto } from './testing.dto';
import { usDay } from './screening-rules';
import { holdReasons } from './holds';
import { resultViewer, seesResults, seesResultsSql } from './results';
import { personName } from './sql';

/**
 * Ongoing drug and alcohol testing of cleared drivers, results only. The owner, the Safety manager and administrators
 * record results; only the Safety manager and administrators void a mistaken entry (a result can't be quietly hidden by
 * the person who entered it). Every Safety role reads them. A driver whose latest result of a kind is not negative or
 * a refusal stays on the attention list until a later negative result of that kind.
 */
@Injectable()
export class TestingService {
 constructor(private readonly db: DataSource) {}

 async record(user: User, id: string, dto: RecordTestDto) {
  if (dto.testedOn > usDay('latest')) throw new BadRequestException('The test date can’t be in the future.');
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   if (!CLEARERS.includes(user.role) && !await ownsDriver(em, user, id)) throw new ForbiddenException('Only the driver’s Safety Manager and the Safety Director can record test results.');
   if (driver.status !== 'CLEARED' || !driver.clearedAt) throw new ConflictException('Ongoing testing is recorded once the driver is cleared.');
   if (dto.testedOn < usDay('latest', driver.clearedAt)) throw new BadRequestException('The test can’t be dated before the driver was cleared. The pre-employment test belongs to clearance.');
   await em.query(`INSERT INTO driver_tests ("driverId", kind, reason, "testedOn", result, note, "recordedBy") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, dto.kind, dto.reason, dto.testedOn, dto.result, dto.note || null, user.id]);
   await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [id]);
   // Kind and reason only: never the result, the date or the note.
   await driverEvent(em, user.id, id, 'TEST_RECORDED', { kind: dto.kind, reason: dto.reason });
   return { id, version: driver.version + 1 };
  });
 }

 async void(user: User, id: string, testId: string, dto: VoidTestDto) {
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   if (!CLEARERS.includes(user.role)) throw new ForbiddenException('Only the Safety Director can void a test result.');
   const [row] = await em.query(`SELECT "voidedAt" FROM driver_tests WHERE id = $1 AND "driverId" = $2 FOR UPDATE`, [testId, id]) as { voidedAt: Date | null }[];
   if (!row) throw new NotFoundException('This test result no longer exists.');
   if (row.voidedAt) throw new ConflictException('This entry is already voided.');
   await em.query(`UPDATE driver_tests SET "voidedAt" = now(), "voidedBy" = $2, "voidReason" = $3 WHERE id = $1`, [testId, user.id, dto.reason]);
   await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [id]);
   await driverEvent(em, user.id, id, 'TEST_VOIDED', {});
   return { id, version: driver.version + 1 };
  });
 }

 /**
  * Test results are seen only by those who act on them (49 CFR 40.321): the Safety manager, administrators and the
  * driver's current owner. Other Safety roles see that testing exists, not the results.
  */
 async canSee(user: User, driverId: string) {
  return seesResults(this.db.manager, user, driverId);
 }
 /**
  * Whether Dispatch sees this driver as on hold, and why for Safety: a failed or refused test, a Not qualified yearly
  * review or an expired document. Someone who may not see results gets test null and onHold from the other reasons only,
  * because a hold with no visible reason would itself say that a test failed (49 CFR 40.321).
  */
 private async hold(id: string, seesResults: boolean) {
  const reasons = await holdReasons(this.db.manager, id);
  const test = seesResults ? reasons.test : null;
  return { onHold: !!test || reasons.review || reasons.documents, test, review: reasons.review, documents: reasons.documents };
 }
 /** The driver profile's testing and hold, for someone who does or doesn't see results (decided once by the caller). */
 async forProfile(user: User, id: string, seesResults?: boolean) {
  const sees = seesResults ?? await this.canSee(user, id);
  const [testing, hold] = await Promise.all([sees ? this.forDriver(id) : { hidden: true as const }, this.hold(id, sees)]);
  return { testing, hold, seesResults: sees };
 }
 /** A driver's entries, newest first (voided ones included and marked). */
 async forDriver(id: string) {
  const items = await this.db.query(`SELECT t.id, t.kind, t.reason, to_char(t."testedOn", 'YYYY-MM-DD') AS "testedOn", t.result, t.note, t."createdAt", t."voidedAt", t."voidReason",
    ${personName('u')} AS "recordedBy"
   FROM driver_tests t LEFT JOIN users u ON u.id = t."recordedBy" WHERE t."driverId" = $1 ORDER BY t."testedOn" DESC, t."createdAt" DESC`, [id]);
  return { items };
 }

 /** attention() as this person may see it: all of it for the Safety manager and administrators, their own drivers for an owner. */
 async attentionFor(user: User) {
  return this.attention(user);
 }

 /** Cleared drivers whose latest standing result is not negative or a refusal, so a return-to-duty process is open. */
 async attention(viewer?: User) {
  return await this.db.query(`SELECT d.id AS "driverId", d."firstName", d."lastName", l.kind, l.result, to_char(l."testedOn", 'YYYY-MM-DD') AS "testedOn",
    ${personName('o')} AS owner
   FROM drivers d CROSS JOIN (VALUES ('DRUG'), ('ALCOHOL')) k(kind) JOIN LATERAL (SELECT kind, result, "testedOn" FROM driver_tests t WHERE t."driverId" = d.id AND t.kind = k.kind AND t."voidedAt" IS NULL AND t.result <> 'CANCELLED'
     ORDER BY t."testedOn" DESC, t."createdAt" DESC LIMIT 1) l ON l.result IN ('NOT_NEGATIVE','REFUSED')
   LEFT JOIN driver_owners w ON w."driverId" = d.id AND w."endedAt" IS NULL LEFT JOIN users o ON o.id = w."ownerId"
   WHERE d.status = 'CLEARED' AND ${seesResultsSql('d.id', '$1', '$2')} ORDER BY l."testedOn"`, viewer ? resultViewer(viewer) : [true, null]) as { driverId: string }[];
 }
}

