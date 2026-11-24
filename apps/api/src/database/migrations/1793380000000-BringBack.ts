import { MigrationInterface, QueryRunner } from 'typeorm';
// Bringing back someone who left (Design System section 41, approved 2026-11-24). Undo leaving (within 30 days of the last
// day, for a mistake or a change of mind) and Rehire (any time later, on the same record) each write a member_returns row:
// the leaving it reverses and the stay that ended, so the page and History keep both stays. IT works the accounts on a setup
// checklist: purpose RESTORE after an undo (no activation; they're already back) and REHIRE (they're Onboarding until IT
// finishes), both linked by member like a support's setup, with restoreKeys naming the tasks that bring an old account back
// rather than create one. A finished removal that was reversed keeps its record with reversedAt (and cancelledAt, so a later
// leaving can open a new one). Events LEAVING_UNDONE and REHIRED hold flags only. The rollback refuses while any of it exists.
const DISPATCH_EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED','DETAILS_CORRECTED','LEAVE_RECORDED','LEAVE_CHANGED','LEAVE_ENDED','PAPER_SCAN_ADDED','PAPER_SCAN_VIEWED','MEMBERS_EXPORTED','NAMES_CHANGED','LEFT_DAY_RECORDED','CLOSE_ACCOUNTS_ASKED','SEAT_ADDED','SEAT_CHANGED','COMPANY_ACCOUNT_ADDED','COMPANY_ACCOUNT_CHANGED','PHOTO_ADDED','ID_PHOTO_VIEWED','ACCOUNT_SHARED','SHARING_ENDED','ACCOUNT_MOVED','ACCOUNTS_HANDED_OVER','TEAM_LEAD_SET','TEAM_LEAD_CLEARED','SHARED_OWNER_CHANGED','SIGNED_COPY_VIEWED'`;
export class BringBack1793380000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE it_onboarding_requests DROP CONSTRAINT "CHK_it_requests_purpose",
   ADD CONSTRAINT "CHK_it_requests_purpose" CHECK (purpose IN ('DISPATCHER','SUPPORT','REHIRE','RESTORE')),
   ADD COLUMN "restoreKeys" text[] NOT NULL DEFAULT '{}'`);
  // One open return checklist per person; the member lock comes first, so this only catches a writer that didn't take it.
  await q.query(`CREATE UNIQUE INDEX "UQ_it_requests_return_open" ON it_onboarding_requests ("memberId") WHERE purpose IN ('REHIRE','RESTORE') AND "completedAt" IS NULL AND "cancelledAt" IS NULL`);
  // A finished removal could never be cancelled; one that was reversed is, so a later leaving can open a new one.
  await q.query(`ALTER TABLE it_removal_requests ADD COLUMN "reversedAt" timestamptz NULL, ADD CONSTRAINT "CHK_it_removals_reversed" CHECK ("reversedAt" IS NULL OR ("cancelledAt" IS NOT NULL AND "completedAt" IS NOT NULL)),
   DROP CONSTRAINT it_removal_requests_check, ADD CONSTRAINT "CHK_it_removals_cancelled" CHECK ("cancelledAt" IS NULL OR "completedAt" IS NULL OR "reversedAt" IS NOT NULL)`);
  await q.query(`CREATE TABLE member_returns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "memberId" uuid NOT NULL REFERENCES dispatch_members(id), kind varchar(10) NOT NULL CHECK (kind IN ('UNDO','REHIRE')),
   "leftAt" timestamptz NOT NULL, "leftKnown" boolean NOT NULL DEFAULT true, "leftReason" text NULL,
   "previousJoinedAt" timestamptz NOT NULL, "previousStartKnown" boolean NOT NULL DEFAULT true,
   "firstDay" date NULL, reason varchar(500) NULL,
   "removalId" uuid NULL REFERENCES it_removal_requests(id), "setupRequestId" uuid NULL REFERENCES it_onboarding_requests(id),
   "actorId" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
   CONSTRAINT "CHK_member_returns_kind" CHECK (CASE kind WHEN 'UNDO' THEN reason IS NOT NULL AND "firstDay" IS NULL ELSE "firstDay" IS NOT NULL END))`);
  await q.query(`CREATE INDEX "IDX_member_returns_member" ON member_returns ("memberId", "createdAt")`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${DISPATCH_EVENTS},'LEAVING_UNDONE','REHIRED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_returns) OR EXISTS(SELECT 1 FROM it_onboarding_requests WHERE purpose IN ('REHIRE','RESTORE'))
   OR EXISTS(SELECT 1 FROM it_removal_requests WHERE "reversedAt" IS NOT NULL) OR EXISTS(SELECT 1 FROM dispatch_events WHERE event IN ('LEAVING_UNDONE','REHIRED')) AS found`);
  if (found.found) throw new Error('Refusing to roll back while undone leavings, rehires or their IT checklists are recorded.');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${DISPATCH_EVENTS}))`);
  await q.query(`DROP TABLE member_returns`);
  await q.query(`ALTER TABLE it_removal_requests DROP CONSTRAINT "CHK_it_removals_cancelled", ADD CONSTRAINT it_removal_requests_check CHECK ("cancelledAt" IS NULL OR "completedAt" IS NULL),
   DROP CONSTRAINT "CHK_it_removals_reversed", DROP COLUMN "reversedAt"`);
  await q.query(`DROP INDEX "UQ_it_requests_return_open"`);
  await q.query(`ALTER TABLE it_onboarding_requests DROP COLUMN "restoreKeys", DROP CONSTRAINT "CHK_it_requests_purpose",
   ADD CONSTRAINT "CHK_it_requests_purpose" CHECK (purpose IN ('DISPATCHER','SUPPORT'))`);
 }
}
