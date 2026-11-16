import { MigrationInterface, QueryRunner } from 'typeorm';
// Keeping records for the time the law asks (Design System section 34, "Keeping records for the time the law asks",
// approved 2026-11-16; legal minimums chosen by the user 2026-11-13). Deleting is off until an administrator turns it on;
// once on, what is due is listed 14 days ahead and deleted once a week, files included, unless a person's records are held.
// Audit history stays: event rows keep what happened and when (never values) with their subject set to null, and a driver's
// assignment history keeps the move with the dispatcher's record gone. Signed evidence may be deleted only by this job, which
// sets operations.retention for its own transaction.

/** References that keep their row when the record they point at is deleted: [table, column, parent, how it was, was NOT NULL]. */
const KEPT: [string, string, string, string, boolean][] = [
 ['dispatch_events', 'memberId', 'dispatch_members', 'NO ACTION', false],
 ['driver_events', 'driverId', 'drivers', 'CASCADE', true],
 ['application_activity', 'invitationId', 'invitations', 'NO ACTION', true],
 ['driver_assignments', 'memberId', 'dispatch_members', 'NO ACTION', true],
 ['driver_leave_covers', 'coverMemberId', 'dispatch_members', 'NO ACTION', true],
 ['telegram_group_changes', 'addMemberId', 'dispatch_members', 'NO ACTION', false],
 ['telegram_group_changes', 'removeMemberId', 'dispatch_members', 'NO ACTION', false],
 ['telegram_group_changes', 'unitId', 'driver_trucks', 'NO ACTION', false],
 ['telegram_group_changes', 'newUnitId', 'driver_trucks', 'NO ACTION', false],
 ['teams', 'leadMemberId', 'dispatch_members', 'NO ACTION', false],
 ['dispatch_members', 'previousMemberId', 'dispatch_members', 'NO ACTION', false],
 ['invitations', 'supportsMemberId', 'dispatch_members', 'NO ACTION', false],
 ['invitations', 'catchUpMemberId', 'dispatch_members', 'NO ACTION', false],
 ['owner_contract_files', 'unitId', 'driver_trucks', 'NO ACTION', false],
 ['unit_events', 'unitId', 'driver_trucks', 'NO ACTION', false],
 ['driver_assignments', 'unitId', 'driver_trucks', 'NO ACTION', false],
 ['driver_assignments', 'trailerId', 'driver_trucks', 'NO ACTION', false],
 ['driver_road_ready', 'unitId', 'driver_trucks', 'NO ACTION', false],
 ['promotion_requests', 'itRequestId', 'it_onboarding_requests', 'NO ACTION', false],
 ['it_removal_requests', 'setupRequestId', 'it_onboarding_requests', 'NO ACTION', false],
];
const EVIDENCE = `CREATE OR REPLACE FUNCTION refuse_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
   -- Only the retention job deletes evidence, inside its own transaction.
   IF TG_OP = 'DELETE' AND current_setting('operations.retention', true) = 'on' THEN RETURN OLD; END IF;
   RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME; END $$`;
const EVIDENCE_BEFORE = `CREATE OR REPLACE FUNCTION refuse_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME; END $$`;
const CONTRACT = (retention: boolean) => `CREATE OR REPLACE FUNCTION refuse_contract_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   ${retention ? `IF TG_OP = 'DELETE' AND current_setting('operations.retention', true) = 'on' THEN RETURN OLD; END IF;\n   ` : ''}IF TG_OP = 'DELETE' OR OLD."ownerSignedAt" IS NOT NULL OR (OLD."driverSignedAt" IS NOT NULL AND (NEW."driverSignedAt" IS DISTINCT FROM OLD."driverSignedAt" OR NEW."driverName" IS DISTINCT FROM OLD."driverName"
    OR NEW."driverImage" IS DISTINCT FROM OLD."driverImage" OR NEW."driverAddress" IS DISTINCT FROM OLD."driverAddress"))
    OR NEW."documentId" <> OLD."documentId" OR NEW."unitId" <> OLD."unitId" OR NEW."ownerId" <> OLD."ownerId" OR NEW."driverId" <> OLD."driverId" OR NEW."documentSha256" <> OLD."documentSha256" THEN
    RAISE EXCEPTION 'Signed contracts are append-only';
   END IF; RETURN NEW; END $$`;

