import { MigrationInterface, QueryRunner } from 'typeorm';
// Dispatcher offboarding and manager hand-over (designed in the Design System and approved by the user 2026-11-02).
// Marking a dispatcher who had IT setup as left opens an IT removal checklist (it_removal_*), the reverse of setup, and
// closes an unfinished setup request (cancelledAt). The removal's completion notice reuses portal_notifications, which now
// names either a setup request or a removal. A new Telegram alert, IT_REMOVAL_WAITING, tells IT. Applications can be handed
// to another manager; each change is kept in application_manager_changes with an optional note for the history.
// Notice periods (approved the same day): member_notices records a future last day; the dispatcher stays Active, the
// removal is scheduled, and the workspace marks them as left once their last day has passed and everyone is reassigned.
const REMOVAL_KEYS = `'GOOGLE_WORKSPACE','DISPATCH_GROUP','RINGCENTRAL','BUSINESS_SOFTWARE','SHARED_PASSWORDS','EQUIPMENT'`;
const DELIVERY_KINDS = `'SETUP_COMPLETE','REVIEW_WAITING','IT_SETUP_WAITING'`;
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED'`;
export class DispatcherOffboarding1792950000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  // Mark as left asked why but never kept it; the dispatcher page shows it now.
  await q.query(`ALTER TABLE dispatch_members ADD "leftReason" text NULL CHECK ("leftReason" IS NULL OR length("leftReason") <= 500)`);
  await q.query(`ALTER TABLE it_onboarding_requests ADD "cancelledAt" timestamptz NULL, ADD CONSTRAINT it_cancelled_open_check CHECK ("cancelledAt" IS NULL OR "completedAt" IS NULL)`);
  await q.query(`CREATE TABLE it_removal_requests (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NOT NULL REFERENCES dispatch_members(id),
   "setupRequestId" uuid NOT NULL REFERENCES it_onboarding_requests(id), "managerId" uuid NOT NULL REFERENCES users(id),
   "createdBy" uuid NOT NULL REFERENCES users(id), profile jsonb NOT NULL,
   "emailAfter" varchar(10) NOT NULL CHECK ("emailAfter" IN ('FORWARD','SUSPEND')), "forwardTo" uuid NULL REFERENCES users(id),
   "dueOn" date NOT NULL, "numberOutcome" varchar(10) NULL CHECK ("numberOutcome" IN ('KEPT','FORWARDED','RELEASED')),
   version integer NOT NULL DEFAULT 0, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), "completedAt" timestamptz NULL,
   "removeNowAt" timestamptz NULL, "removeNowReason" text NULL CHECK ("removeNowReason" IS NULL OR length("removeNowReason") <= 500), "dueAlertedAt" timestamptz NULL, "cancelledAt" timestamptz NULL,
   CHECK ("cancelledAt" IS NULL OR "completedAt" IS NULL), CHECK (("removeNowAt" IS NULL) = ("removeNowReason" IS NULL)),
   CHECK (("emailAfter" = 'FORWARD') = ("forwardTo" IS NOT NULL)),
   CONSTRAINT it_removal_number_check CHECK ("completedAt" IS NULL OR "numberOutcome" IS NOT NULL OR profile->>'ringCentralNumber' IS NULL))`);
  // A cancelled notice keeps its removal in the history; a later notice opens a new one.
  await q.query(`CREATE UNIQUE INDEX it_removals_one_per_member ON it_removal_requests ("memberId") WHERE "cancelledAt" IS NULL`);
  await q.query(`CREATE INDEX it_removals_queue ON it_removal_requests ("completedAt", "dueOn")`);
  await q.query(`CREATE TABLE member_notices (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NOT NULL REFERENCES dispatch_members(id), "lastDay" date NOT NULL,
   reason text NOT NULL CHECK (length(reason) <= 500), "recordedBy" uuid NOT NULL REFERENCES users(id), changes jsonb NOT NULL DEFAULT '[]',
   "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   "cancelledAt" timestamptz NULL, "cancelledBy" uuid NULL REFERENCES users(id), "cancelReason" text NULL CHECK ("cancelReason" IS NULL OR length("cancelReason") <= 500), "finishedAt" timestamptz NULL,
   CHECK ("cancelledAt" IS NULL OR "finishedAt" IS NULL), CHECK (("cancelledAt" IS NULL) = ("cancelledBy" IS NULL)))`);
  await q.query(`CREATE UNIQUE INDEX member_notices_one_open ON member_notices ("memberId") WHERE "cancelledAt" IS NULL AND "finishedAt" IS NULL`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},'NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED'))`);
  await q.query(`CREATE TABLE it_removal_tasks (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "requestId" uuid NOT NULL REFERENCES it_removal_requests(id),
   key varchar NOT NULL CHECK (key IN (${REMOVAL_KEYS})),
   status varchar NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_PROGRESS','BLOCKED','COMPLETED','NOT_NEEDED')),
   notes text NOT NULL DEFAULT '', "updatedBy" uuid NULL REFERENCES users(id), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   UNIQUE ("requestId", key), CHECK (status <> 'BLOCKED' OR length(trim(notes)) > 0), CHECK (status <> 'NOT_NEEDED' OR key = 'EQUIPMENT'))`);
  await q.query(`CREATE TABLE it_removal_activity (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "requestId" uuid NOT NULL REFERENCES it_removal_requests(id),
   "actorId" uuid NOT NULL REFERENCES users(id), event varchar NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE INDEX it_removal_activity_request ON it_removal_activity ("requestId", "createdAt")`);
  // A portal notice names a setup request or a removal. An older API only lists notices joined to a setup request.
  await q.query(`ALTER TABLE portal_notifications ALTER "requestId" DROP NOT NULL, ADD "removalId" uuid NULL REFERENCES it_removal_requests(id),
   ADD CONSTRAINT portal_notifications_subject_check CHECK (("requestId" IS NULL) <> ("removalId" IS NULL)),
   ADD CONSTRAINT portal_notifications_removal_key UNIQUE ("recipientId", "removalId", kind),
   DROP CONSTRAINT portal_notifications_kind_check,
   ADD CONSTRAINT portal_notifications_kind_check CHECK (kind IN ('IT_ONBOARDING_COMPLETED','IT_REMOVAL_COMPLETED'))`);
  await q.query(`ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_kind_check,
   ADD CONSTRAINT notification_deliveries_kind_check CHECK (kind IN (${DELIVERY_KINDS},'IT_REMOVAL_WAITING','IT_REMOVAL_SCHEDULED','IT_REMOVAL_DUE','IT_REMOVAL_NOW'))`);
  await q.query(`CREATE TABLE application_manager_changes (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "applicationId" uuid NOT NULL REFERENCES dispatcher_applications(id),
   "fromUserId" uuid NOT NULL REFERENCES users(id), "toUserId" uuid NOT NULL REFERENCES users(id), "actorId" uuid NOT NULL REFERENCES users(id),
   reason varchar(12) NOT NULL CHECK (reason IN ('CHANGED','HANDED_OVER')), note text NULL CHECK (note IS NULL OR length(note) <= 500),
   "createdAt" timestamptz NOT NULL DEFAULT now(), CHECK ("fromUserId" <> "toUserId"))`);
  await q.query(`CREATE INDEX application_manager_changes_application ON application_manager_changes ("applicationId", "createdAt")`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM it_removal_requests) OR EXISTS(SELECT 1 FROM it_onboarding_requests WHERE "cancelledAt" IS NOT NULL)
   OR EXISTS(SELECT 1 FROM application_manager_changes) OR EXISTS(SELECT 1 FROM dispatch_members WHERE "leftReason" IS NOT NULL) OR EXISTS(SELECT 1 FROM member_notices)
   OR EXISTS(SELECT 1 FROM notification_deliveries WHERE kind IN ('IT_REMOVAL_WAITING','IT_REMOVAL_SCHEDULED','IT_REMOVAL_DUE','IT_REMOVAL_NOW')) AS kept`);
  if (data.kept) throw new Error('Cannot discard dispatcher offboarding or manager hand-over history');
  await q.query(`DROP TABLE application_manager_changes`);
  await q.query(`ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_kind_check,
   ADD CONSTRAINT notification_deliveries_kind_check CHECK (kind IN (${DELIVERY_KINDS}))`);
  await q.query(`ALTER TABLE portal_notifications DROP CONSTRAINT portal_notifications_kind_check, DROP CONSTRAINT portal_notifications_removal_key,
   DROP CONSTRAINT portal_notifications_subject_check, DROP COLUMN "removalId", ALTER "requestId" SET NOT NULL,
   ADD CONSTRAINT portal_notifications_kind_check CHECK (kind = 'IT_ONBOARDING_COMPLETED')`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`DROP TABLE member_notices`);
  await q.query(`DROP TABLE it_removal_activity`);
  await q.query(`DROP TABLE it_removal_tasks`);
  await q.query(`DROP TABLE it_removal_requests`);
  await q.query(`ALTER TABLE it_onboarding_requests DROP CONSTRAINT it_cancelled_open_check, DROP COLUMN "cancelledAt"`);
  await q.query(`ALTER TABLE dispatch_members DROP COLUMN "leftReason"`);
 }
}
