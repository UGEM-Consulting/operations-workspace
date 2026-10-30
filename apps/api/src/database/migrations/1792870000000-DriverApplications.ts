import { MigrationInterface, QueryRunner } from 'typeorm';
// Drivers fill in their own application through a link Safety sends (agreed 2026-10-30). A link is bound to the email on
// the driver record and works, with a fresh emailed code each visit, until the driver submits, it expires or Safety
// cancels it; only its SHA-256 hash is stored. The SSN is AES-256-GCM ciphertext (PII_ENCRYPTION_KEY) plus its last four
// digits; the other answers are JSON. Driver sessions use their own store and cookie, separate from staff and applicants.
export class DriverApplications1792870000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE driver_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   "tokenHash" varchar(64) NOT NULL UNIQUE, email varchar(254) NOT NULL, "createdBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   "expiresAt" timestamptz NOT NULL, "openedAt" timestamptz NULL, "revokedAt" timestamptz NULL, "completedAt" timestamptz NULL, "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE UNIQUE INDEX "UQ_driver_links_open" ON driver_links ("driverId") WHERE "revokedAt" IS NULL AND "completedAt" IS NULL`);
  await q.query(`CREATE TABLE driver_challenges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "linkId" uuid NULL REFERENCES driver_links(id) ON DELETE CASCADE,
   email varchar(254) NULL, "codeHash" varchar(64) NULL, "expiresAt" timestamptz NOT NULL, "consumedAt" timestamptz NULL, "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE TABLE driver_applications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL UNIQUE REFERENCES drivers(id) ON DELETE CASCADE,
   status varchar NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED')), fields jsonb NOT NULL DEFAULT '{}',
   "ssnCiphertext" text NULL, "ssnLast4" varchar(4) NULL, version integer NOT NULL DEFAULT 1, "submittedAt" timestamptz NULL,
   "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CHECK (("ssnCiphertext" IS NULL) = ("ssnLast4" IS NULL)), CHECK ((status = 'SUBMITTED') = ("submittedAt" IS NOT NULL)))`);
  await q.query(`CREATE TABLE driver_sessions (LIKE staff_sessions INCLUDING ALL)`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN ('CREATED','UPDATED','WITHDRAWN','REOPENED','SAFETY_LEAD_CHANGED','OWNER_ASSIGNED',
   'LINK_SENT','LINK_CANCELLED','APPLICATION_VERIFIED','APPLICATION_SUBMITTED','SSN_REVEALED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_links) OR EXISTS(SELECT 1 FROM driver_applications) AS kept,
   EXISTS(SELECT 1 FROM driver_events WHERE event IN ('LINK_SENT','LINK_CANCELLED','APPLICATION_VERIFIED','APPLICATION_SUBMITTED','SSN_REVEALED')) AS events`);
  if (data.kept || data.events) throw new Error('Cannot discard driver application links, answers or their history');
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN ('CREATED','UPDATED','WITHDRAWN','REOPENED','SAFETY_LEAD_CHANGED','OWNER_ASSIGNED'))`);
  await q.query(`DROP TABLE driver_sessions, driver_applications, driver_challenges, driver_links`);
 }
}
