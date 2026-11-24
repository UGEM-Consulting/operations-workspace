import { MigrationInterface, QueryRunner } from 'typeorm';
// Section 41, after review (the user's decision 2026-11-24): a rehire who gets a new company email or RingCentral number, or
// none, no longer counts as owning the ones IT removed when they left. The old value moves from the earlier IT setups and the
// manager's record into retired columns (kept, never deleted, shown to IT as replaced), with when; every reader of an account
// then skips it without knowing about rehires. A finished dispatcher setup may now have its number or email retired. The
// rollback refuses while anything is retired.
const RETIRED = `ADD COLUMN "retiredCompanyEmail" varchar(254) NULL, ADD COLUMN "retiredRingCentralNumber" varchar NULL,
 ADD COLUMN "retiredRingCentralExtension" varchar(6) NULL, ADD COLUMN "accountsRetiredAt" timestamptz NULL`;
const DROP_RETIRED = `DROP COLUMN "retiredCompanyEmail", DROP COLUMN "retiredRingCentralNumber", DROP COLUMN "retiredRingCentralExtension", DROP COLUMN "accountsRetiredAt"`;
export class RetiredAccounts1793390000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE it_onboarding_requests ${RETIRED}`);
  await q.query(`ALTER TABLE existing_member_records ${RETIRED}`);
  await q.query(`ALTER TABLE it_onboarding_requests DROP CONSTRAINT it_completion_contact_check, DROP CONSTRAINT it_completion_company_email_check`);
  await q.query(`ALTER TABLE it_onboarding_requests ADD CONSTRAINT it_completion_contact_check
   CHECK (purpose <> 'DISPATCHER' OR "completedAt" IS NULL OR (("assignedRingCentralPhoneNumber" IS NOT NULL OR "retiredRingCentralNumber" IS NOT NULL)
    AND (NULLIF(btrim(profile->>'workPhoneNumber'),'') IS NULL OR "workPhoneVerifiedAt" IS NOT NULL)))`);
  // NOT VALID, as before: historical completed requests from before the company email column stay intact.
  await q.query(`ALTER TABLE it_onboarding_requests ADD CONSTRAINT it_completion_company_email_check
   CHECK (purpose <> 'DISPATCHER' OR "completedAt" IS NULL OR "companyEmail" IS NOT NULL OR "retiredCompanyEmail" IS NOT NULL) NOT VALID`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM it_onboarding_requests WHERE "accountsRetiredAt" IS NOT NULL) OR EXISTS(SELECT 1 FROM existing_member_records WHERE "accountsRetiredAt" IS NOT NULL) AS found`);
  if (found.found) throw new Error('Refusing to roll back while accounts replaced at a rehire are recorded.');
  await q.query(`ALTER TABLE it_onboarding_requests DROP CONSTRAINT it_completion_contact_check, DROP CONSTRAINT it_completion_company_email_check`);
  await q.query(`ALTER TABLE it_onboarding_requests ADD CONSTRAINT it_completion_contact_check
   CHECK (purpose <> 'DISPATCHER' OR "completedAt" IS NULL OR ("assignedRingCentralPhoneNumber" IS NOT NULL
    AND (NULLIF(btrim(profile->>'workPhoneNumber'),'') IS NULL OR "workPhoneVerifiedAt" IS NOT NULL)))`);
  await q.query(`ALTER TABLE it_onboarding_requests ADD CONSTRAINT it_completion_company_email_check
   CHECK (purpose <> 'DISPATCHER' OR "completedAt" IS NULL OR "companyEmail" IS NOT NULL) NOT VALID`);
  await q.query(`ALTER TABLE existing_member_records ${DROP_RETIRED}`);
  await q.query(`ALTER TABLE it_onboarding_requests ${DROP_RETIRED}`);
 }
}
