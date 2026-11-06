import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_RENEWALS, EVENTS_AFTER_TRUCKS } from '../driver-event-lists';
// Renewing a cleared driver's license or medical card (designed as the Renewing a document group, approved 2026-11-06).
// Safety uploads the renewed document already checked, or sends the driver a link (a driver_links row with purpose
// RENEWAL, one open per document kind) to scan only that document, which a person then checks or marks as not readable.
// The hold counts only checked documents. Existing rows keep purpose APPLICATION and no uploader, so an older API
// writing during an overlapping deploy stays correct.
export class DocumentRenewals1793090000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_RENEWALS}))`);
  await q.query(`ALTER TABLE driver_links ADD COLUMN purpose varchar NOT NULL DEFAULT 'APPLICATION' CHECK (purpose IN ('APPLICATION','RENEWAL')),
   ADD COLUMN "documentKind" varchar NULL CHECK ("documentKind" IN ('LICENSE','MEDICAL_CARD')),
   ADD CONSTRAINT "CHK_driver_links_renewal_kind" CHECK ((purpose = 'RENEWAL') = ("documentKind" IS NOT NULL))`);
  // One open application link per driver, and one open renewal link per document kind.
  await q.query(`DROP INDEX "UQ_driver_links_open"`);
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_links_open" ON driver_links ("driverId", (coalesce("documentKind", ''))) WHERE "revokedAt" IS NULL AND "completedAt" IS NULL`);
  await q.query(`ALTER TABLE driver_documents ADD COLUMN "uploadedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   ADD COLUMN "unreadableAt" timestamptz NULL, ADD COLUMN "unreadableBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   ADD CONSTRAINT "CHK_driver_documents_unreadable" CHECK ("unreadableAt" IS NULL OR "verifiedAt" IS NULL)`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_links WHERE purpose = 'RENEWAL')
   OR EXISTS(SELECT 1 FROM driver_documents WHERE "uploadedBy" IS NOT NULL OR "unreadableAt" IS NOT NULL)
   OR EXISTS(SELECT 1 FROM driver_events WHERE event IN ('RENEWAL_LINK_SENT','RENEWAL_LINK_CANCELLED','RENEWAL_OPENED','DOCUMENT_RENEWED','DOCUMENT_UNREADABLE')) AS kept`);
  if (data.kept) throw new Error('Cannot discard document renewals');
  await q.query(`ALTER TABLE driver_documents DROP CONSTRAINT "CHK_driver_documents_unreadable", DROP COLUMN "unreadableBy", DROP COLUMN "unreadableAt", DROP COLUMN "uploadedBy"`);
  await q.query(`DROP INDEX "UQ_driver_links_open"`);
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_links_open" ON driver_links ("driverId") WHERE "revokedAt" IS NULL AND "completedAt" IS NULL`);
  await q.query(`ALTER TABLE driver_links DROP CONSTRAINT "CHK_driver_links_renewal_kind", DROP COLUMN "documentKind", DROP COLUMN purpose`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_TRUCKS}))`);
 }
}
