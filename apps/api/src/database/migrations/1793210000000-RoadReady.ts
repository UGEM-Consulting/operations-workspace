import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_EXISTING, EVENTS_AFTER_ROAD_READY } from '../driver-event-lists';
// Contracts and Ready for the road (section 39, designed and approved 2026-11-12).
// The Driver and Contractor Acknowledgement is a form Safety publishes (a consent form kind no application asks for). A
// driver on a truck owner's truck signs it through a link (driver_links purpose CONTRACT), then the owner's signer through a
// one-time link bound to the owner's email (purpose CONTRACT_OWNER): both are driver links, with the same emailed code, and
// each opens only that one document. driver_contracts keeps both signatures, append-only once signed. Paper contracts with a
// truck owner (the IC agreement, the equipment lease, a receipt) are uploaded as signed PDFs (owner_contract_files).
// Ready for the road starts when a driver is cleared (driver_road_ready): eight steps, some read from the records (unit,
// acknowledgement, permits) and the rest marked by hand (driver_road_ready_steps). When a driver leaves, changes dispatcher
// or changes truck after the truck's Telegram group was made, their Safety Manager gets a step to update it by hand
// (telegram_group_changes): the workspace can't change Telegram groups.
const UNIT_EVENTS_BEFORE = `'ADDED','UPDATED','DATES_RECORDED','PERMITS_RENEWED','FILE_ADDED','FILE_VIEWED','OUT_OF_SERVICE','IN_SERVICE','ARCHIVED','RESPONSIBLE_CHANGED','OWNER_ADDED','OWNER_UPDATED','OWNER_ARCHIVED'`;
const CONSENTS_BEFORE = `'BACKGROUND_DISCLOSURE','BACKGROUND_AUTHORIZATION','CLEARINGHOUSE_CONSENT','PSP_AUTHORIZATION','DOT_TESTING_AUTHORIZATION','APPLICATION_CERTIFICATION'`;
export const ROAD_READY_STEPS = `'BINDER','SAMSARA','DECALS','ORIENTATION','TELEGRAM_GROUP'`;
export class RoadReady1793210000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_consent_documents DROP CONSTRAINT "driver_consent_documents_kind_check", ADD CONSTRAINT "driver_consent_documents_kind_check" CHECK (kind IN (${CONSENTS_BEFORE},'CONTRACTOR_ACKNOWLEDGEMENT'))`);
  await q.query(`CREATE TABLE driver_contracts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id), "unitId" uuid NOT NULL REFERENCES driver_trucks(id),
   "ownerId" uuid NOT NULL REFERENCES truck_owners(id), "documentId" uuid NOT NULL REFERENCES driver_consent_documents(id), "createdBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   "createdAt" timestamptz NOT NULL DEFAULT now(), "cancelledAt" timestamptz NULL,
   "driverName" varchar(200) NULL, "driverAddress" varchar(300) NULL, "driverImage" bytea NULL, "driverMethod" varchar NULL CHECK ("driverMethod" IN ('DRAWN','TYPED')), "driverConsent" text NULL, "driverStatement" text NULL,
   "driverIp" varchar(64) NULL, "driverAgent" varchar(500) NULL, "driverSignedAt" timestamptz NULL, "driverViewedAt" timestamptz NULL,
   "ownerName" varchar(200) NULL, "ownerTitle" varchar(100) NULL, "ownerCompany" varchar(200) NULL, "ownerImage" bytea NULL, "ownerMethod" varchar NULL CHECK ("ownerMethod" IN ('DRAWN','TYPED')), "ownerConsent" text NULL, "ownerStatement" text NULL,
   "ownerIp" varchar(64) NULL, "ownerAgent" varchar(500) NULL, "ownerSignedAt" timestamptz NULL, "ownerViewedAt" timestamptz NULL, "documentSha256" char(64) NOT NULL,
   CONSTRAINT "CHK_driver_contracts_driver" CHECK (("driverSignedAt" IS NULL) = ("driverName" IS NULL) AND ("driverSignedAt" IS NULL) = ("driverImage" IS NULL)),
   CONSTRAINT "CHK_driver_contracts_owner" CHECK (("ownerSignedAt" IS NULL) = ("ownerName" IS NULL) AND ("ownerSignedAt" IS NULL) = ("ownerImage" IS NULL) AND ("ownerSignedAt" IS NULL OR "driverSignedAt" IS NOT NULL)))`);
  // One open acknowledgement per driver and unit; a signed one is evidence and stays.
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_contracts_open" ON driver_contracts ("driverId", "unitId") WHERE "cancelledAt" IS NULL AND "ownerSignedAt" IS NULL`);
  await q.query(`CREATE INDEX "IDX_driver_contracts_unit" ON driver_contracts ("unitId")`);
  // Signatures can't change once given: only cancelling an unsigned one, and the owner's signature after the driver's.
  await q.query(`CREATE FUNCTION refuse_contract_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF TG_OP = 'DELETE' OR OLD."ownerSignedAt" IS NOT NULL OR (OLD."driverSignedAt" IS NOT NULL AND (NEW."driverSignedAt" IS DISTINCT FROM OLD."driverSignedAt" OR NEW."driverName" IS DISTINCT FROM OLD."driverName"
    OR NEW."driverImage" IS DISTINCT FROM OLD."driverImage" OR NEW."driverAddress" IS DISTINCT FROM OLD."driverAddress"))
    OR NEW."documentId" <> OLD."documentId" OR NEW."unitId" <> OLD."unitId" OR NEW."ownerId" <> OLD."ownerId" OR NEW."driverId" <> OLD."driverId" OR NEW."documentSha256" <> OLD."documentSha256" THEN
    RAISE EXCEPTION 'Signed contracts are append-only';
   END IF; RETURN NEW; END $$`);
  await q.query(`CREATE TRIGGER driver_contracts_append_only BEFORE UPDATE OR DELETE ON driver_contracts FOR EACH ROW EXECUTE FUNCTION refuse_contract_change()`);
  await q.query(`ALTER TABLE driver_links ADD COLUMN "contractId" uuid NULL REFERENCES driver_contracts(id), DROP CONSTRAINT "driver_links_purpose_check",
   ADD CONSTRAINT "driver_links_purpose_check" CHECK (purpose IN ('APPLICATION','RENEWAL','CATCH_UP','CONTRACT','CONTRACT_OWNER')),
   ADD CONSTRAINT "CHK_driver_links_contract" CHECK ((purpose IN ('CONTRACT','CONTRACT_OWNER')) = ("contractId" IS NOT NULL))`);
  // A contract's two links (the driver's and the owner's) are open one at a time each, apart from the application's.
  await q.query(`DROP INDEX "UQ_driver_links_open"`);
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_links_open" ON driver_links ("driverId", (coalesce("documentKind", '')), purpose, (coalesce("contractId"::text, ''))) WHERE "revokedAt" IS NULL AND "completedAt" IS NULL`);
  await q.query(`CREATE TABLE owner_contract_files (id uuid PRIMARY KEY, "ownerId" uuid NOT NULL REFERENCES truck_owners(id), kind varchar NOT NULL CHECK (kind IN ('IC_AGREEMENT','EQUIPMENT_LEASE','EQUIPMENT_RECEIPT','OTHER')),
   title varchar(120) NULL, "unitId" uuid NULL REFERENCES driver_trucks(id), "signedOn" date NOT NULL, "pageCount" smallint NOT NULL CHECK ("pageCount" > 0), sha256 char(64) NOT NULL, "byteSize" integer NOT NULL,
   "uploadedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "replacedAt" timestamptz NULL, "storageLayout" smallint NOT NULL DEFAULT 2,
   CONSTRAINT "CHK_owner_contract_files_other" CHECK (kind <> 'OTHER' OR title IS NOT NULL))`);
  await q.query(`CREATE INDEX "IDX_owner_contract_files_owner" ON owner_contract_files ("ownerId")`);
  await q.query(`CREATE TABLE driver_road_ready ("driverId" uuid PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE, "unitId" uuid NULL REFERENCES driver_trucks(id), "startedAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE TABLE driver_road_ready_steps ("driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, key varchar NOT NULL CHECK (key IN (${ROAD_READY_STEPS})),
   status varchar NOT NULL CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED')), note varchar(500) NULL, "updatedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "updatedAt" timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY ("driverId", key))`);
  await q.query(`CREATE TABLE telegram_group_changes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE, "unitId" uuid NULL REFERENCES driver_trucks(id),
   reason varchar NOT NULL CHECK (reason IN ('DISPATCHER_CHANGED','TRUCK_CHANGED','DRIVER_LEFT')), "removeMemberId" uuid NULL REFERENCES dispatch_members(id), "addMemberId" uuid NULL REFERENCES dispatch_members(id),
   "newUnitId" uuid NULL REFERENCES driver_trucks(id), "createdAt" timestamptz NOT NULL DEFAULT now(), "doneAt" timestamptz NULL, "doneBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL)`);
  await q.query(`CREATE INDEX "IDX_telegram_group_changes_open" ON telegram_group_changes ("driverId") WHERE "doneAt" IS NULL`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check", ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_ROAD_READY}))`);
  await q.query(`ALTER TABLE unit_events DROP CONSTRAINT "unit_events_event_check", ADD CONSTRAINT "unit_events_event_check" CHECK (event IN (${UNIT_EVENTS_BEFORE},'CONTRACT_ADDED','CONTRACT_VIEWED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_contracts) OR EXISTS(SELECT 1 FROM owner_contract_files) OR EXISTS(SELECT 1 FROM driver_road_ready) OR EXISTS(SELECT 1 FROM telegram_group_changes)
   OR EXISTS(SELECT 1 FROM driver_consent_documents WHERE kind = 'CONTRACTOR_ACKNOWLEDGEMENT') OR EXISTS(SELECT 1 FROM unit_events WHERE event IN ('CONTRACT_ADDED','CONTRACT_VIEWED'))
   OR EXISTS(SELECT 1 FROM driver_events WHERE event IN ('CONTRACT_LINK_SENT','CONTRACT_OPENED','CONTRACT_SIGNED','OWNER_LINK_SENT','OWNER_SIGNED','CONTRACT_CANCELLED','ROAD_READY_RECORDED','GROUP_UPDATED')) AS kept,
   -- The earlier index allows one open link per driver and document kind: open links of two purposes (an application and
   -- a catch-up link) would stop the rebuild partway, so the rollback refuses first, before changing anything.
   EXISTS(SELECT 1 FROM driver_links WHERE "revokedAt" IS NULL AND "completedAt" IS NULL GROUP BY "driverId", coalesce("documentKind", '') HAVING count(*) > 1) AS "openLinks"`);
  if (data.kept) throw new Error('Refusing to roll back contracts and Ready for the road while acknowledgements, owner contracts, road-ready steps, group changes or their events exist.');
  if (data.openLinks) throw new Error('Refusing to roll back contracts and Ready for the road while a driver has two open links the earlier index would not allow. Cancel one first.');
  await q.query(`ALTER TABLE unit_events DROP CONSTRAINT "unit_events_event_check", ADD CONSTRAINT "unit_events_event_check" CHECK (event IN (${UNIT_EVENTS_BEFORE}))`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check", ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_EXISTING}))`);
  await q.query(`DROP TABLE telegram_group_changes`);
  await q.query(`DROP TABLE driver_road_ready_steps`);
  await q.query(`DROP TABLE driver_road_ready`);
  await q.query(`DROP TABLE owner_contract_files`);
  await q.query(`DROP INDEX "UQ_driver_links_open"`);
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_links_open" ON driver_links ("driverId", (coalesce("documentKind", ''))) WHERE "revokedAt" IS NULL AND "completedAt" IS NULL`);
  await q.query(`ALTER TABLE driver_links DROP CONSTRAINT "CHK_driver_links_contract", DROP CONSTRAINT "driver_links_purpose_check", DROP COLUMN "contractId",
   ADD CONSTRAINT "driver_links_purpose_check" CHECK (purpose IN ('APPLICATION','RENEWAL','CATCH_UP'))`);
  await q.query(`DROP TABLE driver_contracts`);
  await q.query(`DROP FUNCTION refuse_contract_change()`);
  await q.query(`ALTER TABLE driver_consent_documents DROP CONSTRAINT "driver_consent_documents_kind_check", ADD CONSTRAINT "driver_consent_documents_kind_check" CHECK (kind IN (${CONSENTS_BEFORE}))`);
 }
}
