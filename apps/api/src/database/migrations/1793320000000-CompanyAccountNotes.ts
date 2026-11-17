import { MigrationInterface, QueryRunner } from 'typeorm';
// Notes on company accounts (Design System section 36, approved 2026-11-17): what staff should know about an account at
// another company, with who wrote it and when. Staff text, never passwords. Events record that the note changed, never its text.
export class CompanyAccountNotes1793320000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE member_company_accounts ADD COLUMN note varchar(500), ADD COLUMN "noteBy" uuid REFERENCES users(id) ON DELETE SET NULL, ADD COLUMN "noteAt" timestamptz`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_company_accounts WHERE note IS NOT NULL) AS found`);
  if (found.found) throw new Error('Refusing to roll back while notes on company accounts are recorded.');
  await q.query(`ALTER TABLE member_company_accounts DROP COLUMN "noteAt", DROP COLUMN "noteBy", DROP COLUMN note`);
 }
}
