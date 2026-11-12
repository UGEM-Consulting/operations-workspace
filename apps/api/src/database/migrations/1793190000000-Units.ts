import { MigrationInterface, QueryRunner } from 'typeorm';
// Units (section 34, revised and approved 2026-11-12): trucks and trailers, each owned by a truck owner (a company that
// leases its trucks to the carrier and hires their drivers), an owner-operator (a driver), or the company (trailers only).
// driver_trucks, the owner-operator trucks built in section 33, becomes the units table, so those trucks are units with
// nothing copied and an older API can keep reading and writing them during an overlapping deploy (its rows default to
// SEMI with their driver as owner). The workspace keeps dates for reminders (registration, the yearly inspection, each
// permit); files are optional, since the papers live in DataTruck and the truck binder. Dispatch picks a truck and a trailer.
const REMINDER_SUBJECTS = `'DOCUMENT','OWNER_DOCUMENT','ANNUAL_REVIEW'`, REMINDER_KINDS = `'LICENSE','MEDICAL_CARD','WORK_AUTHORIZATION','INSURANCE','REGISTRATION','ANNUAL_REVIEW'`;
const UNIT_EVENTS = `'ADDED','UPDATED','DATES_RECORDED','PERMITS_RENEWED','FILE_ADDED','FILE_VIEWED','OUT_OF_SERVICE','IN_SERVICE','ARCHIVED','RESPONSIBLE_CHANGED','OWNER_ADDED','OWNER_UPDATED','OWNER_ARCHIVED'`;
export class Units1793190000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE truck_owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL CHECK (length(btrim(name)) > 0), "nameKey" varchar(200) NOT NULL,
   "signerName" varchar(100) NULL, "signerTitle" varchar(60) NULL, email varchar(254) NULL, phone varchar(40) NULL, "archivedAt" timestamptz NULL, version integer NOT NULL DEFAULT 1,
   "createdBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE UNIQUE INDEX "UQ_truck_owners_name" ON truck_owners ("nameKey") WHERE "archivedAt" IS NULL`);
  await q.query(`ALTER TABLE driver_trucks ALTER COLUMN "driverId" DROP NOT NULL,
   ADD COLUMN kind varchar(10) NOT NULL DEFAULT 'SEMI' CHECK (kind IN ('SEMI','PICKUP','TRAILER')),
   ADD COLUMN "ownerId" uuid NULL REFERENCES truck_owners(id),
   ADD COLUMN company boolean NOT NULL DEFAULT false,
   ADD COLUMN "trailerType" varchar(60) NULL,
   ADD COLUMN "registrationExpiresOn" date NULL,
   ADD COLUMN "inspectedOn" date NULL,
   ADD COLUMN "outOfServiceAt" timestamptz NULL,
   ADD COLUMN "responsibleId" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   ADD COLUMN version integer NOT NULL DEFAULT 1,
   ADD CONSTRAINT "CHK_driver_trucks_owner" CHECK (num_nonnulls("driverId", "ownerId") + CASE WHEN company THEN 1 ELSE 0 END = 1),
   ADD CONSTRAINT "CHK_driver_trucks_company" CHECK (NOT company OR kind = 'TRAILER'),
   ADD CONSTRAINT "CHK_driver_trucks_trailer_type" CHECK ("trailerType" IS NULL OR kind = 'TRAILER')`);
  // A unit number is looked up as painted, ignoring case (unique among current units is enforced when one is saved, so
  // numbers recorded twice before this stay as they are).
  await q.query(`CREATE INDEX "IDX_driver_trucks_unit" ON driver_trucks (lower(unit)) WHERE "archivedAt" IS NULL`);
  // Existing owner-operator trucks: their Safety contact is responsible, and the registration's date comes along.
  await q.query(`UPDATE driver_trucks t SET "responsibleId" = o."ownerId" FROM driver_owners o WHERE o."driverId" = t."driverId" AND o."endedAt" IS NULL`);
  await q.query(`UPDATE driver_trucks t SET "registrationExpiresOn" = d."expiresOn" FROM driver_owner_documents d WHERE d."truckId" = t.id AND d.kind = 'REGISTRATION' AND d."replacedAt" IS NULL`);
  await q.query(`CREATE TABLE unit_permits ("unitId" uuid NOT NULL REFERENCES driver_trucks(id), kind varchar(10) NOT NULL CHECK (kind IN ('NY_HUT','KYU','NM','OR','IFTA')),
   "expiresOn" date NOT NULL, "updatedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "updatedAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("unitId", kind))`);
  await q.query(`CREATE TABLE unit_files (id uuid PRIMARY KEY, "unitId" uuid NOT NULL REFERENCES driver_trucks(id), kind varchar(20) NOT NULL CHECK (kind IN ('REGISTRATION','INSPECTION','PERMITS','OTHER')),
   "pageCount" smallint NOT NULL CHECK ("pageCount" > 0), sha256 char(64) NOT NULL, "byteSize" integer NOT NULL, "uploadedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   "createdAt" timestamptz NOT NULL DEFAULT now(), "replacedAt" timestamptz NULL)`);
  await q.query(`CREATE INDEX "IDX_unit_files_unit" ON unit_files ("unitId")`);
  await q.query(`CREATE TABLE unit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "unitId" uuid NULL REFERENCES driver_trucks(id), "ownerId" uuid NULL REFERENCES truck_owners(id),
   "actorId" uuid NULL REFERENCES users(id) ON DELETE SET NULL, event varchar(30) NOT NULL CHECK (event IN (${UNIT_EVENTS})), metadata jsonb NOT NULL DEFAULT '{}',
   "createdAt" timestamptz NOT NULL DEFAULT now(), CHECK (num_nonnulls("unitId", "ownerId") = 1))`);
  await q.query(`CREATE INDEX "IDX_unit_events_unit" ON unit_events ("unitId")`);
  await q.query(`CREATE INDEX "IDX_unit_events_owner" ON unit_events ("ownerId")`);
  // Dispatch's assignment names the truck and the trailer from Units; the free-text truck stays for older readers.
  await q.query(`ALTER TABLE driver_assignments ADD COLUMN "unitId" uuid NULL REFERENCES driver_trucks(id), ADD COLUMN "trailerId" uuid NULL REFERENCES driver_trucks(id)`);
  await q.query(`CREATE INDEX "IDX_driver_assignments_unit" ON driver_assignments ("unitId") WHERE "unitId" IS NOT NULL`);
  await q.query(`CREATE INDEX "IDX_driver_assignments_trailer" ON driver_assignments ("trailerId") WHERE "trailerId" IS NOT NULL`);
  // The morning reminders tell the responsible Safety Manager about unit dates too (staff only): a unit subject names the
  // unit, never a driver. Each date is its own subject, so a registration and an inspection due the same day both count.
  await q.query(`ALTER TABLE safety_reminders ALTER COLUMN "driverId" DROP NOT NULL,
   DROP CONSTRAINT "safety_reminders_subject_check", ADD CONSTRAINT "safety_reminders_subject_check" CHECK (subject IN (${REMINDER_SUBJECTS},'UNIT_REGISTRATION','UNIT_INSPECTION','UNIT_PERMIT')),
   DROP CONSTRAINT "safety_reminders_kind_check", ADD CONSTRAINT "safety_reminders_kind_check" CHECK (kind IN (${REMINDER_KINDS},'INSPECTION','PERMIT')),
   ADD CONSTRAINT "CHK_safety_reminders_unit" CHECK ((subject LIKE 'UNIT\\_%') = ("driverId" IS NULL) AND (subject NOT LIKE 'UNIT\\_%' OR audience = 'STAFF'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM truck_owners) OR EXISTS(SELECT 1 FROM unit_permits) OR EXISTS(SELECT 1 FROM unit_files) OR EXISTS(SELECT 1 FROM unit_events)
   OR EXISTS(SELECT 1 FROM driver_trucks WHERE "driverId" IS NULL OR kind <> 'SEMI') OR EXISTS(SELECT 1 FROM driver_assignments WHERE "unitId" IS NOT NULL OR "trailerId" IS NOT NULL)
   OR EXISTS(SELECT 1 FROM safety_reminders WHERE "driverId" IS NULL) AS kept`);
  if (data.kept) throw new Error('Refusing to roll back units while truck owners, trailers, pickups, permits, unit files, unit history, units on assignments or unit reminders exist.');
  await q.query(`ALTER TABLE safety_reminders DROP CONSTRAINT "CHK_safety_reminders_unit",
   DROP CONSTRAINT "safety_reminders_subject_check", ADD CONSTRAINT "safety_reminders_subject_check" CHECK (subject IN (${REMINDER_SUBJECTS})),
   DROP CONSTRAINT "safety_reminders_kind_check", ADD CONSTRAINT "safety_reminders_kind_check" CHECK (kind IN (${REMINDER_KINDS})), ALTER COLUMN "driverId" SET NOT NULL`);
  await q.query(`ALTER TABLE driver_assignments DROP COLUMN "unitId", DROP COLUMN "trailerId"`);
  await q.query(`DROP TABLE unit_events, unit_files, unit_permits`);
  await q.query(`DROP INDEX "IDX_driver_trucks_unit"`);
  await q.query(`ALTER TABLE driver_trucks DROP CONSTRAINT "CHK_driver_trucks_owner", DROP CONSTRAINT "CHK_driver_trucks_company", DROP CONSTRAINT "CHK_driver_trucks_trailer_type",
   DROP COLUMN kind, DROP COLUMN "ownerId", DROP COLUMN company, DROP COLUMN "trailerType", DROP COLUMN "registrationExpiresOn", DROP COLUMN "inspectedOn", DROP COLUMN "outOfServiceAt",
   DROP COLUMN "responsibleId", DROP COLUMN version, ALTER COLUMN "driverId" SET NOT NULL`);
  await q.query(`DROP TABLE truck_owners`);
 }
}
