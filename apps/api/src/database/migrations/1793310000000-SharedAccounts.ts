import { MigrationInterface, QueryRunner } from 'typeorm';
// Shared company email and RingCentral number (Design System section 35, approved 2026-11-17). An email or number has one
// owner, the person whose record holds it; others are recorded here as using it. The value is kept so the user's page and
// search can show it, and so a later change on the owner's record never silently moves someone else's access. A hand-over
// when the owner leaves keeps the recipient's row open with handedOverAt: from then on they own it. Events hold field names
// and flags, never the email or number.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED','DETAILS_CORRECTED','LEAVE_RECORDED','LEAVE_CHANGED','LEAVE_ENDED','PAPER_SCAN_ADDED','PAPER_SCAN_VIEWED','MEMBERS_EXPORTED','NAMES_CHANGED','LEFT_DAY_RECORDED','CLOSE_ACCOUNTS_ASKED','SEAT_ADDED','SEAT_CHANGED','COMPANY_ACCOUNT_ADDED','COMPANY_ACCOUNT_CHANGED','PHOTO_ADDED','ID_PHOTO_VIEWED'`;
const NEW_EVENTS = `'ACCOUNT_SHARED','SHARING_ENDED','ACCOUNT_MOVED','ACCOUNTS_HANDED_OVER'`;
export class SharedAccounts1793310000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE member_shared_accounts (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "memberId" uuid NOT NULL REFERENCES dispatch_members(id) ON DELETE CASCADE,
   -- Kept as history once handed over; a deleted record (the retention job) leaves it empty.
   "ownerMemberId" uuid REFERENCES dispatch_members(id) ON DELETE SET NULL,
   kind varchar NOT NULL CHECK (kind IN ('EMAIL','RINGCENTRAL')),
   value varchar(254) NOT NULL,
   "createdBy" uuid REFERENCES users(id) ON DELETE SET NULL,
   "createdAt" timestamptz NOT NULL DEFAULT now(),
   "handedOverAt" timestamptz,
   "endedAt" timestamptz,
   "endedBy" uuid REFERENCES users(id) ON DELETE SET NULL,
   "endedHow" varchar CHECK ("endedHow" IN ('STOPPED','MOVED','OWNER_LEFT','LEFT')),
   CONSTRAINT "CHK_member_shared_accounts_other" CHECK ("memberId" <> "ownerMemberId"),
   CONSTRAINT "CHK_member_shared_accounts_ended" CHECK (("endedAt" IS NULL) = ("endedHow" IS NULL)))`);
  // One shared email and one shared number per person at a time.
  await q.query(`CREATE UNIQUE INDEX "UQ_member_shared_accounts_open" ON member_shared_accounts ("memberId", kind) WHERE "endedAt" IS NULL`);
  await q.query(`CREATE INDEX "IDX_member_shared_accounts_owner" ON member_shared_accounts ("ownerMemberId") WHERE "endedAt" IS NULL`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},${NEW_EVENTS}))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_shared_accounts) OR EXISTS(SELECT 1 FROM dispatch_events WHERE event IN (${NEW_EVENTS})) AS found`);
  if (found.found) throw new Error('Refusing to roll back while shared emails or numbers are recorded.');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`DROP TABLE member_shared_accounts`);
 }
}
