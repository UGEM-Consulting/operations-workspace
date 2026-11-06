import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_INCIDENTS, EVENTS_AFTER_TESTING } from '../driver-event-lists';
// Accidents, violations and roadside inspections (Safety compliance, phase 5): a short factual record per incident of a
// cleared driver. No names of other people, no medical details, no police report numbers. An accident starts with
// preventability undetermined and a violation with its outcome pending; the owner or Safety manager settles them once
// (preventable and disposition can't be changed again). A mistaken entry is voided with a reason, never edited or deleted.
export class DriverIncidents1793070000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_INCIDENTS}))`);
  await q.query(`CREATE TABLE driver_incidents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   kind varchar NOT NULL CHECK (kind IN ('ACCIDENT','VIOLATION','INSPECTION')), "occurredOn" date NOT NULL, state varchar(2) NULL,
   summary varchar(200) NOT NULL CHECK (length(btrim(summary)) > 0),
   preventable varchar NULL CHECK (preventable IN ('YES','NO','UNDETERMINED')), injuries boolean NULL, fatalities boolean NULL, "towAway" boolean NULL,
   disposition varchar NULL CHECK (disposition IN ('PENDING','CONVICTED','DISMISSED')),
   "outOfService" boolean NULL, "violationCount" smallint NULL CHECK ("violationCount" BETWEEN 0 AND 50),
   note varchar(1000) NULL, "recordedBy" uuid NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now(),
   "settledAt" timestamptz NULL, "settledBy" uuid NULL REFERENCES users(id),
   "voidedAt" timestamptz NULL, "voidedBy" uuid NULL REFERENCES users(id), "voidReason" varchar(500) NULL,
   CHECK (("voidedAt" IS NULL) = ("voidReason" IS NULL) AND ("voidedAt" IS NULL) = ("voidedBy" IS NULL)),
   CHECK (kind = 'ACCIDENT' OR (preventable IS NULL AND injuries IS NULL AND fatalities IS NULL AND "towAway" IS NULL)),
   CHECK (kind <> 'ACCIDENT' OR (preventable IS NOT NULL AND injuries IS NOT NULL AND fatalities IS NOT NULL AND "towAway" IS NOT NULL)),
   CHECK ((kind = 'VIOLATION') = (disposition IS NOT NULL)),
   CHECK (kind = 'INSPECTION' OR ("outOfService" IS NULL AND "violationCount" IS NULL)),
   CHECK (kind <> 'INSPECTION' OR ("outOfService" IS NOT NULL AND "violationCount" IS NOT NULL)))`);
  await q.query(`CREATE INDEX "IDX_driver_incidents_driver" ON driver_incidents ("driverId", "occurredOn")`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_incidents) OR EXISTS(SELECT 1 FROM driver_events WHERE event IN ('INCIDENT_RECORDED','INCIDENT_UPDATED','INCIDENT_VOIDED')) AS kept`);
  if (data.kept) throw new Error('Cannot discard recorded driver incidents');
  await q.query(`DROP TABLE driver_incidents`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_TESTING}))`);
 }
}
