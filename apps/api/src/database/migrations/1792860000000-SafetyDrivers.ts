import { MigrationInterface, QueryRunner } from 'typeorm';
// Safety onboards drivers (agreed 2026-10-30). New staff roles SAFETY_MANAGER (decides), SAFETY_LEAD (takes leads and
// screens) and SAFETY_STAFF (owns approved drivers). A driver record starts as a lead; the statuses after LEAD are used
// by later slices (application link, screening, decision, clearance). Who owns an approved driver is history in
// driver_owners: one open row per driver. Phone and email are unique among open records so a lead isn't entered twice.
// Role rules live in the service: PostgreSQL cannot use an enum value added in the same transaction.
const CLOSED = `('REJECTED','WITHDRAWN','LEFT')`;
export class SafetyDrivers1792860000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  for (const role of ['SAFETY_MANAGER', 'SAFETY_LEAD', 'SAFETY_STAFF']) await q.query(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS '${role}'`);
  await q.query(`CREATE TABLE drivers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "firstName" varchar(100) NOT NULL, "lastName" varchar(100) NOT NULL,
   phone varchar(40) NOT NULL, "phoneKey" varchar(15) NOT NULL, email varchar(254) NULL,
   "driverType" varchar NOT NULL CHECK ("driverType" IN ('COMPANY','OWNER_OPERATOR')),
   "licenseType" varchar NULL CHECK ("licenseType" IN ('CDL_A','CDL_B','CDL_C','DL')),
   "licenseState" varchar(2) NULL CHECK ("licenseState" ~ '^[A-Z]{2}$'),
   "experienceYears" smallint NULL CHECK ("experienceYears" BETWEEN 0 AND 60),
   source varchar(100) NULL, notes varchar(2000) NULL,
   status varchar NOT NULL DEFAULT 'LEAD' CHECK (status IN ('LEAD','APPLYING','SCREENING','AWAITING_DECISION','APPROVED','CLEARED','REJECTED','WITHDRAWN','LEFT')),
   "statusReason" varchar(500) NULL, "closedAt" timestamptz NULL,
   "safetyLeadId" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "createdBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   version integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CHECK ((status IN ${CLOSED}) = ("closedAt" IS NOT NULL)))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_drivers_open_phone" ON drivers ("phoneKey") WHERE status NOT IN ${CLOSED}`);
  await q.query(`CREATE UNIQUE INDEX "UQ_drivers_open_email" ON drivers (lower(email)) WHERE email IS NOT NULL AND status NOT IN ${CLOSED}`);
  await q.query(`CREATE TABLE driver_owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   "ownerId" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "startedAt" timestamptz NOT NULL DEFAULT now(), "endedAt" timestamptz NULL,
   reason varchar(500) NULL, "actorId" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
   CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_owners_open" ON driver_owners ("driverId") WHERE "endedAt" IS NULL`);
  await q.query(`CREATE TABLE driver_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   "actorId" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   event varchar NOT NULL CHECK (event IN ('CREATED','UPDATED','WITHDRAWN','REOPENED','SAFETY_LEAD_CHANGED','OWNER_ASSIGNED')),
   metadata jsonb NOT NULL DEFAULT '{}', "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE INDEX "IDX_driver_events_driver" ON driver_events ("driverId", "createdAt")`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM drivers) AS drivers, EXISTS(SELECT 1 FROM users WHERE role::text LIKE 'SAFETY_%') AS staff`);
  if (data.drivers || data.staff) throw new Error('Cannot discard driver records or Safety accounts');
  await q.query(`DROP TABLE driver_events`);
  await q.query(`DROP TABLE driver_owners`);
  await q.query(`DROP TABLE drivers`);
  // The SAFETY_* enum values stay: PostgreSQL cannot drop one, and an unused value is harmless to the previous version.
 }
}
