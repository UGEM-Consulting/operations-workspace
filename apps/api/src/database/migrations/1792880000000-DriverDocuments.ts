import { MigrationInterface, QueryRunner } from 'typeorm';
// Drivers scan their documents with a phone camera (document scanning Phase 1, agreed 2026-10-30): each document is the
// driver's photographed pages, cleaned of metadata and combined into one PDF in private storage
// (drivers/<driver>/<document>.pdf). One current document per kind; a replacement keeps the row with replacedAt. Safety
// verifies a document by recording its number and expiry date (version-checked; never the number of a work-authorization
// document). No OCR: staff type what they read. Every staff view of a scan is recorded (DOCUMENT_VIEWED).
const EVENTS = `'CREATED','UPDATED','WITHDRAWN','REOPENED','SAFETY_LEAD_CHANGED','OWNER_ASSIGNED','LINK_SENT','LINK_CANCELLED','APPLICATION_VERIFIED','APPLICATION_SUBMITTED','SSN_REVEALED'`;
export class DriverDocuments1792880000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE driver_documents (id uuid PRIMARY KEY, "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   kind varchar NOT NULL CHECK (kind IN ('LICENSE','MEDICAL_CARD','WORK_AUTHORIZATION')),
   subtype varchar NULL CHECK (subtype IN ('US_PASSPORT','GREEN_CARD','WORK_PERMIT','OTHER')),
   "pageCount" smallint NOT NULL CHECK ("pageCount" BETWEEN 1 AND 4), sha256 varchar(64) NOT NULL, "byteSize" integer NOT NULL,
   "createdAt" timestamptz NOT NULL, "replacedAt" timestamptz NULL,
   "verifiedAt" timestamptz NULL, "verifiedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, number varchar(40) NULL, "expiresOn" date NULL,
   version integer NOT NULL DEFAULT 1,
   CHECK ((kind = 'WORK_AUTHORIZATION') = (subtype IS NOT NULL)), CHECK (kind <> 'WORK_AUTHORIZATION' OR number IS NULL))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_documents_current" ON driver_documents ("driverId", kind) WHERE "replacedAt" IS NULL`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS},'DOCUMENT_UPLOADED','DOCUMENT_VERIFIED','DOCUMENT_VIEWED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_documents) OR EXISTS(SELECT 1 FROM driver_events WHERE event IN ('DOCUMENT_UPLOADED','DOCUMENT_VERIFIED','DOCUMENT_VIEWED')) AS kept`);
  if (data.kept) throw new Error('Cannot discard driver documents or their history');
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS}))`);
  await q.query(`DROP TABLE driver_documents`);
 }
}
