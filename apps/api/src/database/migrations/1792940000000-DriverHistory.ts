import { MigrationInterface, QueryRunner } from 'typeorm';
// Address and work history (FMCSA §391.21; designed in the Design System and approved by the user 2026-11-02): the driver's
// addresses, jobs, explained gaps, accidents, tickets and other licenses are stored with their application as one JSON
// document (validated by DriverHistoryDto, checked for coverage at submission). Screening gets a fifth check, HISTORY. At
// approval the DOT-regulated jobs of the last 3 years become previous employers marked as coming from the application.
const KEYS = `'IDENTITY','PHONE_SCREEN','EXPERIENCE','MVR'`;
export class DriverHistory1792940000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_applications ADD "history" jsonb NULL`);
  await q.query(`ALTER TABLE driver_screening_checks DROP CONSTRAINT "driver_screening_checks_key_check"`);
  await q.query(`ALTER TABLE driver_screening_checks ADD CONSTRAINT "driver_screening_checks_key_check" CHECK (key IN (${KEYS},'HISTORY'))`);
  await q.query(`ALTER TABLE driver_previous_employers ADD "source" varchar NOT NULL DEFAULT 'SAFETY' CHECK ("source" IN ('SAFETY','APPLICATION')),
   ADD "location" varchar(120) NULL, ADD "phone" varchar(40) NULL`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_applications WHERE "history" IS NOT NULL) OR EXISTS(SELECT 1 FROM driver_screening_checks WHERE key = 'HISTORY')
   OR EXISTS(SELECT 1 FROM driver_previous_employers WHERE "source" = 'APPLICATION' OR "location" IS NOT NULL OR "phone" IS NOT NULL) AS kept`);
  if (data.kept) throw new Error('Cannot discard driver address and work history');
  await q.query(`ALTER TABLE driver_previous_employers DROP COLUMN "source", DROP COLUMN "location", DROP COLUMN "phone"`);
  await q.query(`ALTER TABLE driver_screening_checks DROP CONSTRAINT "driver_screening_checks_key_check"`);
  await q.query(`ALTER TABLE driver_screening_checks ADD CONSTRAINT "driver_screening_checks_key_check" CHECK (key IN (${KEYS}))`);
  await q.query(`ALTER TABLE driver_applications DROP COLUMN "history"`);
 }
}
