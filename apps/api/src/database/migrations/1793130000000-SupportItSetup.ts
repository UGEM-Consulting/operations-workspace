import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * IT setup for supports and updaters (section 32, designed and approved 2026-11-09). A setup request is now either a
 * new dispatcher's (purpose DISPATCHER: from their approved application, as before) or what a dispatch manager asked IT
 * to set up for a support or updater (purpose SUPPORT: linked to their dispatcher record, never to an application, with
 * only the tasks asked for and an optional note). Rows an older API writes keep the DISPATCHER default, and readers that
 * join by application never see support setups. The completion checks (RingCentral number, company email) apply to
 * dispatcher setups only; for a support the API requires them only when that task was asked for. One open support setup
 * per person. The rollback refuses while any support setup exists.
 */
export class SupportItSetup1793130000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE it_onboarding_requests
   ADD COLUMN purpose varchar(20) NOT NULL DEFAULT 'DISPATCHER' CONSTRAINT "CHK_it_requests_purpose" CHECK (purpose IN ('DISPATCHER','SUPPORT')),
   ADD COLUMN "memberId" uuid NULL REFERENCES dispatch_members(id),
   ADD COLUMN note varchar(1000) NULL,
   ADD COLUMN "requestedBy" uuid NULL REFERENCES users(id),
   ALTER COLUMN "applicationId" DROP NOT NULL,
   ALTER COLUMN "approvalId" DROP NOT NULL,
   ADD CONSTRAINT "CHK_it_requests_source" CHECK (CASE purpose WHEN 'DISPATCHER' THEN "applicationId" IS NOT NULL AND "approvalId" IS NOT NULL
    ELSE "memberId" IS NOT NULL AND "applicationId" IS NULL AND "approvalId" IS NULL AND "requestedBy" IS NOT NULL END)`);
  await q.query(`CREATE UNIQUE INDEX "UQ_it_requests_support_open" ON it_onboarding_requests ("memberId") WHERE purpose = 'SUPPORT' AND "completedAt" IS NULL AND "cancelledAt" IS NULL`);
  // Setups are read by member (the dispatcher page, company email, shared sign-ins, leaving) as well as by application.
  await q.query(`CREATE INDEX "IDX_it_requests_member" ON it_onboarding_requests ("memberId") WHERE "memberId" IS NOT NULL`);
  await q.query(`ALTER TABLE it_onboarding_requests DROP CONSTRAINT it_completion_contact_check, DROP CONSTRAINT it_completion_company_email_check`);
  await q.query(`ALTER TABLE it_onboarding_requests ADD CONSTRAINT it_completion_contact_check
   CHECK (purpose <> 'DISPATCHER' OR "completedAt" IS NULL OR ("assignedRingCentralPhoneNumber" IS NOT NULL
    AND (NULLIF(btrim(profile->>'workPhoneNumber'),'') IS NULL OR "workPhoneVerifiedAt" IS NOT NULL)))`);
  // NOT VALID, as before: historical completed requests from before the company email column stay intact.
  await q.query(`ALTER TABLE it_onboarding_requests ADD CONSTRAINT it_completion_company_email_check
   CHECK (purpose <> 'DISPATCHER' OR "completedAt" IS NULL OR "companyEmail" IS NOT NULL) NOT VALID`);
 }

 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM it_onboarding_requests WHERE purpose = 'SUPPORT') AS kept`);
  if (data.kept) throw new Error('Cannot discard IT setups for supports and updaters');
  await q.query(`ALTER TABLE it_onboarding_requests DROP CONSTRAINT it_completion_contact_check, DROP CONSTRAINT it_completion_company_email_check`);
  await q.query(`ALTER TABLE it_onboarding_requests ADD CONSTRAINT it_completion_contact_check
   CHECK ("completedAt" IS NULL OR ("assignedRingCentralPhoneNumber" IS NOT NULL
    AND (NULLIF(btrim(profile->>'workPhoneNumber'),'') IS NULL OR "workPhoneVerifiedAt" IS NOT NULL)))`);
  await q.query(`ALTER TABLE it_onboarding_requests ADD CONSTRAINT it_completion_company_email_check
   CHECK ("completedAt" IS NULL OR "companyEmail" IS NOT NULL) NOT VALID`);
  await q.query(`DROP INDEX "IDX_it_requests_member"`);
  await q.query(`DROP INDEX "UQ_it_requests_support_open"`);
  await q.query(`ALTER TABLE it_onboarding_requests DROP CONSTRAINT "CHK_it_requests_source",
   ALTER COLUMN "approvalId" SET NOT NULL, ALTER COLUMN "applicationId" SET NOT NULL,
   DROP COLUMN "requestedBy", DROP COLUMN note, DROP COLUMN "memberId", DROP COLUMN purpose`);
 }
}
