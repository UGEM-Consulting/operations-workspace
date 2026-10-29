import { MigrationInterface, QueryRunner } from 'typeorm';
// Supports (updaters): an invitation is for a DISPATCHER (default, as before) or a SUPPORT, who assists one dispatcher.
// The manager picks that dispatcher on the invitation and confirms it at approval (supportsMemberId, manager-controlled
// like the employment assignments). A support has no MC, team or job title of their own and no IT setup; their link to
// a dispatcher is history in member_support_links, one open row per support. Existing invitations stay DISPATCHER.
export class SupportMembers1792840000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE invitations ADD COLUMN position varchar NOT NULL DEFAULT 'DISPATCHER' CHECK (position IN ('DISPATCHER','SUPPORT')),
   ADD COLUMN "supportsMemberId" uuid NULL REFERENCES dispatch_members(id)`);
  await q.query(`ALTER TABLE invitations ADD CONSTRAINT "CHK_invitations_support" CHECK (position = 'SUPPORT' OR "supportsMemberId" IS NULL)`);
  await q.query(`CREATE TABLE member_support_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "supportId" uuid NOT NULL REFERENCES dispatch_members(id),
   "dispatcherId" uuid NOT NULL REFERENCES dispatch_members(id), "startedAt" timestamptz NOT NULL, "endedAt" timestamptz NULL, reason varchar(500) NULL,
   "actorId" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
   CHECK ("supportId" <> "dispatcherId"), CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_member_support_links_open" ON member_support_links ("supportId") WHERE "endedAt" IS NULL`);
  await q.query(`CREATE INDEX "IDX_member_support_links_dispatcher" ON member_support_links ("dispatcherId") WHERE "endedAt" IS NULL`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT "dispatch_events_event_check"`);
  await q.query(`ALTER TABLE dispatch_events ADD CONSTRAINT "dispatch_events_event_check" CHECK (event IN ('MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED',
   'TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM invitations WHERE position = 'SUPPORT') AS invited, EXISTS(SELECT 1 FROM member_support_links) AS linked,
   EXISTS(SELECT 1 FROM dispatch_events WHERE event = 'SUPPORT_REASSIGNED') AS reassigned`);
  if (data.invited || data.linked || data.reassigned) throw new Error('Cannot discard support invitations or records');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT "dispatch_events_event_check"`);
  await q.query(`ALTER TABLE dispatch_events ADD CONSTRAINT "dispatch_events_event_check" CHECK (event IN ('MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED',
   'TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED'))`);
  await q.query(`DROP TABLE member_support_links`);
  await q.query(`ALTER TABLE invitations DROP CONSTRAINT "CHK_invitations_support"`);
  await q.query(`ALTER TABLE invitations DROP COLUMN "supportsMemberId", DROP COLUMN position`);
 }
}
