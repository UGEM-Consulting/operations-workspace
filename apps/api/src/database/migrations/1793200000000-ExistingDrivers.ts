import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_EXISTING, EVENTS_AFTER_LICENSE } from '../driver-event-lists';
// Existing drivers (section 34, designed 2026-11-10 and approved 2026-11-12): drivers already on the road are added from
// their paper qualification file as Cleared. existing_driver_records says who added them, from which file and their hire
// date; driver_paper_items is the paper file checklist; the license, medical card and work authorization dates typed from
// the paper file are driver_documents rows with fromPaper (no file, already checked), so holds, Expiring documents and
// reminders read them like any checked scan; a last yearly review from the paper file is a driver_annual_reviews row with
// fromPaper. A catch-up link (driver_links purpose CATCH_UP) asks the driver for photos of their current documents and the
// current consent forms. The new columns default so rows an older API writes stay correct.
export const PAPER_ITEMS = `'APPLICATION','MVR_AT_HIRE','ROAD_TEST','PREVIOUS_EMPLOYERS','DRUG_TEST','CLEARINGHOUSE','MEDICAL_REGISTRY','E_VERIFY'`;
export class ExistingDrivers1793200000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE existing_driver_records ("driverId" uuid PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE, "hiredOn" date NULL,
   "sourceName" varchar(200) NULL, "addedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE TABLE driver_paper_items ("driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, key varchar NOT NULL CHECK (key IN (${PAPER_ITEMS})),
   status varchar NOT NULL CHECK (status IN ('ON_FILE','NOT_ON_FILE','NOT_NEEDED')), "doneOn" date NULL, note varchar(1000) NULL,
   "updatedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "updatedAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("driverId", key),
   CONSTRAINT "CHK_driver_paper_items_note" CHECK (status = 'ON_FILE' OR note IS NOT NULL))`);
  await q.query(`ALTER TABLE driver_documents ADD COLUMN "fromPaper" boolean NOT NULL DEFAULT false, ALTER COLUMN sha256 DROP NOT NULL, ALTER COLUMN "byteSize" DROP NOT NULL,
   DROP CONSTRAINT "driver_documents_pageCount_check",
   ADD CONSTRAINT "CHK_driver_documents_pages" CHECK (CASE WHEN "fromPaper" THEN "pageCount" = 0 AND sha256 IS NULL AND "byteSize" IS NULL AND "verifiedAt" IS NOT NULL
    ELSE "pageCount" BETWEEN 1 AND 4 AND sha256 IS NOT NULL AND "byteSize" IS NOT NULL END)`);
  await q.query(`ALTER TABLE driver_annual_reviews ADD COLUMN "fromPaper" boolean NOT NULL DEFAULT false`);
  await q.query(`ALTER TABLE driver_links DROP CONSTRAINT "driver_links_purpose_check", ADD CONSTRAINT "driver_links_purpose_check" CHECK (purpose IN ('APPLICATION','RENEWAL','CATCH_UP'))`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check", ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_EXISTING}))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM existing_driver_records) OR EXISTS(SELECT 1 FROM driver_paper_items) OR EXISTS(SELECT 1 FROM driver_documents WHERE "fromPaper")
   OR EXISTS(SELECT 1 FROM driver_annual_reviews WHERE "fromPaper") OR EXISTS(SELECT 1 FROM driver_links WHERE purpose = 'CATCH_UP')
   OR EXISTS(SELECT 1 FROM driver_events WHERE event IN ('EXISTING_ADDED','PAPER_ITEM_RECORDED','CATCH_UP_LINK_SENT','CATCH_UP_LINK_CANCELLED','CATCH_UP_OPENED','CATCH_UP_SENT')) AS kept`);
  if (data.kept) throw new Error('Refusing to roll back existing drivers while drivers added from a paper file, their paper file, catch-up links or their events exist.');
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check", ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_LICENSE}))`);
  await q.query(`ALTER TABLE driver_links DROP CONSTRAINT "driver_links_purpose_check", ADD CONSTRAINT "driver_links_purpose_check" CHECK (purpose IN ('APPLICATION','RENEWAL'))`);
  await q.query(`ALTER TABLE driver_annual_reviews DROP COLUMN "fromPaper"`);
  await q.query(`ALTER TABLE driver_documents DROP CONSTRAINT "CHK_driver_documents_pages", ADD CONSTRAINT "driver_documents_pageCount_check" CHECK ("pageCount" BETWEEN 1 AND 4),
   ALTER COLUMN sha256 SET NOT NULL, ALTER COLUMN "byteSize" SET NOT NULL, DROP COLUMN "fromPaper"`);
  await q.query(`DROP TABLE driver_paper_items`);
  await q.query(`DROP TABLE existing_driver_records`);
 }
}
