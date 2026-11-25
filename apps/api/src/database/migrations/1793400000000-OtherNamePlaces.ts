import { MigrationInterface, QueryRunner } from 'typeorm';
// Section 43 (approved by the user 2026-11-25): an other name can be used at a company that isn't one of our MCs, typed in
// (companyName), and can carry a staff note on why the name is needed. One place at most: an MC or a typed company. The
// rollback refuses while any typed company or note is recorded.
export class OtherNamePlaces1793400000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE member_other_names ADD COLUMN "companyName" varchar(100) NULL, ADD COLUMN note varchar(200) NULL,
   ADD CONSTRAINT "CHK_member_other_names_place" CHECK ("mcId" IS NULL OR "companyName" IS NULL)`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_other_names WHERE "companyName" IS NOT NULL OR note IS NOT NULL) AS found`);
  if (found.found) throw new Error('Refusing to roll back while other names record another company or a note.');
  await q.query(`ALTER TABLE member_other_names DROP CONSTRAINT "CHK_member_other_names_place", DROP COLUMN note, DROP COLUMN "companyName"`);
 }
}
