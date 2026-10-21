import { MigrationInterface, QueryRunner } from 'typeorm';
export class OptionalInvitationDetails1792630000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE invitations ADD COLUMN "expectedEmail" varchar(254),
   ALTER COLUMN email DROP NOT NULL, ALTER COLUMN "mcName" DROP NOT NULL,
   ALTER COLUMN "teamLead" DROP NOT NULL, ALTER COLUMN "jobTitle" DROP NOT NULL;
  UPDATE invitations SET "expectedEmail"=email;
  ALTER TABLE invitations ADD CONSTRAINT invitation_expected_email_check CHECK ("expectedEmail" = lower(trim("expectedEmail")));
  ALTER TABLE applicant_challenges ADD COLUMN email varchar(254);
  UPDATE applicant_challenges c SET email=i.email FROM invitations i WHERE c."invitationId"=i.id;
  UPDATE dispatcher_applications a SET fields=jsonb_strip_nulls(jsonb_build_object('mcName',i."mcName",'teamLead',i."teamLead",'jobTitle',i."jobTitle")) || a.fields
   FROM invitations i WHERE a."invitationId"=i.id;
  UPDATE application_submissions s SET fields=jsonb_strip_nulls(jsonb_build_object('mcName',i."mcName",'teamLead',i."teamLead",'jobTitle',i."jobTitle")) || s.fields
   FROM dispatcher_applications a JOIN invitations i ON a."invitationId"=i.id WHERE s."applicationId"=a.id;
  ALTER TABLE application_reviews ADD COLUMN employment jsonb, ADD COLUMN "previousEmployment" jsonb;`);
 }
 async down(q: QueryRunner): Promise<void> {
  // Refuse a lossy downgrade rather than inventing applicant identities or dropping decisions.
  await q.query(`DO $$ BEGIN
   IF EXISTS (SELECT 1 FROM invitations WHERE email IS NULL OR "mcName" IS NULL OR "teamLead" IS NULL OR "jobTitle" IS NULL OR "expectedEmail" IS DISTINCT FROM email)
    OR EXISTS (SELECT 1 FROM application_reviews WHERE employment IS NOT NULL)
   THEN RAISE EXCEPTION 'Simplified invitation data exists; rollback requires a reviewed recovery plan'; END IF;
  END $$;
  ALTER TABLE application_reviews DROP COLUMN employment, DROP COLUMN "previousEmployment";
  ALTER TABLE applicant_challenges DROP COLUMN email;
  ALTER TABLE invitations DROP CONSTRAINT invitation_expected_email_check, DROP COLUMN "expectedEmail",
   ALTER COLUMN email SET NOT NULL, ALTER COLUMN "mcName" SET NOT NULL, ALTER COLUMN "teamLead" SET NOT NULL, ALTER COLUMN "jobTitle" SET NOT NULL;`);
 }
}
