import { MigrationInterface, QueryRunner } from 'typeorm';
// People who left and other names (Design System section 33, "People who left and other names", approved 2026-11-13).
// The existing-dispatcher file can add people who already left, with their last day when it's known (leftDateKnown false
// keeps the day they were added in leftAt, never shown as a date, as startDateKnown does for the start). Any record can hold
// legal names (for someone added by hand) and other names, each with the MC where it was used when known. Asking IT to
// close the accounts of someone added as Left may carry a short note for IT. Events hold field names and flags only.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED','DETAILS_CORRECTED','LEAVE_RECORDED','LEAVE_CHANGED','LEAVE_ENDED','PAPER_SCAN_ADDED','PAPER_SCAN_VIEWED','MEMBERS_EXPORTED'`;
const NEW_EVENTS = `'NAMES_CHANGED','LEFT_DAY_RECORDED','CLOSE_ACCOUNTS_ASKED'`;
export class LeftAndNames1793230000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE existing_member_records ADD "leftDateKnown" boolean NOT NULL DEFAULT true,
   ADD "legalFirstName" varchar(100), ADD "legalLastName" varchar(100)`);
  await q.query(`CREATE TABLE member_other_names (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "memberId" uuid NOT NULL REFERENCES dispatch_members(id) ON DELETE CASCADE,
   name varchar(100) NOT NULL,
   "mcId" uuid REFERENCES mcs(id),
   "addedBy" uuid NOT NULL REFERENCES users(id),
   "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE INDEX "IDX_member_other_names_member" ON member_other_names ("memberId")`);
  await q.query(`ALTER TABLE it_removal_requests ADD note varchar(500)`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},${NEW_EVENTS}))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM existing_member_records WHERE NOT "leftDateKnown" OR "legalFirstName" IS NOT NULL OR "legalLastName" IS NOT NULL)
    OR EXISTS(SELECT 1 FROM member_other_names) OR EXISTS(SELECT 1 FROM it_removal_requests WHERE note IS NOT NULL)
    OR EXISTS(SELECT 1 FROM dispatch_events WHERE event IN (${NEW_EVENTS}))
    OR EXISTS(SELECT 1 FROM dispatch_events WHERE event = 'EXISTING_ADDED' AND (metadata->>'left')::boolean) AS found`);
  if (found.found) throw new Error('Refusing to roll back while people added as Left, legal or other names, or notes for IT are recorded.');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`ALTER TABLE it_removal_requests DROP COLUMN note`);
  await q.query(`DROP TABLE member_other_names`);
  await q.query(`ALTER TABLE existing_member_records DROP COLUMN "leftDateKnown", DROP COLUMN "legalFirstName", DROP COLUMN "legalLastName"`);
 }
}
