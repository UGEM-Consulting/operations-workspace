import { MigrationInterface, QueryRunner } from 'typeorm';
// Driver clearance and dispatch assignment (agreed driver plan; designed in the Design System 2026-10-30): after the
// Safety manager approves a driver, their safety staff owner works through a fixed clearance checklist (results only, no
// medical or drug test details), records the previous employers asked about the driver's safety record, and marks the
// driver Cleared. Dispatch then assigns a cleared driver to an MC and a dispatcher; assignments are history like owners.
const EVENTS = `'CREATED','UPDATED','WITHDRAWN','REOPENED','SAFETY_LEAD_CHANGED','OWNER_ASSIGNED','LINK_SENT','LINK_CANCELLED','APPLICATION_VERIFIED','APPLICATION_SUBMITTED','SSN_REVEALED','DOCUMENT_UPLOADED','DOCUMENT_VERIFIED','DOCUMENT_VIEWED','SCREENING_CHECKED','MVR_UPLOADED','MVR_VIEWED','CORRECTIONS_REQUESTED','SENT_FOR_DECISION','APPROVED','MORE_INFO_REQUESTED','PRE_ADVERSE_RECORDED','REJECTED','CONSENT_SIGNED'`;
const NEW_EVENTS = `'CLEARANCE_RECORDED','EMPLOYER_RECORDED','CLEARED','DISPATCH_ASSIGNED'`;
export class DriverClearance1792930000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS},${NEW_EVENTS}))`);
  await q.query(`ALTER TABLE drivers ADD "clearedAt" timestamptz NULL, ADD "clearedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   ADD CONSTRAINT "CHK_drivers_cleared" CHECK (status <> 'CLEARED' OR "clearedAt" IS NOT NULL)`);
  // No row is "not started". A completed item has the date it was done; the drug test clears only on a negative result
  // and the Clearinghouse query only with no violations. Only previous employers and the road test can be not needed,
  // and that needs a note (for example: no earlier DOT employer).
  await q.query(`CREATE TABLE driver_clearance_items ("driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   key varchar NOT NULL CHECK (key IN ('DRUG_TEST','CLEARINGHOUSE','PREVIOUS_EMPLOYERS','MEDICAL_REGISTRY','ROAD_TEST')),
   status varchar NOT NULL CHECK (status IN ('IN_PROGRESS','BLOCKED','COMPLETED','NOT_NEEDED')),
   result varchar NULL CHECK (result IN ('NEGATIVE','NOT_NEGATIVE','CANCELLED','NO_VIOLATIONS','VIOLATIONS')),
   "doneOn" date NULL, note varchar(1000) NULL, "updatedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "updatedAt" timestamptz NOT NULL,
   PRIMARY KEY ("driverId", key),
   CHECK (status <> 'COMPLETED' OR "doneOn" IS NOT NULL),
   CHECK (status <> 'NOT_NEEDED' OR (key IN ('PREVIOUS_EMPLOYERS','ROAD_TEST') AND note IS NOT NULL)),
   CHECK (status <> 'BLOCKED' OR note IS NOT NULL OR key IN ('DRUG_TEST','CLEARINGHOUSE')),
   CHECK ((result IS NULL) = (key NOT IN ('DRUG_TEST','CLEARINGHOUSE'))),
   CHECK (key <> 'DRUG_TEST' OR result IN ('NEGATIVE','NOT_NEGATIVE','CANCELLED')),
   CHECK (key <> 'CLEARINGHOUSE' OR result IN ('NO_VIOLATIONS','VIOLATIONS')),
   CHECK (key <> 'DRUG_TEST' OR (status = 'COMPLETED') = (result = 'NEGATIVE')),
   CHECK (key <> 'CLEARINGHOUSE' OR (status = 'COMPLETED') = (result = 'NO_VIOLATIONS')))`);
  // Months as YYYY-MM. An employer is removable only until Safety asks them; an answer needs the request first. An
  // employer who never answers needs a recorded good-faith effort (when, and what Safety did) instead.
  await q.query(`CREATE TABLE driver_previous_employers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   name varchar(200) NOT NULL, "fromMonth" char(7) NOT NULL CHECK ("fromMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
   "toMonth" char(7) NOT NULL CHECK ("toMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), "requestedOn" date NULL, "answeredOn" date NULL,
   "goodFaithOn" date NULL, "goodFaithNote" varchar(500) NULL,
   "createdBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
   CHECK ("toMonth" >= "fromMonth"), CHECK ("answeredOn" IS NULL OR ("requestedOn" IS NOT NULL AND "answeredOn" >= "requestedOn")),
   CHECK (("goodFaithOn" IS NULL) = ("goodFaithNote" IS NULL)), CHECK ("goodFaithOn" IS NULL OR ("requestedOn" IS NOT NULL AND "goodFaithOn" >= "requestedOn")))`);
  await q.query(`CREATE INDEX "IDX_driver_previous_employers_driver" ON driver_previous_employers ("driverId")`);
  // Which MC and dispatcher a cleared driver works with, from a date; the open row (no endedAt) is now.
  await q.query(`CREATE TABLE driver_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   "mcId" uuid NOT NULL REFERENCES mcs(id), "memberId" uuid NOT NULL REFERENCES dispatch_members(id), truck varchar(40) NULL,
   "startedAt" timestamptz NOT NULL, "endedAt" timestamptz NULL, reason varchar(500) NULL, "actorId" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   "createdAt" timestamptz NOT NULL DEFAULT now(), CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_assignments_open" ON driver_assignments ("driverId") WHERE "endedAt" IS NULL`);
  await q.query(`CREATE INDEX "IDX_driver_assignments_member" ON driver_assignments ("memberId") WHERE "endedAt" IS NULL`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_clearance_items) OR EXISTS(SELECT 1 FROM driver_previous_employers) OR EXISTS(SELECT 1 FROM driver_assignments)
   OR EXISTS(SELECT 1 FROM drivers WHERE "clearedAt" IS NOT NULL) OR EXISTS(SELECT 1 FROM driver_events WHERE event IN (${NEW_EVENTS})) AS kept`);
  if (data.kept) throw new Error('Cannot discard driver clearance or dispatch assignments');
  await q.query(`DROP TABLE driver_assignments, driver_previous_employers, driver_clearance_items`);
  await q.query(`ALTER TABLE drivers DROP CONSTRAINT "CHK_drivers_cleared", DROP COLUMN "clearedBy", DROP COLUMN "clearedAt"`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS}))`);
 }
}
