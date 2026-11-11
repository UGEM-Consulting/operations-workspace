import { MigrationInterface, QueryRunner } from 'typeorm';
// Already here (section 37, designed and approved 2026-11-11): someone who left and comes back gets a new dispatcher record
// that names the one they left, which stays as history. Additive: an older API never reads or writes the column. The phone
// index lets the check find submitted phones (digits, without a leading US 1: phoneSql in already-here.ts, the same expression)
// without reading every submission.
export class AlreadyHere1793140000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE dispatch_members ADD COLUMN "previousMemberId" uuid NULL REFERENCES dispatch_members(id),
   ADD CONSTRAINT "CHK_dispatch_members_previous" CHECK ("previousMemberId" IS DISTINCT FROM id)`);
  await q.query(`CREATE UNIQUE INDEX "UQ_dispatch_members_previous" ON dispatch_members ("previousMemberId") WHERE "previousMemberId" IS NOT NULL`);
  await q.query(`CREATE INDEX "IDX_application_submissions_phone" ON application_submissions
   ((nullif(regexp_replace(regexp_replace(coalesce(fields->>'personalPhoneNumber', ''), '\\D', '', 'g'), '^1(?=\\d{10}$)', ''), '')))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [row] = await q.query(`SELECT EXISTS(SELECT 1 FROM dispatch_members WHERE "previousMemberId" IS NOT NULL) AS kept`);
  if (row.kept) throw new Error('Cannot discard links between returning dispatchers and their earlier records');
  await q.query(`DROP INDEX IF EXISTS "IDX_application_submissions_phone"`);
  await q.query(`DROP INDEX "UQ_dispatch_members_previous"`);
  await q.query(`ALTER TABLE dispatch_members DROP CONSTRAINT "CHK_dispatch_members_previous", DROP COLUMN "previousMemberId"`);
 }
}
