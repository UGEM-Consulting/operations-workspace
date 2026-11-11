import { MigrationInterface, QueryRunner } from 'typeorm';
// On leave (section 35, designed and approved 2026-11-11): a dispatcher, support or updater away for a while keeps their job and
// their place. Their record stays ACTIVE (an older API reads them as Active); "on leave" is the open leave once its first day has
// come. IT suspends their accounts and restores them on their return, through checklists apart from setups and removals so an
// older API never lists or changes them. Portal notices and Telegram alerts gain the matching kinds.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED','DETAILS_CORRECTED'`;
const DELIVERY_KINDS = `'SETUP_COMPLETE','REVIEW_WAITING','IT_SETUP_WAITING','IT_REMOVAL_WAITING','IT_REMOVAL_SCHEDULED','IT_REMOVAL_DUE','IT_REMOVAL_NOW'`;
export class MemberLeave1793160000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE member_leaves (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NOT NULL REFERENCES dispatch_members(id),
   "firstDay" date NOT NULL, "backOn" date NOT NULL, reason text NOT NULL CHECK (btrim(reason) <> ''),
   "emailWhileAway" varchar NULL CHECK ("emailWhileAway" IN ('FORWARD','AUTO_REPLY')), "callsWhileAway" varchar NULL CHECK ("callsWhileAway" IN ('FORWARD','VOICEMAIL')),
   "forwardTo" uuid NULL REFERENCES users(id), "recordedBy" uuid NOT NULL REFERENCES users(id), changes jsonb NOT NULL DEFAULT '[]'::jsonb,
   "startedAt" timestamptz NULL, "endedAt" timestamptz NULL, "endedHow" varchar NULL CHECK ("endedHow" IN ('RETURNED','CANCELLED','LEAVING')), "endedBy" uuid NULL REFERENCES users(id),
   version integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CONSTRAINT "CHK_member_leaves_dates" CHECK ("backOn" > "firstDay"),
   CONSTRAINT "CHK_member_leaves_ended" CHECK (("endedAt" IS NULL) = ("endedHow" IS NULL)))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_member_leaves_open" ON member_leaves ("memberId") WHERE "endedAt" IS NULL`);
  await q.query(`CREATE INDEX "IDX_member_leaves_member" ON member_leaves ("memberId", "createdAt")`);
  await q.query(`CREATE TABLE it_leave_requests (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "leaveId" uuid NOT NULL REFERENCES member_leaves(id), "memberId" uuid NOT NULL REFERENCES dispatch_members(id),
   kind varchar NOT NULL CHECK (kind IN ('SUSPEND','RESTORE')), "managerId" uuid NOT NULL REFERENCES users(id), profile jsonb NOT NULL, "dueOn" date NOT NULL,
   version integer NOT NULL DEFAULT 0, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   "completedAt" timestamptz NULL, "cancelledAt" timestamptz NULL, CONSTRAINT "UQ_it_leave_requests_kind" UNIQUE ("leaveId", kind))`);
  await q.query(`CREATE TABLE it_leave_tasks (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "requestId" uuid NOT NULL REFERENCES it_leave_requests(id),
   key varchar NOT NULL CHECK (key IN ('GOOGLE_WORKSPACE','RINGCENTRAL','BUSINESS_SOFTWARE')),
   status varchar NOT NULL CHECK (status IN ('PENDING','IN_PROGRESS','BLOCKED','COMPLETED','NOT_NEEDED')), notes text NOT NULL DEFAULT '',
   "updatedBy" uuid NULL REFERENCES users(id), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CONSTRAINT "UQ_it_leave_tasks_key" UNIQUE ("requestId", key), CONSTRAINT "CHK_it_leave_tasks_not_needed" CHECK (status <> 'NOT_NEEDED' OR key = 'BUSINESS_SOFTWARE'))`);
  await q.query(`CREATE TABLE it_leave_activity (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "requestId" uuid NOT NULL REFERENCES it_leave_requests(id), "actorId" uuid NULL REFERENCES users(id),
   event varchar NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`ALTER TABLE portal_notifications ADD "leaveRequestId" uuid NULL REFERENCES it_leave_requests(id),
   DROP CONSTRAINT portal_notifications_subject_check, ADD CONSTRAINT portal_notifications_subject_check CHECK (num_nonnulls("requestId", "removalId", "leaveRequestId") = 1),
   ADD CONSTRAINT portal_notifications_leave_key UNIQUE ("recipientId", "leaveRequestId", kind),
   DROP CONSTRAINT portal_notifications_kind_check, ADD CONSTRAINT portal_notifications_kind_check CHECK (kind IN ('IT_ONBOARDING_COMPLETED','IT_REMOVAL_COMPLETED','IT_SUSPEND_COMPLETED','IT_RESTORE_COMPLETED'))`);
  await q.query(`ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_kind_check,
   ADD CONSTRAINT notification_deliveries_kind_check CHECK (kind IN (${DELIVERY_KINDS},'IT_LEAVE_SUSPEND','IT_LEAVE_RESTORE'))`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},'LEAVE_RECORDED','LEAVE_CHANGED','LEAVE_ENDED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [row] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_leaves) OR EXISTS(SELECT 1 FROM notification_deliveries WHERE kind IN ('IT_LEAVE_SUSPEND','IT_LEAVE_RESTORE')) AS kept`);
  if (row.kept) throw new Error('Cannot discard leave records');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_kind_check, ADD CONSTRAINT notification_deliveries_kind_check CHECK (kind IN (${DELIVERY_KINDS}))`);
  await q.query(`ALTER TABLE portal_notifications DROP CONSTRAINT portal_notifications_kind_check, DROP CONSTRAINT portal_notifications_leave_key,
   DROP CONSTRAINT portal_notifications_subject_check, DROP COLUMN "leaveRequestId",
   ADD CONSTRAINT portal_notifications_subject_check CHECK (("requestId" IS NULL) <> ("removalId" IS NULL)),
   ADD CONSTRAINT portal_notifications_kind_check CHECK (kind IN ('IT_ONBOARDING_COMPLETED','IT_REMOVAL_COMPLETED'))`);
  await q.query(`DROP TABLE it_leave_activity`);
  await q.query(`DROP TABLE it_leave_tasks`);
  await q.query(`DROP TABLE it_leave_requests`);
  await q.query(`DROP TABLE member_leaves`);
 }
}
