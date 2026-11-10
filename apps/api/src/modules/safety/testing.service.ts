import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../users/user.entity';
import { CLEARERS } from './clearance.service';
import { driverEvent, lockOpenDriver, ownsDriver, writeDriver } from './driver-records';
import { RecordTestDto, VoidTestDto } from './testing.dto';
import { usDay } from './screening-rules';
import { holdReasons } from './holds';

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
   if (!CLEARERS.includes(user.role) && !await ownsDriver(em, user, id)) throw new ForbiddenException('Only the driver’s Safety contact and the Safety manager can record test results.');
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
   if (!CLEARERS.includes(user.role)) throw new ForbiddenException('Only the Safety manager can void a test result.');
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
  return CLEARERS.includes(user.role) || await ownsDriver(this.db.manager, user, driverId);
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
 /** The driver profile's testing and hold, deciding once whether this person may see results. */
 async forProfile(user: User, id: string) {
  const seesResults = await this.canSee(user, id);
  const [testing, hold] = await Promise.all([seesResults ? this.forDriver(id) : { hidden: true as const }, this.hold(id, seesResults)]);
  return { testing, hold, seesResults };
 }
 /** A driver's entries, newest first (voided ones included and marked). */
 async forDriver(id: string) {
  const items = await this.db.query(`SELECT t.id, t.kind, t.reason, to_char(t."testedOn", 'YYYY-MM-DD') AS "testedOn", t.result, t.note, t."createdAt", t."voidedAt", t."voidReason",
    CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "recordedBy"
   FROM driver_tests t LEFT JOIN users u ON u.id = t."recordedBy" WHERE t."driverId" = $1 ORDER BY t."testedOn" DESC, t."createdAt" DESC`, [id]);
  return { items };
 }

 /** attention() as this person may see it: all of it for the Safety manager and administrators, their own drivers for an owner. */
 async attentionFor(user: User) {
  if (CLEARERS.includes(user.role)) return this.attention();
  const owned = new Set((await this.db.query(`SELECT "driverId" FROM driver_owners WHERE "ownerId" = $1 AND "endedAt" IS NULL`, [user.id]) as { driverId: string }[]).map(row => row.driverId));
  return (await this.attention()).filter(row => owned.has(row.driverId));
 }

 /** Cleared drivers whose latest standing result is not negative or a refusal, so a return-to-duty process is open. */
 async attention() {
  return await this.db.query(`SELECT d.id AS "driverId", d."firstName", d."lastName", l.kind, l.result, to_char(l."testedOn", 'YYYY-MM-DD') AS "testedOn",
    CASE WHEN o.id IS NULL THEN NULL ELSE o."firstName" || ' ' || o."lastName" END AS owner
   FROM drivers d CROSS JOIN (VALUES ('DRUG'), ('ALCOHOL')) k(kind) JOIN LATERAL (SELECT kind, result, "testedOn" FROM driver_tests t WHERE t."driverId" = d.id AND t.kind = k.kind AND t."voidedAt" IS NULL AND t.result <> 'CANCELLED'
     ORDER BY t."testedOn" DESC, t."createdAt" DESC LIMIT 1) l ON l.result IN ('NOT_NEGATIVE','REFUSED')
   LEFT JOIN driver_owners w ON w."driverId" = d.id AND w."endedAt" IS NULL LEFT JOIN users o ON o.id = w."ownerId"
   WHERE d.status = 'CLEARED' ORDER BY l."testedOn"`) as { driverId: string }[];
 }
}

/**
 * Clearance items that hold drug and alcohol results: the pre-employment drug test and the Clearinghouse query
 * (49 CFR 40.321, 382.723). Someone who may not see results gets each as { key, hidden: true }, whether or not anything
 * was recorded (so a change from Not started never shows a result arrived), not its gaps, and its history entries
 * without the status, so neither the checklist nor the activity says how it came out.
 */
export const RESULT_ITEMS = ['DRUG_TEST', 'CLEARINGHOUSE'];
export function withoutResults<T extends { clearance?: { items: { key: string }[]; missing: string[] } | null; activity: { event: string; metadata: Record<string, unknown> }[] }>(driver: T): T {
 return { ...driver,
  clearance: driver.clearance && { ...driver.clearance,
   items: [...driver.clearance.items.filter(item => !RESULT_ITEMS.includes(item.key)), ...RESULT_ITEMS.map(key => ({ key, hidden: true }))],
   missing: driver.clearance.missing.filter(code => !RESULT_ITEMS.some(key => code.endsWith(`:${key}`))) },
  activity: driver.activity.map(row => row.event === 'CLEARANCE_RECORDED' && RESULT_ITEMS.includes(String(row.metadata.item)) ? { ...row, metadata: { item: row.metadata.item, hidden: true } } : row) };
}
