import { MigrationInterface, QueryRunner } from 'typeorm';
// IT requests about company accounts (Design System section 33, "Company accounts and load boards", approved 2026-11-13):
// closing one account at another company (CloseCompanyAccountScreen, ItCloseAccountTaskScreen), and new accounts at the new
// MC when someone moves (KeptForLoadBoardsMoveScreen): IT creates them and closes the old ones, except an email that still
// signs in to a load board seat, which is kept. They're their own checklists, apart from setups, removals and leave, so an
// older API never lists or changes them. Whoever asked gets a portal notice when IT finishes; no Telegram alert is sent.
export class AccountRequests1793260000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE it_account_requests (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NOT NULL REFERENCES dispatch_members(id),
   kind varchar NOT NULL CHECK (kind IN ('CLOSE','MOVE')), "accountId" uuid NULL REFERENCES member_company_accounts(id),
   "managerId" uuid NOT NULL REFERENCES users(id), profile jsonb NOT NULL, note varchar(500) NULL,
   "emailAfter" varchar NOT NULL DEFAULT 'SUSPEND' CHECK ("emailAfter" IN ('FORWARD','SUSPEND')), "forwardTo" uuid NULL REFERENCES users(id),
   "newCompanyEmail" varchar(254) NULL, "newRingCentralNumber" varchar(40) NULL, "newRingCentralExtension" varchar(6) NULL,
   version integer NOT NULL DEFAULT 0, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   "completedAt" timestamptz NULL, "cancelledAt" timestamptz NULL,
   CONSTRAINT "CHK_it_account_requests_account" CHECK ((kind = 'CLOSE') = ("accountId" IS NOT NULL)))`);
  // One open request per account, and one open move per person.
  await q.query(`CREATE UNIQUE INDEX "UQ_it_account_requests_close" ON it_account_requests ("accountId") WHERE "completedAt" IS NULL AND "cancelledAt" IS NULL`);
  await q.query(`CREATE UNIQUE INDEX "UQ_it_account_requests_move" ON it_account_requests ("memberId") WHERE kind = 'MOVE' AND "completedAt" IS NULL AND "cancelledAt" IS NULL`);
  await q.query(`CREATE TABLE it_account_tasks (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "requestId" uuid NOT NULL REFERENCES it_account_requests(id),
   key varchar NOT NULL CHECK (key IN ('NEW_EMAIL','NEW_NUMBER','CLOSE_EMAIL','CLOSE_NUMBER','SHARED_PASSWORDS')),
   status varchar NOT NULL CHECK (status IN ('PENDING','IN_PROGRESS','BLOCKED','COMPLETED')), notes text NOT NULL DEFAULT '',
   "updatedBy" uuid NULL REFERENCES users(id), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CONSTRAINT "UQ_it_account_tasks_key" UNIQUE ("requestId", key))`);
  await q.query(`CREATE TABLE it_account_activity (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "requestId" uuid NOT NULL REFERENCES it_account_requests(id), "actorId" uuid NULL REFERENCES users(id),
   event varchar NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`ALTER TABLE portal_notifications ADD "accountRequestId" uuid NULL REFERENCES it_account_requests(id),
   DROP CONSTRAINT portal_notifications_subject_check, ADD CONSTRAINT portal_notifications_subject_check CHECK (num_nonnulls("requestId", "removalId", "leaveRequestId", "accountRequestId") = 1),
   ADD CONSTRAINT portal_notifications_account_key UNIQUE ("recipientId", "accountRequestId", kind),
   DROP CONSTRAINT portal_notifications_kind_check, ADD CONSTRAINT portal_notifications_kind_check CHECK (kind IN ('IT_ONBOARDING_COMPLETED','IT_REMOVAL_COMPLETED','IT_SUSPEND_COMPLETED','IT_RESTORE_COMPLETED','IT_ACCOUNT_COMPLETED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM it_account_requests) AS found`);
  if (found.found) throw new Error('Refusing to roll back while IT requests about company accounts exist.');
  await q.query(`ALTER TABLE portal_notifications DROP CONSTRAINT portal_notifications_kind_check, DROP CONSTRAINT portal_notifications_account_key,
   DROP CONSTRAINT portal_notifications_subject_check, DROP COLUMN "accountRequestId",
   ADD CONSTRAINT portal_notifications_subject_check CHECK (num_nonnulls("requestId", "removalId", "leaveRequestId") = 1),
   ADD CONSTRAINT portal_notifications_kind_check CHECK (kind IN ('IT_ONBOARDING_COMPLETED','IT_REMOVAL_COMPLETED','IT_SUSPEND_COMPLETED','IT_RESTORE_COMPLETED'))`);
  await q.query(`DROP TABLE it_account_activity`);
  await q.query(`DROP TABLE it_account_tasks`);
  await q.query(`DROP TABLE it_account_requests`);
 }
}
