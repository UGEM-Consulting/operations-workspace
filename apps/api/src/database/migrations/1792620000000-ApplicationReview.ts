import { MigrationInterface, QueryRunner } from 'typeorm';
export class ApplicationReview1792620000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE dispatcher_applications
   DROP CONSTRAINT dispatcher_applications_status_check,
   DROP CONSTRAINT dispatcher_applications_check,
   ADD COLUMN "applicantAccessUntil" timestamptz;
  UPDATE dispatcher_applications a SET "applicantAccessUntil" = i."expiresAt" FROM invitations i WHERE a."invitationId" = i.id;
  ALTER TABLE dispatcher_applications ALTER COLUMN "applicantAccessUntil" SET NOT NULL,
   ADD CONSTRAINT application_status_check CHECK (status IN ('INVITED','DRAFT','SUBMITTED','CHANGES_REQUESTED','RESUBMITTED','APPROVED','REJECTED')),
   ADD CONSTRAINT application_submission_check CHECK ((status IN ('INVITED','DRAFT')) = ("submittedAt" IS NULL));
  CREATE TABLE application_reviews (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "applicationId" uuid NOT NULL REFERENCES dispatcher_applications(id),
   "reviewerId" uuid NOT NULL REFERENCES users(id), "decisionType" varchar NOT NULL CHECK ("decisionType" IN ('APPROVE','REQUEST_CHANGES','REJECT')),
   reason text, "requestedFields" jsonb NOT NULL DEFAULT '[]', "previousStatus" varchar NOT NULL CHECK ("previousStatus" IN ('SUBMITTED','RESUBMITTED')),
   "newStatus" varchar NOT NULL, "applicationVersion" integer NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
   UNIQUE ("applicationId", "applicationVersion"),
   CHECK (("decisionType"='APPROVE' AND "newStatus"='APPROVED') OR ("decisionType"='REJECT' AND "newStatus"='REJECTED') OR ("decisionType"='REQUEST_CHANGES' AND "newStatus"='CHANGES_REQUESTED')),
   CHECK ("decisionType"='APPROVE' OR length(trim(reason)) > 0 AND reason IS NOT NULL),
   CHECK (jsonb_typeof("requestedFields")='array' AND ("decisionType" <> 'REQUEST_CHANGES' OR jsonb_array_length("requestedFields") > 0)));
  CREATE INDEX reviews_application_created ON application_reviews ("applicationId", "createdAt");
  CREATE TABLE application_submissions (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "applicationId" uuid NOT NULL REFERENCES dispatcher_applications(id),
   version integer NOT NULL, fields jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("applicationId", version));
  INSERT INTO application_submissions ("applicationId", version, fields, "createdAt")
   SELECT id, version, fields, "submittedAt" FROM dispatcher_applications WHERE status='SUBMITTED';
  CREATE INDEX application_review_queue ON dispatcher_applications ("assignedManagerId", status, "updatedAt" DESC, id);
  CREATE INDEX application_submissions_latest ON application_submissions ("applicationId", version DESC);`);
 }
 async down(q: QueryRunner): Promise<void> {
  // Never silently convert approvals/rejections back into submitted applications.
  await q.query(`DO $$ BEGIN
   IF EXISTS (SELECT 1 FROM application_reviews) OR EXISTS (SELECT 1 FROM dispatcher_applications WHERE status NOT IN ('INVITED','DRAFT','SUBMITTED'))
   THEN RAISE EXCEPTION 'Review data exists; rollback requires a reviewed recovery plan'; END IF;
  END $$;
  DROP TABLE application_reviews, application_submissions;
  DROP INDEX application_review_queue;
  ALTER TABLE dispatcher_applications DROP CONSTRAINT application_status_check, DROP CONSTRAINT application_submission_check,
   DROP COLUMN "applicantAccessUntil",
   ADD CONSTRAINT dispatcher_applications_status_check CHECK (status IN ('INVITED','DRAFT','SUBMITTED')),
   ADD CONSTRAINT dispatcher_applications_check CHECK ((status='SUBMITTED') = ("submittedAt" IS NOT NULL));`);
 }
}
