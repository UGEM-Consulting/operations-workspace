import { MigrationInterface, QueryRunner } from 'typeorm';
// Managed lists for MCs and job titles, picked from instead of typed. Names are unique ignoring case and spacing
// ("nameKey"); MC and DOT numbers are unique when present. Items are archived, never deleted, so old records keep them.
// The lists start from the MC and job title text managers confirmed at approval (invitation assignments); applicant
// answers are not trusted as list entries. "Independent" is a fixed choice, not an MC. Existing columns are untouched.
export class ManagedLists1792810000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE mcs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(100) NOT NULL, "nameKey" varchar(100) NOT NULL,
   "mcNumber" varchar(8) NULL CHECK ("mcNumber" ~ '^[0-9]{1,8}$'), "dotNumber" varchar(8) NULL CHECK ("dotNumber" ~ '^[0-9]{1,8}$'),
   "archivedAt" timestamptz NULL, version integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE UNIQUE INDEX "UQ_mcs_nameKey" ON mcs ("nameKey")`);
  await q.query(`CREATE UNIQUE INDEX "UQ_mcs_mcNumber" ON mcs ("mcNumber") WHERE "mcNumber" IS NOT NULL`);
  await q.query(`CREATE UNIQUE INDEX "UQ_mcs_dotNumber" ON mcs ("dotNumber") WHERE "dotNumber" IS NOT NULL`);
  await q.query(`CREATE TABLE job_titles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(100) NOT NULL, "nameKey" varchar(100) NOT NULL,
   "archivedAt" timestamptz NULL, version integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE UNIQUE INDEX "UQ_job_titles_nameKey" ON job_titles ("nameKey")`);
  // Who changed which list item and which fields; never the values.
  await q.query(`CREATE TABLE list_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), list varchar NOT NULL CHECK (list IN ('MC','JOB_TITLE')),
   "itemId" uuid NOT NULL, "actorId" uuid NULL REFERENCES users(id) ON DELETE SET NULL,
   event varchar NOT NULL CHECK (event IN ('CREATED','UPDATED','ARCHIVED','RESTORED')), metadata jsonb NOT NULL DEFAULT '{}', "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE INDEX "IDX_list_events_item" ON list_events (list, "itemId")`);
  // One entry per distinct confirmed value; the first spelling seen (oldest invitation) becomes the display name.
  for (const [table, column] of [['mcs', 'mcName'], ['job_titles', 'jobTitle']]) {
   await q.query(`INSERT INTO ${table} (name, "nameKey")
    SELECT DISTINCT ON (key) left(value, 100), left(key, 100) FROM (
     SELECT regexp_replace(btrim("${column}"), '\\s+', ' ', 'g') AS value, lower(regexp_replace(btrim("${column}"), '\\s+', ' ', 'g')) AS key, "createdAt"
     FROM invitations WHERE "${column}" IS NOT NULL) confirmed
    WHERE key <> '' AND key <> 'independent' ORDER BY key, "createdAt"`);
  }
 }
 async down(q: QueryRunner): Promise<void> {
  // Backfilled entries can be rebuilt from invitations; anything a person added or changed cannot.
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM list_events) AS changed`);
  if (data.changed) throw new Error('Cannot discard managed list changes');
  await q.query(`DROP TABLE list_events`);
  await q.query(`DROP TABLE job_titles`);
  await q.query(`DROP TABLE mcs`);
 }
}
