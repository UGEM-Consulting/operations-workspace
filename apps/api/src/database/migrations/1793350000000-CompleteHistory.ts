import { MigrationInterface, QueryRunner } from 'typeorm';
// The complete dispatcher History (Design System section 38, approved 2026-11-19): changes that left no record on the
// person now do. Becoming or stopping being a team lead is recorded on the person as well as the team, and so is someone
// else becoming the owner of an email or number a person uses (moved to the right record, or handed over when its owner
// left). Events hold kinds, ids and flags, never values; two small indexes find an owner change from either owner's History.
// The rollback refuses while any of these events exist.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED','DETAILS_CORRECTED','LEAVE_RECORDED','LEAVE_CHANGED','LEAVE_ENDED','PAPER_SCAN_ADDED','PAPER_SCAN_VIEWED','MEMBERS_EXPORTED','NAMES_CHANGED','LEFT_DAY_RECORDED','CLOSE_ACCOUNTS_ASKED','SEAT_ADDED','SEAT_CHANGED','COMPANY_ACCOUNT_ADDED','COMPANY_ACCOUNT_CHANGED','PHOTO_ADDED','ID_PHOTO_VIEWED','ACCOUNT_SHARED','SHARING_ENDED','ACCOUNT_MOVED','ACCOUNTS_HANDED_OVER'`;
const NEW_EVENTS = `'TEAM_LEAD_SET','TEAM_LEAD_CLEARED','SHARED_OWNER_CHANGED'`;
export class CompleteHistory1793350000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},${NEW_EVENTS}))`);
  await q.query(`CREATE INDEX "IDX_dispatch_events_shared_owner" ON dispatch_events ((metadata->>'ownerId')) WHERE event = 'SHARED_OWNER_CHANGED'`);
  await q.query(`CREATE INDEX "IDX_dispatch_events_shared_previous_owner" ON dispatch_events ((metadata->>'previousOwnerId')) WHERE event = 'SHARED_OWNER_CHANGED'`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM dispatch_events WHERE event IN (${NEW_EVENTS})) AS found`);
  if (found.found) throw new Error('Refusing to roll back while team lead or shared owner history is recorded.');
  await q.query(`DROP INDEX "IDX_dispatch_events_shared_previous_owner"`); await q.query(`DROP INDEX "IDX_dispatch_events_shared_owner"`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
 }
}
