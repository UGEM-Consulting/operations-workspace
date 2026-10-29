import { MigrationInterface, QueryRunner } from 'typeorm';
// Teams and dispatch member records (no login). Each approved application becomes one member; where a dispatcher works
// (MC and team) is kept as history in member_assignments, one open row per member, so moves never overwrite the past.
// A team works for one MC and may have a lead, who is a member of that team. The backfill matches the confirmed
// invitation text to the managed lists by name; "Independent" means no MC and no team. People's changes are audited in
// dispatch_events (metadata only); automatic rows (backfill, approvals) write none, so they can always be rebuilt.
const KEY = (column: string) => `lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;
export class DispatchTeams1792820000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE dispatch_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "applicationId" uuid NULL UNIQUE REFERENCES dispatcher_applications(id), "firstName" varchar(100) NOT NULL, "lastName" varchar(100) NOT NULL,
   position varchar NOT NULL DEFAULT 'DISPATCHER' CHECK (position IN ('DISPATCHER','SUPPORT')),
   status varchar NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LEFT')), "jobTitleId" uuid NULL REFERENCES job_titles(id),
   "joinedAt" timestamptz NOT NULL, "leftAt" timestamptz NULL, version integer NOT NULL DEFAULT 1,
   "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CHECK ((status = 'LEFT') = ("leftAt" IS NOT NULL)))`);
  await q.query(`CREATE TABLE teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(100) NOT NULL, "nameKey" varchar(100) NOT NULL,
   "mcId" uuid NOT NULL REFERENCES mcs(id), "leadMemberId" uuid NULL REFERENCES dispatch_members(id),
   "archivedAt" timestamptz NULL, version integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CHECK ("archivedAt" IS NULL OR "leadMemberId" IS NULL))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_teams_nameKey" ON teams ("nameKey")`);
  await q.query(`CREATE TABLE member_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NOT NULL REFERENCES dispatch_members(id),
   "mcId" uuid NULL REFERENCES mcs(id), "teamId" uuid NULL REFERENCES teams(id), "startedAt" timestamptz NOT NULL, "endedAt" timestamptz NULL,
   reason varchar(500) NULL, "actorId" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
   CHECK ("teamId" IS NULL OR "mcId" IS NOT NULL), CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_member_assignments_open" ON member_assignments ("memberId") WHERE "endedAt" IS NULL`);
  await q.query(`CREATE INDEX "IDX_member_assignments_team" ON member_assignments ("teamId") WHERE "endedAt" IS NULL`);
  await q.query(`CREATE TABLE dispatch_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NULL REFERENCES dispatch_members(id), "teamId" uuid NULL REFERENCES teams(id),
   event varchar NOT NULL CHECK (event IN ('MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED')),
   "actorId" uuid NULL REFERENCES users(id) ON DELETE SET NULL, metadata jsonb NOT NULL DEFAULT '{}', "createdAt" timestamptz NOT NULL DEFAULT now(),
   CHECK ("memberId" IS NOT NULL OR "teamId" IS NOT NULL))`);

  // Members: one per approved application, named with the American names from the latest submitted revision.
  await q.query(`INSERT INTO dispatch_members ("applicationId","firstName","lastName","jobTitleId","joinedAt")
   SELECT a.id, left(coalesce(nullif(btrim(f.fields->>'preferredAmericanFirstName'),''), nullif(btrim(f.fields->>'firstName'),''), 'Dispatcher'), 100),
    left(coalesce(nullif(btrim(f.fields->>'preferredAmericanLastName'),''), nullif(btrim(f.fields->>'lastName'),''), ''), 100),
    jt.id, coalesce(r."createdAt", a."updatedAt")
   FROM dispatcher_applications a JOIN invitations i ON i.id = a."invitationId"
   LEFT JOIN LATERAL (SELECT fields FROM application_submissions s WHERE s."applicationId" = a.id ORDER BY s.version DESC LIMIT 1) sub ON true
   CROSS JOIN LATERAL (SELECT coalesce(sub.fields, a.fields) AS fields) f
   LEFT JOIN LATERAL (SELECT "createdAt" FROM application_reviews rv WHERE rv."applicationId" = a.id AND rv."decisionType" = 'APPROVE' ORDER BY rv."createdAt" DESC LIMIT 1) r ON true
   LEFT JOIN job_titles jt ON jt."nameKey" = ${KEY('i."jobTitle"')}
   WHERE a.status = 'APPROVED'`);
  // Each member's confirmed MC and team lead, matched to the lists. Teams: one per MC and team lead; the MC name is
  // added only when the same lead text appears under two MCs, so names stay unique.
  await q.query(`CREATE TEMP TABLE dispatch_source ON COMMIT DROP AS
   SELECT d.id AS "memberId", m.id AS "mcId", m.name AS "mcName", regexp_replace(btrim(i."teamLead"), '\\s+', ' ', 'g') AS lead, ${KEY('i."teamLead"')} AS "leadKey"
   FROM dispatch_members d JOIN dispatcher_applications a ON a.id = d."applicationId" JOIN invitations i ON i.id = a."invitationId"
   LEFT JOIN mcs m ON m."nameKey" = ${KEY('i."mcName"')}`);
  await q.query(`CREATE TEMP TABLE team_source ON COMMIT DROP AS
   SELECT "mcId", "leadKey", left(lead || ' team' || CASE WHEN count(*) OVER (PARTITION BY "leadKey") > 1 THEN ' (' || "mcName" || ')' ELSE '' END, 100) AS name
   FROM (SELECT DISTINCT ON ("mcId", "leadKey") "mcId", "leadKey", lead, "mcName" FROM dispatch_source
    WHERE "mcId" IS NOT NULL AND "leadKey" IS NOT NULL AND "leadKey" NOT IN ('', 'independent') ORDER BY "mcId", "leadKey") pairs`);
  await q.query(`INSERT INTO teams (name, "nameKey", "mcId") SELECT name, lower(name), "mcId" FROM team_source`);
  // Where each member works now, starting when they were approved.
  await q.query(`INSERT INTO member_assignments ("memberId","mcId","teamId","startedAt",reason)
   SELECT d.id, src."mcId", t.id, d."joinedAt", 'Joined after onboarding was approved.'
   FROM dispatch_members d JOIN dispatch_source src ON src."memberId" = d.id
   LEFT JOIN team_source ts ON ts."mcId" = src."mcId" AND ts."leadKey" = src."leadKey"
   LEFT JOIN teams t ON t."nameKey" = lower(ts.name)`);
  // A team's lead is the one member of that team whose display name is the confirmed team lead text.
  await q.query(`UPDATE teams t SET "leadMemberId" = lead.id FROM (
    SELECT ma."teamId", min(d.id::text)::uuid AS id, count(*) AS matches FROM member_assignments ma JOIN dispatch_members d ON d.id = ma."memberId"
    JOIN team_source ts ON ts."mcId" = ma."mcId" JOIN teams tt ON tt.id = ma."teamId" AND tt."nameKey" = lower(ts.name)
    WHERE ma."endedAt" IS NULL AND ts."leadKey" = lower(d."firstName" || ' ' || d."lastName")
    GROUP BY ma."teamId") lead WHERE lead."teamId" = t.id AND lead.matches = 1`);
 }
 async down(q: QueryRunner): Promise<void> {
  // Rows written by the backfill and by approvals can be rebuilt; moves, departures and team edits made by people cannot.
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM dispatch_events) AS changed`);
  if (data.changed) throw new Error('Cannot discard dispatch team changes');
  await q.query(`DROP TABLE dispatch_events`);
  await q.query(`DROP TABLE member_assignments`);
  await q.query(`DROP TABLE teams`);
  await q.query(`DROP TABLE dispatch_members`);
 }
}
