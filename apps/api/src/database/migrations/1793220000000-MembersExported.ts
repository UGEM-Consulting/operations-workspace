import { MigrationInterface, QueryRunner } from 'typeorm';
// Dispatchers table (designed as the Dispatchers table group and approved 2026-11-13): exporting the list is recorded as a
// metadata-only MEMBERS_EXPORTED dispatch event (the count, the tab and the names of the filters used, never the rows). An export
// is about the list, not one person or team, so the row check that every event names a member or team lets it through.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED','DETAILS_CORRECTED','LEAVE_RECORDED','LEAVE_CHANGED','LEAVE_ENDED','PAPER_SCAN_ADDED','PAPER_SCAN_VIEWED'`;
export class MembersExported1793220000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},'MEMBERS_EXPORTED'))`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_check,
   ADD CONSTRAINT dispatch_events_check CHECK ("memberId" IS NOT NULL OR "teamId" IS NOT NULL OR event = 'MEMBERS_EXPORTED')`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM dispatch_events WHERE event = 'MEMBERS_EXPORTED') AS found`);
  if (found.found) throw new Error('Refusing to roll back while list exports are recorded.');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_check, ADD CONSTRAINT dispatch_events_check CHECK ("memberId" IS NOT NULL OR "teamId" IS NOT NULL)`);
 }
}
