import { MigrationInterface, QueryRunner } from 'typeorm';
// IT records the company (Google Workspace) email it creates; new completions require it.
export class CompanyEmail1792700000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE it_onboarding_requests ADD COLUMN "companyEmail" varchar(254)`);
  // NOT VALID keeps historical completed requests (finished before this column existed) intact
  // while every new or changed row must satisfy it.
  await q.query(`ALTER TABLE it_onboarding_requests ADD CONSTRAINT it_completion_company_email_check
   CHECK ("completedAt" IS NULL OR "companyEmail" IS NOT NULL) NOT VALID`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM it_onboarding_requests WHERE "companyEmail" IS NOT NULL) AS recorded`);
  if (data.recorded) throw new Error('Cannot discard recorded company emails');
  await q.query(`ALTER TABLE it_onboarding_requests DROP CONSTRAINT it_completion_company_email_check`);
  await q.query(`ALTER TABLE it_onboarding_requests DROP COLUMN "companyEmail"`);
 }
}
