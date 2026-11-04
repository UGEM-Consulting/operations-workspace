import { MigrationInterface, QueryRunner } from 'typeorm';
// Support and updater (designed in the Design System and approved by the user 2026-11-04): two names for the same position, tied to one
// dispatcher and treated alike. position stays SUPPORT for both, and supportType says which they're called. Everyone already recorded stays
// Support, and the default keeps rows an older API writes during an overlapping deploy correct.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED'`;
export class SupportTypes1793000000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE dispatch_members ADD COLUMN "supportType" varchar NOT NULL DEFAULT 'SUPPORT' CHECK ("supportType" IN ('SUPPORT','UPDATER'))`);
  await q.query(`ALTER TABLE invitations ADD COLUMN "supportType" varchar NOT NULL DEFAULT 'SUPPORT' CHECK ("supportType" IN ('SUPPORT','UPDATER'))`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},'SUPPORT_TYPE_CHANGED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM dispatch_members WHERE "supportType" = 'UPDATER') OR EXISTS(SELECT 1 FROM invitations WHERE "supportType" = 'UPDATER')
   OR EXISTS(SELECT 1 FROM dispatch_events WHERE event = 'SUPPORT_TYPE_CHANGED') AS kept`);
  if (data.kept) throw new Error('Cannot discard updaters');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`ALTER TABLE invitations DROP COLUMN "supportType"`);
  await q.query(`ALTER TABLE dispatch_members DROP COLUMN "supportType"`);
 }
}
