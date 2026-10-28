import { MigrationInterface, QueryRunner } from 'typeorm';
// 1. Managers may reject an application whose corrections are outstanding: a review's previous status may be
//    CHANGES_REQUESTED, for rejections only.
// 2. The applicant update outbox can be redelivered: a SENDING claim (claimedAt) and an attempt counter, so a sweeper
//    recovers rows left PENDING by a restart and reclaims stale claims without sending twice.
// All additive: the previous version never writes these values and keeps working while instances overlap.
export class CorrectionRejectionAndDeliveryRetry1792770000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE application_reviews DROP CONSTRAINT "application_reviews_previousStatus_check",
   ADD CONSTRAINT application_reviews_previous_status_check CHECK ("previousStatus" IN ('SUBMITTED','RESUBMITTED') OR ("previousStatus" = 'CHANGES_REQUESTED' AND "decisionType" = 'REJECT'))`);
  await q.query(`ALTER TABLE applicant_update_deliveries DROP CONSTRAINT applicant_update_deliveries_status_check,
   ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), ADD COLUMN "claimedAt" timestamptz,
   ADD CONSTRAINT applicant_update_deliveries_status_check CHECK (status IN ('PENDING','SENDING','SENT','FAILED','SKIPPED')),
   ADD CONSTRAINT applicant_update_deliveries_claim_check CHECK (status <> 'SENDING' OR "claimedAt" IS NOT NULL)`);
  await q.query(`CREATE INDEX update_deliveries_open ON applicant_update_deliveries ("createdAt") WHERE status IN ('PENDING','SENDING')`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM application_reviews WHERE "previousStatus" = 'CHANGES_REQUESTED') AS rejected,
   EXISTS(SELECT 1 FROM applicant_update_deliveries WHERE status = 'SENDING' OR (status = 'PENDING' AND attempts > 0)) AS retrying`);
  if (data.rejected) throw new Error('Cannot discard rejections of outstanding corrections');
  // Finished rows keep their outcome; only in-flight retry state would be lost.
  if (data.retrying) throw new Error('Cannot discard in-flight applicant update deliveries');
  await q.query(`DROP INDEX update_deliveries_open`);
  await q.query(`ALTER TABLE applicant_update_deliveries DROP CONSTRAINT applicant_update_deliveries_claim_check, DROP CONSTRAINT applicant_update_deliveries_status_check,
   DROP COLUMN attempts, DROP COLUMN "claimedAt", ADD CONSTRAINT applicant_update_deliveries_status_check CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED'))`);
  await q.query(`ALTER TABLE application_reviews DROP CONSTRAINT application_reviews_previous_status_check,
   ADD CONSTRAINT "application_reviews_previousStatus_check" CHECK ("previousStatus" IN ('SUBMITTED','RESUBMITTED'))`);
 }
}
