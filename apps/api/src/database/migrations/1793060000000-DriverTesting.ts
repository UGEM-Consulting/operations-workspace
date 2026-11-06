import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_ANNUAL, EVENTS_AFTER_TESTING } from '../driver-event-lists';
// Ongoing drug and alcohol testing (Safety compliance, phase 4): results only. A cleared driver's random, post-accident,
// reasonable-suspicion, return-to-duty and follow-up tests are recorded as a kind, a reason, a date and a result. No
// substances, levels, lab reports or medical details are stored. A mistaken entry is voided with a reason, never edited
// or deleted, so the record keeps who entered what.
export class DriverTesting1793060000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_TESTING}))`);
  await q.query(`CREATE TABLE driver_tests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   kind varchar NOT NULL CHECK (kind IN ('DRUG','ALCOHOL')),
   reason varchar NOT NULL CHECK (reason IN ('RANDOM','POST_ACCIDENT','REASONABLE_SUSPICION','RETURN_TO_DUTY','FOLLOW_UP')),
   "testedOn" date NOT NULL, result varchar NOT NULL CHECK (result IN ('NEGATIVE','NOT_NEGATIVE','CANCELLED','REFUSED')),
   note varchar(500) NULL, "recordedBy" uuid NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now(),
   "voidedAt" timestamptz NULL, "voidedBy" uuid NULL REFERENCES users(id), "voidReason" varchar(500) NULL,
   CHECK (("voidedAt" IS NULL) = ("voidReason" IS NULL) AND ("voidedAt" IS NULL) = ("voidedBy" IS NULL)))`);
  await q.query(`CREATE INDEX "IDX_driver_tests_driver" ON driver_tests ("driverId", "testedOn")`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_tests) OR EXISTS(SELECT 1 FROM driver_events WHERE event IN ('TEST_RECORDED','TEST_VOIDED')) AS kept`);
  if (data.kept) throw new Error('Cannot discard recorded drug and alcohol test results');
  await q.query(`DROP TABLE driver_tests`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_ANNUAL}))`);
 }
}