async function constraintOf(q: QueryRunner, table: string, column: string): Promise<string> {
 const [row] = await q.query(`SELECT con.conname FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(con.conkey)
  WHERE con.contype = 'f' AND t.relname = $1 AND a.attname = $2`, [table, column]);
 if (!row) throw new Error(`No foreign key on ${table}.${column}`);
 return row.conname;
}
async function setAction(q: QueryRunner, table: string, column: string, parent: string, action: string) {
 const name = await constraintOf(q, table, column);
 await q.query(`ALTER TABLE ${table} DROP CONSTRAINT "${name}", ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES ${parent}(id) ON DELETE ${action}`);
}

export class RetentionJob1793300000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE retention_settings (id smallint PRIMARY KEY CHECK (id = 1), deleting boolean NOT NULL DEFAULT false, "updatedBy" uuid REFERENCES users(id), "updatedAt" timestamptz)`);
  await q.query(`INSERT INTO retention_settings (id) VALUES (1)`);
  await q.query(`CREATE TABLE retention_setting_changes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deleting boolean NOT NULL, "changedBy" uuid NOT NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE TABLE retention_holds (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "subjectKind" varchar NOT NULL CHECK ("subjectKind" IN ('APPLICATION','INVITATION','DRIVER','MEMBER')),
   "subjectId" uuid NOT NULL,
   until date NOT NULL,
   -- Staff text; never health or other private details.
   reason text NOT NULL,
   "createdBy" uuid NOT NULL REFERENCES users(id),
   "createdAt" timestamptz NOT NULL DEFAULT now(),
   changes jsonb NOT NULL DEFAULT '[]',
   "endedAt" timestamptz,
   "endedBy" uuid REFERENCES users(id))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_retention_holds_open" ON retention_holds ("subjectKind", "subjectId") WHERE "endedAt" IS NULL`);
  // One run a day at most; counts only, never who was deleted.
  await q.query(`CREATE TABLE retention_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), day date NOT NULL UNIQUE, "startedAt" timestamptz NOT NULL DEFAULT now(), "finishedAt" timestamptz,
   deleted jsonb NOT NULL DEFAULT '{}', held integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0)`);
  for (const [table, column, parent, , notNull] of KEPT) {
   if (notNull) await q.query(`ALTER TABLE ${table} ALTER COLUMN "${column}" DROP NOT NULL`);
   await setAction(q, table, column, parent, 'SET NULL');
  }
  // An event whose member's record was deleted names no member; the job marks it so the check still means something.
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_check,
   ADD CONSTRAINT dispatch_events_check CHECK ("memberId" IS NOT NULL OR "teamId" IS NOT NULL OR event = 'MEMBERS_EXPORTED' OR coalesce((metadata->>'recordDeleted')::boolean, false))`);
  await q.query(EVIDENCE);
  await q.query(CONTRACT(true));
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM retention_runs) OR EXISTS(SELECT 1 FROM retention_holds) OR EXISTS(SELECT 1 FROM retention_setting_changes) AS found`);
  if (found.found) throw new Error('Refusing to roll back while retention runs, holds or setting changes are recorded.');
  for (const [table, column] of KEPT.filter(([, , , , notNull]) => notNull)) {
   const [nulls] = await q.query(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE "${column}" IS NULL) AS found`);
   if (nulls.found) throw new Error(`Refusing to roll back while ${table} rows outlived the record they named.`);
  }
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_check, ADD CONSTRAINT dispatch_events_check CHECK ("memberId" IS NOT NULL OR "teamId" IS NOT NULL OR event = 'MEMBERS_EXPORTED')`);
  await q.query(CONTRACT(false));
  await q.query(EVIDENCE_BEFORE);
  for (const [table, column, parent, action, notNull] of KEPT) {
   await setAction(q, table, column, parent, action);
   if (notNull) await q.query(`ALTER TABLE ${table} ALTER COLUMN "${column}" SET NOT NULL`);
  }
  await q.query(`DROP TABLE retention_runs`);
  await q.query(`DROP TABLE retention_holds`);
  await q.query(`DROP TABLE retention_setting_changes`);
  await q.query(`DROP TABLE retention_settings`);
 }
}
