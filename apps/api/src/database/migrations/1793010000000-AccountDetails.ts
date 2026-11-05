import { MigrationInterface, QueryRunner } from 'typeorm';
// Telegram, RingCentral extension and load board sign-ins (designed in the Design System and approved by the user 2026-11-05). A manager records them for someone
// added by hand, and IT during setup for a new hire. Load board fields hold a sign-in email, never a password. All empty by default, so rows an older API writes stay correct.
export class AccountDetails1793010000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE existing_member_records ADD COLUMN telegram varchar(32) NULL, ADD COLUMN "ringCentralExtension" varchar(6) NULL, ADD COLUMN "datEmail" varchar(254) NULL, ADD COLUMN "truckstopEmail" varchar(254) NULL`);
  await q.query(`ALTER TABLE it_onboarding_requests ADD COLUMN "ringCentralExtension" varchar(6) NULL, ADD COLUMN "datEmail" varchar(254) NULL, ADD COLUMN "truckstopEmail" varchar(254) NULL`);
  await q.query(`CREATE INDEX "IDX_existing_member_records_dat" ON existing_member_records ("datEmail") WHERE "datEmail" IS NOT NULL`);
  await q.query(`CREATE INDEX "IDX_existing_member_records_truckstop" ON existing_member_records ("truckstopEmail") WHERE "truckstopEmail" IS NOT NULL`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM existing_member_records WHERE telegram IS NOT NULL OR "ringCentralExtension" IS NOT NULL OR "datEmail" IS NOT NULL OR "truckstopEmail" IS NOT NULL)
   OR EXISTS(SELECT 1 FROM it_onboarding_requests WHERE "ringCentralExtension" IS NOT NULL OR "datEmail" IS NOT NULL OR "truckstopEmail" IS NOT NULL) AS kept`);
  if (data.kept) throw new Error('Cannot discard recorded account details');
  await q.query(`DROP INDEX "IDX_existing_member_records_truckstop"`);
  await q.query(`DROP INDEX "IDX_existing_member_records_dat"`);
  await q.query(`ALTER TABLE it_onboarding_requests DROP COLUMN "ringCentralExtension", DROP COLUMN "datEmail", DROP COLUMN "truckstopEmail"`);
  await q.query(`ALTER TABLE existing_member_records DROP COLUMN telegram, DROP COLUMN "ringCentralExtension", DROP COLUMN "datEmail", DROP COLUMN "truckstopEmail"`);
 }
}
