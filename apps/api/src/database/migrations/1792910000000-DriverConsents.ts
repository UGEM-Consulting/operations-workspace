import { MigrationInterface, QueryRunner } from 'typeorm';
// Driver consent forms (agreed driver plan, 2026-10-30): the background check disclosure, the background check
// authorization and the FMCSA Clearinghouse consent, as PDFs the Safety manager publishes (immutable versions, kept
// apart from the dispatchers' company_documents so no dispatcher is ever asked to sign them). Drivers open and sign the
// current version in their application; signatures and views are signing evidence like document_signatures. An MVR
// upload records whether the driver's authorization was signed in the workspace or on paper.
const EVENTS = `'CREATED','UPDATED','WITHDRAWN','REOPENED','SAFETY_LEAD_CHANGED','OWNER_ASSIGNED','LINK_SENT','LINK_CANCELLED','APPLICATION_VERIFIED','APPLICATION_SUBMITTED','SSN_REVEALED','DOCUMENT_UPLOADED','DOCUMENT_VERIFIED','DOCUMENT_VIEWED','SCREENING_CHECKED','MVR_UPLOADED','MVR_VIEWED','CORRECTIONS_REQUESTED','SENT_FOR_DECISION','APPROVED','MORE_INFO_REQUESTED','PRE_ADVERSE_RECORDED','REJECTED'`;
export class DriverConsents1792910000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE driver_consent_documents (id uuid PRIMARY KEY,
   kind varchar NOT NULL CHECK (kind IN ('BACKGROUND_DISCLOSURE','BACKGROUND_AUTHORIZATION','CLEARINGHOUSE_CONSENT')),
   version integer NOT NULL CHECK (version > 0), title varchar(200) NOT NULL, sha256 char(64) NOT NULL, "byteSize" integer NOT NULL, "pageCount" integer NOT NULL,
   "uploadedBy" uuid NOT NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE (kind, version))`);
  await q.query(`CREATE TABLE driver_consent_views ("driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   "documentId" uuid NOT NULL REFERENCES driver_consent_documents(id), "firstViewedAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("driverId", "documentId"))`);
  // No ON DELETE CASCADE: a signature is append-only evidence (the trigger below refuses deletes), so a driver who signed
  // can't be deleted while it exists, and the foreign key says so plainly. A retention job, once authorized, decides how
  // signatures end. Views are only a step before signing and go with the driver.
  await q.query(`CREATE TABLE driver_consent_signatures (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "driverId" uuid NOT NULL REFERENCES drivers(id), "documentId" uuid NOT NULL REFERENCES driver_consent_documents(id),
   "typedName" varchar(200) NOT NULL, "signatureImage" bytea NULL, "signatureMethod" varchar NULL CHECK ("signatureMethod" IN ('DRAWN','TYPED')),
   consent text NOT NULL, statement text NOT NULL, "documentSha256" char(64) NOT NULL, "ipAddress" varchar(64) NULL, "userAgent" varchar(500) NULL,
   "signedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("driverId", "documentId"), CHECK (("signatureImage" IS NULL) = ("signatureMethod" IS NULL)))`);
  // refuse_evidence_change() comes from OnboardingDocuments1792710000000.
  await q.query(`CREATE TRIGGER driver_consent_documents_append_only BEFORE UPDATE OR DELETE ON driver_consent_documents FOR EACH ROW EXECUTE FUNCTION refuse_evidence_change()`);
  await q.query(`CREATE TRIGGER driver_consent_signatures_append_only BEFORE UPDATE OR DELETE ON driver_consent_signatures FOR EACH ROW EXECUTE FUNCTION refuse_evidence_change()`);
  // How the driver's authorization was on file when the MVR was uploaded; NULL on reports from before this check.
  await q.query(`ALTER TABLE driver_reports ADD "authorization" varchar NULL CHECK ("authorization" IN ('SIGNED','PAPER'))`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS},'CONSENT_SIGNED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_consent_documents) OR EXISTS(SELECT 1 FROM driver_reports WHERE "authorization" IS NOT NULL)
   OR EXISTS(SELECT 1 FROM driver_events WHERE event = 'CONSENT_SIGNED') AS kept`);
  if (data.kept) throw new Error('Cannot discard driver consent forms or signatures');
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS}))`);
  await q.query(`ALTER TABLE driver_reports DROP COLUMN "authorization"`);
  await q.query(`DROP TABLE driver_consent_signatures, driver_consent_views, driver_consent_documents`);
 }
}
