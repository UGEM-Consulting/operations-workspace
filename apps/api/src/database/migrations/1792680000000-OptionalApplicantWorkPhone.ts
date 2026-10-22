import { MigrationInterface, QueryRunner } from 'typeorm';
export class OptionalApplicantWorkPhone1792680000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  // The original migration used an unnamed constraint; identify it by its expression.
  const constraints: { conname: string }[] = await q.query(`SELECT conname FROM pg_constraint
   WHERE conrelid='it_onboarding_requests'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%completedAt%'`);
  if (constraints.length !== 1) throw new Error('Unexpected IT completion constraint configuration');
  await q.query(`ALTER TABLE it_onboarding_requests DROP CONSTRAINT "${constraints[0].conname.replaceAll('"','""')}"`);
  await q.query(`ALTER TABLE it_onboarding_requests ADD CONSTRAINT it_completion_contact_check
   CHECK ("completedAt" IS NULL OR ("assignedRingCentralPhoneNumber" IS NOT NULL
    AND (NULLIF(btrim(profile->>'workPhoneNumber'),'') IS NULL OR "workPhoneVerifiedAt" IS NOT NULL)))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM it_onboarding_requests
   WHERE "completedAt" IS NOT NULL AND "workPhoneVerifiedAt" IS NULL) AS incompatible`);
  if (data.incompatible) throw new Error('Cannot restore mandatory applicant work phone verification after onboarding completed without one');
  await q.query(`ALTER TABLE it_onboarding_requests DROP CONSTRAINT it_completion_contact_check;
   ALTER TABLE it_onboarding_requests ADD CONSTRAINT it_completion_contact_check
   CHECK ("completedAt" IS NULL OR ("workPhoneVerifiedAt" IS NOT NULL AND "assignedRingCentralPhoneNumber" IS NOT NULL))`);
 }
}
