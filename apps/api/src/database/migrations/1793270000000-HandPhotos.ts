import { MigrationInterface, QueryRunner } from 'typeorm';
// Photos for people added by hand (Design System section 33, "Photos for people added by hand", approved 2026-11-13): an
// administrator adds a profile photo and an ID photo (them holding their ID) for someone with no application, including
// people who left. One current photo of each kind; a new one replaces it and the earlier file is kept. Every staff role may
// open both photos of anyone it already sees (the user's choice); each ID photo view is recorded. No face matching.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED','DETAILS_CORRECTED','LEAVE_RECORDED','LEAVE_CHANGED','LEAVE_ENDED','PAPER_SCAN_ADDED','PAPER_SCAN_VIEWED','MEMBERS_EXPORTED','NAMES_CHANGED','LEFT_DAY_RECORDED','CLOSE_ACCOUNTS_ASKED','SEAT_ADDED','SEAT_CHANGED','COMPANY_ACCOUNT_ADDED','COMPANY_ACCOUNT_CHANGED'`;
const NEW_EVENTS = `'PHOTO_ADDED','ID_PHOTO_VIEWED'`;
export class HandPhotos1793270000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE member_photos (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "memberId" uuid NOT NULL REFERENCES dispatch_members(id),
   kind varchar NOT NULL CHECK (kind IN ('PROFILE','ID')),
   "uploadedBy" uuid NOT NULL REFERENCES users(id),
   "replacedAt" timestamptz,
   "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE UNIQUE INDEX "UQ_member_photos_current" ON member_photos ("memberId", kind) WHERE "replacedAt" IS NULL`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},${NEW_EVENTS}))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_photos) OR EXISTS(SELECT 1 FROM dispatch_events WHERE event IN (${NEW_EVENTS})) AS found`);
  if (found.found) throw new Error('Refusing to roll back while photos of people added by hand, or ID photo views, are recorded.');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`DROP TABLE member_photos`);
 }
}
