import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_INCIDENTS, EVENTS_AFTER_TRUCKS } from '../driver-event-lists';
// Owner-operator trucks and documents (Safety compliance, phase 6): an approved or cleared owner-operator's truck (unit, VIN,
// year, make, plate) and its lease, insurance and registration PDFs in private storage, with the expiration dates a person
// types from them (no OCR, no policy or account numbers). A newer file replaces the current one of its kind; replaced
// files and rows are kept. Trucks are archived, never deleted. Company-owned trucks and linking a truck to a dispatch
// assignment are not part of this slice.
export class OwnerOperatorTrucks1793080000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_TRUCKS}))`);
  await q.query(`CREATE TABLE driver_trucks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   unit varchar(20) NOT NULL CHECK (length(btrim(unit)) > 0), vin varchar(17) NOT NULL CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
   year smallint NOT NULL CHECK (year BETWEEN 1980 AND 2100), make varchar(40) NOT NULL CHECK (length(btrim(make)) > 0),
   plate varchar(12) NULL, "plateState" varchar(2) NULL, "archivedAt" timestamptz NULL, "createdBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), CHECK ((plate IS NULL) = ("plateState" IS NULL)))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_trucks_vin" ON driver_trucks (vin) WHERE "archivedAt" IS NULL`);
  await q.query(`CREATE INDEX "IDX_driver_trucks_driver" ON driver_trucks ("driverId")`);
  await q.query(`CREATE TABLE driver_owner_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   "truckId" uuid NOT NULL REFERENCES driver_trucks(id), kind varchar NOT NULL CHECK (kind IN ('LEASE','INSURANCE','REGISTRATION')),
   "expiresOn" date NULL, "pageCount" smallint NOT NULL CHECK ("pageCount" > 0), sha256 varchar(64) NOT NULL, "byteSize" integer NOT NULL,
   "storageLayout" smallint NOT NULL DEFAULT 2 CHECK ("storageLayout" IN (1, 2)), "uploadedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   "createdAt" timestamptz NOT NULL DEFAULT now(), "replacedAt" timestamptz NULL, CHECK (kind = 'LEASE' OR "expiresOn" IS NOT NULL))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_owner_documents_current" ON driver_owner_documents ("truckId", kind) WHERE "replacedAt" IS NULL`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_trucks) OR EXISTS(SELECT 1 FROM driver_owner_documents)
   OR EXISTS(SELECT 1 FROM driver_events WHERE event IN ('TRUCK_SAVED','OWNER_DOCUMENT_UPLOADED','OWNER_DOCUMENT_VIEWED')) AS kept`);
  if (data.kept) throw new Error('Cannot discard owner-operator trucks or documents');
  await q.query(`DROP TABLE driver_owner_documents, driver_trucks`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_INCIDENTS}))`);
 }
}
