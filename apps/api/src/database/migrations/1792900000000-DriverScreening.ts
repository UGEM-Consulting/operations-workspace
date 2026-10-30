import { MigrationInterface, QueryRunner } from 'typeorm';
// Screening and decision (agreed driver plan, 2026-10-30). The Safety lead works through a screening checklist, uploads
// the driver's MVR (private PDF at driver-reports/<driver>/<report>.pdf, outside the scan sweeper's drivers/ prefix) and
// may send the application back to the driver for corrections, then sends the driver to the Safety manager, who approves
// (optionally with conditions), asks for more, or rejects. A rejection is always two steps recorded in the workspace:
// the pre-adverse notice (status PRE_ADVERSE) and, after the waiting period, the final notice. Safety sends both notices
// themselves; the workspace emails nothing. driver_reviews are append-only, like signature evidence.
const STATUSES = `'LEAD','APPLYING','SCREENING','AWAITING_DECISION','APPROVED','CLEARED','REJECTED','WITHDRAWN','LEFT'`;
const EVENTS = `'CREATED','UPDATED','WITHDRAWN','REOPENED','SAFETY_LEAD_CHANGED','OWNER_ASSIGNED','LINK_SENT','LINK_CANCELLED','APPLICATION_VERIFIED','APPLICATION_SUBMITTED','SSN_REVEALED','DOCUMENT_UPLOADED','DOCUMENT_VERIFIED','DOCUMENT_VIEWED'`;
const NEW_EVENTS = `'SCREENING_CHECKED','MVR_UPLOADED','MVR_VIEWED','CORRECTIONS_REQUESTED','SENT_FOR_DECISION','APPROVED','MORE_INFO_REQUESTED','PRE_ADVERSE_RECORDED','REJECTED'`;
export class DriverScreening1792900000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE drivers DROP CONSTRAINT "drivers_status_check"`);
  await q.query(`ALTER TABLE drivers ADD CONSTRAINT "drivers_status_check" CHECK (status IN (${STATUSES},'PRE_ADVERSE'))`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS},${NEW_EVENTS}))`);
  await q.query(`ALTER TABLE driver_applications ADD "correctionNote" varchar(1000) NULL, ADD "correctionRequestedAt" timestamptz NULL,
   ADD CONSTRAINT "CHK_driver_applications_correction" CHECK (("correctionNote" IS NULL) = ("correctionRequestedAt" IS NULL))`);
  await q.query(`CREATE TABLE driver_screening_checks ("driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   key varchar NOT NULL CHECK (key IN ('IDENTITY','PHONE_SCREEN','EXPERIENCE','MVR')), result varchar NOT NULL CHECK (result IN ('PASS','CONCERN')),
   note varchar(1000) NULL, "checkedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "checkedAt" timestamptz NOT NULL,
   PRIMARY KEY ("driverId", key), CHECK (result = 'PASS' OR note IS NOT NULL))`);
  await q.query(`CREATE TABLE driver_reports (id uuid PRIMARY KEY, "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   kind varchar NOT NULL CHECK (kind IN ('MVR')), "pulledOn" date NOT NULL, "pageCount" smallint NOT NULL CHECK ("pageCount" > 0),
   sha256 varchar(64) NOT NULL, "byteSize" integer NOT NULL, "uploadedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   "createdAt" timestamptz NOT NULL, "replacedAt" timestamptz NULL)`);
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_reports_current" ON driver_reports ("driverId", kind) WHERE "replacedAt" IS NULL`);
  // actorId has no ON DELETE action, like application_reviews.reviewerId: a decision keeps who made it, and staff accounts
  // are deactivated, never deleted (SET NULL would also be refused by the append-only trigger).
  await q.query(`CREATE TABLE driver_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   action varchar NOT NULL CHECK (action IN ('SENT_FOR_DECISION','APPROVED','MORE_INFO','PRE_ADVERSE','REJECTED')),
   note varchar(2000) NULL, conditions varchar(1000) NULL, "noticeSentOn" date NULL,
   "previousStatus" varchar NOT NULL, "newStatus" varchar NOT NULL, "actorId" uuid NULL REFERENCES users(id),
   "createdAt" timestamptz NOT NULL DEFAULT now(),
   CHECK (action NOT IN ('MORE_INFO','PRE_ADVERSE','REJECTED') OR note IS NOT NULL), CHECK (conditions IS NULL OR action = 'APPROVED'),
   CHECK ((action IN ('PRE_ADVERSE','REJECTED')) = ("noticeSentOn" IS NOT NULL)))`);
  await q.query(`CREATE INDEX "IDX_driver_reviews_driver" ON driver_reviews ("driverId", "createdAt")`);
  // refuse_evidence_change() comes from OnboardingDocuments1792710000000. A driver deleted with ON DELETE CASCADE would
  // also be refused, which is intended: decisions are kept with the record (retention is not authorized yet).
  await q.query(`CREATE TRIGGER driver_reviews_append_only BEFORE UPDATE OR DELETE ON driver_reviews FOR EACH ROW EXECUTE FUNCTION refuse_evidence_change()`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_reviews) OR EXISTS(SELECT 1 FROM driver_reports) OR EXISTS(SELECT 1 FROM driver_screening_checks)
   OR EXISTS(SELECT 1 FROM drivers WHERE status = 'PRE_ADVERSE') OR EXISTS(SELECT 1 FROM driver_applications WHERE "correctionNote" IS NOT NULL)
   OR EXISTS(SELECT 1 FROM driver_events WHERE event IN (${NEW_EVENTS})) AS kept`);
  if (data.kept) throw new Error('Cannot discard driver screening, reports or decisions');
  await q.query(`DROP TABLE driver_reviews, driver_reports, driver_screening_checks`);
  await q.query(`ALTER TABLE driver_applications DROP CONSTRAINT "CHK_driver_applications_correction", DROP COLUMN "correctionNote", DROP COLUMN "correctionRequestedAt"`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS}))`);
  await q.query(`ALTER TABLE drivers DROP CONSTRAINT "drivers_status_check"`);
  await q.query(`ALTER TABLE drivers ADD CONSTRAINT "drivers_status_check" CHECK (status IN (${STATUSES}))`);
 }
}
