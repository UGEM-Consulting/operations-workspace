import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_ROAD_READY } from '../driver-event-lists';
// View-only access across Dispatch and Safety (Design System section 39, approved 2026-11-20). An administrator lets someone
// read another department (staff_view_access, one row per person and department, withFiles for its photos and documents), or
// gives a View only account (role VIEWER, for someone with no department job here) the departments it may read. Opening a
// signed copy as a viewer is recorded: SIGNED_COPY_VIEWED on the dispatcher, CONSENT_VIEWED on the driver (kind and role only).
// Role rules live in the services: PostgreSQL cannot use an enum value added in the same transaction. The rollback refuses
// while any grant, View only account or new event exists; the enum value stays.
const DISPATCH_EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED','DETAILS_CORRECTED','LEAVE_RECORDED','LEAVE_CHANGED','LEAVE_ENDED','PAPER_SCAN_ADDED','PAPER_SCAN_VIEWED','MEMBERS_EXPORTED','NAMES_CHANGED','LEFT_DAY_RECORDED','CLOSE_ACCOUNTS_ASKED','SEAT_ADDED','SEAT_CHANGED','COMPANY_ACCOUNT_ADDED','COMPANY_ACCOUNT_CHANGED','PHOTO_ADDED','ID_PHOTO_VIEWED','ACCOUNT_SHARED','SHARING_ENDED','ACCOUNT_MOVED','ACCOUNTS_HANDED_OVER','TEAM_LEAD_SET','TEAM_LEAD_CLEARED','SHARED_OWNER_CHANGED'`;
export class ViewAccess1793360000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'VIEWER'`);
  await q.query(`CREATE TABLE staff_view_access ("userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   department varchar(20) NOT NULL CHECK (department IN ('DISPATCH','SAFETY')), "withFiles" boolean NOT NULL DEFAULT false,
   "grantedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "grantedAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("userId", department))`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${DISPATCH_EVENTS},'SIGNED_COPY_VIEWED'))`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check", ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_ROAD_READY},'CONSENT_VIEWED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM staff_view_access) OR EXISTS(SELECT 1 FROM users WHERE role::text = 'VIEWER')
   OR EXISTS(SELECT 1 FROM dispatch_events WHERE event = 'SIGNED_COPY_VIEWED') OR EXISTS(SELECT 1 FROM driver_events WHERE event = 'CONSENT_VIEWED') AS found`);
  if (found.found) throw new Error('Refusing to roll back while view-only access, View only accounts or their file views are recorded.');
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check", ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_ROAD_READY}))`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${DISPATCH_EVENTS}))`);
  await q.query(`DROP TABLE staff_view_access`);
 }
}
