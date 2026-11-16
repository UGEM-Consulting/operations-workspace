import { MigrationInterface, QueryRunner } from 'typeorm';
// Load board accounts and seats (Design System section 33, "Company accounts and load boards", approved 2026-11-13). The
// company's DAT and Truckstop accounts are a list IT and administrators keep; each person's access is a seat on one of them,
// with the sign-in email they use (never a password). Seats keep their history: suspended, moved and ended seats stay.
// Sign-ins recorded before this list become seats on "<provider> account not recorded", to be moved to their real account;
// the old columns stay, so an older API keeps working while both run. Events hold actions and flags, never sign-ins.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED','DETAILS_CORRECTED','LEAVE_RECORDED','LEAVE_CHANGED','LEAVE_ENDED','PAPER_SCAN_ADDED','PAPER_SCAN_VIEWED','MEMBERS_EXPORTED','NAMES_CHANGED','LEFT_DAY_RECORDED','CLOSE_ACCOUNTS_ASKED'`;
const NEW_EVENTS = `'SEAT_ADDED','SEAT_CHANGED'`;
// What each person's recorded sign-ins were: a manager's record, then what IT recorded on their setups (newest first).
const RECORDED = (column: string) => `SELECT d.id AS "memberId", d.status, d."leftAt", d."joinedAt", coalesce(
   (SELECT r."${column}" FROM it_onboarding_requests r WHERE r."${column}" IS NOT NULL AND r."cancelledAt" IS NULL AND (r."memberId" = d.id OR r."applicationId" = d."applicationId") ORDER BY r."createdAt" DESC LIMIT 1),
   (SELECT e."${column}" FROM existing_member_records e WHERE e."memberId" = d.id)) AS email FROM dispatch_members d`;
export class LoadBoardSeats1793240000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE load_board_accounts (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   provider varchar NOT NULL CHECK (provider IN ('DAT','TRUCKSTOP')),
   name varchar(100) NOT NULL,
   "nameKey" varchar(100) NOT NULL,
   "mcId" uuid REFERENCES mcs(id),
   "companyName" varchar(100),
   placeholder boolean NOT NULL DEFAULT false,
   "archivedAt" timestamptz,
   version integer NOT NULL DEFAULT 1,
   "createdAt" timestamptz NOT NULL DEFAULT now(),
   "updatedAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE UNIQUE INDEX "UQ_load_board_accounts_nameKey" ON load_board_accounts ("nameKey")`);
  await q.query(`CREATE UNIQUE INDEX "UQ_load_board_accounts_placeholder" ON load_board_accounts (provider) WHERE placeholder`);
  await q.query(`CREATE TABLE member_load_board_seats (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "memberId" uuid NOT NULL REFERENCES dispatch_members(id) ON DELETE CASCADE,
   "accountId" uuid NOT NULL REFERENCES load_board_accounts(id),
   "signInEmail" varchar(254) NOT NULL,
   status varchar NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','ENDED')),
   "startedAt" timestamptz NOT NULL,
   "suspendedAt" timestamptz,
   "endedAt" timestamptz,
   "endedHow" varchar CHECK ("endedHow" IN ('ENDED','MOVED','LEFT')),
   "createdBy" uuid REFERENCES users(id),
   "endedBy" uuid REFERENCES users(id),
   version integer NOT NULL DEFAULT 1,
   "createdAt" timestamptz NOT NULL DEFAULT now(),
   "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CONSTRAINT "CHK_member_load_board_seats_ended" CHECK ((status = 'ENDED') = ("endedAt" IS NOT NULL AND "endedHow" IS NOT NULL)),
   CONSTRAINT "CHK_member_load_board_seats_suspended" CHECK ((status = 'SUSPENDED') = ("suspendedAt" IS NOT NULL)))`);
  // One open seat per person and account; an ended one stays as history.
  await q.query(`CREATE UNIQUE INDEX "UQ_member_load_board_seats_open" ON member_load_board_seats ("memberId", "accountId") WHERE status <> 'ENDED'`);
  await q.query(`CREATE INDEX "IDX_member_load_board_seats_account" ON member_load_board_seats ("accountId")`);
  await q.query(`CREATE INDEX "IDX_member_load_board_seats_email" ON member_load_board_seats ("signInEmail") WHERE status <> 'ENDED'`);
  await q.query(`INSERT INTO load_board_accounts (provider, name, "nameKey", placeholder) VALUES
   ('DAT', 'DAT account not recorded', 'dat account not recorded', true), ('TRUCKSTOP', 'Truckstop account not recorded', 'truckstop account not recorded', true)`);
  // Sign-ins recorded so far: open seats for people here, ended on their last day for people who left.
  for (const [provider, column] of [['DAT', 'datEmail'], ['TRUCKSTOP', 'truckstopEmail']]) {
   await q.query(`INSERT INTO member_load_board_seats ("memberId", "accountId", "signInEmail", status, "startedAt", "endedAt", "endedHow")
    SELECT x."memberId", a.id, lower(x.email), CASE WHEN x.status = 'LEFT' THEN 'ENDED' ELSE 'ACTIVE' END, x."joinedAt",
     CASE WHEN x.status = 'LEFT' THEN coalesce(x."leftAt", now()) END, CASE WHEN x.status = 'LEFT' THEN 'LEFT' END
    FROM (${RECORDED(column)}) x JOIN load_board_accounts a ON a.provider = $1 AND a.placeholder WHERE x.email IS NOT NULL`, [provider]);
  }
  await q.query(`ALTER TABLE list_events DROP CONSTRAINT list_events_list_check, ADD CONSTRAINT list_events_list_check CHECK (list IN ('MC','JOB_TITLE','LOAD_BOARD_ACCOUNT'))`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},${NEW_EVENTS}))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM load_board_accounts WHERE NOT placeholder)
    OR EXISTS(SELECT 1 FROM dispatch_events WHERE event IN (${NEW_EVENTS}))
    OR EXISTS(SELECT 1 FROM list_events WHERE list = 'LOAD_BOARD_ACCOUNT') AS found`);
  if (found.found) throw new Error('Refusing to roll back while load board accounts or seat changes are recorded.');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`ALTER TABLE list_events DROP CONSTRAINT list_events_list_check, ADD CONSTRAINT list_events_list_check CHECK (list IN ('MC','JOB_TITLE'))`);
  await q.query(`DROP TABLE member_load_board_seats`);
  await q.query(`DROP TABLE load_board_accounts`);
 }
}
