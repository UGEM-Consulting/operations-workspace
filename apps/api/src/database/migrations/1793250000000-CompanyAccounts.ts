import { MigrationInterface, QueryRunner } from 'typeorm';
// Company accounts at other MCs (Design System section 33, "Company accounts and load boards", approved 2026-11-13). One
// person keeps one record whatever company they work for: an account they have (or had) at another of our companies (MC),
// under the American name used there, is a row here beside their main accounts. Kept for load boards is an email left open
// because it signs in to a load board seat. Events hold field names and statuses, never emails or numbers.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED','DETAILS_CORRECTED','LEAVE_RECORDED','LEAVE_CHANGED','LEAVE_ENDED','PAPER_SCAN_ADDED','PAPER_SCAN_VIEWED','MEMBERS_EXPORTED','NAMES_CHANGED','LEFT_DAY_RECORDED','CLOSE_ACCOUNTS_ASKED','SEAT_ADDED','SEAT_CHANGED'`;
const NEW_EVENTS = `'COMPANY_ACCOUNT_ADDED','COMPANY_ACCOUNT_CHANGED'`;
export class CompanyAccounts1793250000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE member_company_accounts (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "memberId" uuid NOT NULL REFERENCES dispatch_members(id) ON DELETE CASCADE,
   "mcId" uuid REFERENCES mcs(id),
   "companyName" varchar(100),
   "nameUsed" varchar(100),
   "companyEmail" varchar(254),
   "ringCentralNumber" varchar(40),
   "ringCentralExtension" varchar(6),
   status varchar NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','KEPT_FOR_LOAD_BOARDS','CLOSED')),
   "closedAt" timestamptz,
   "closedBy" uuid REFERENCES users(id),
   "sourceName" varchar(200),
   "createdBy" uuid REFERENCES users(id),
   version integer NOT NULL DEFAULT 1,
   "createdAt" timestamptz NOT NULL DEFAULT now(),
   "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CONSTRAINT "CHK_member_company_accounts_company" CHECK (("mcId" IS NULL) <> ("companyName" IS NULL)),
   CONSTRAINT "CHK_member_company_accounts_something" CHECK ("companyEmail" IS NOT NULL OR "ringCentralNumber" IS NOT NULL),
   CONSTRAINT "CHK_member_company_accounts_closed" CHECK ((status = 'CLOSED') = ("closedAt" IS NOT NULL)))`);
  await q.query(`CREATE INDEX "IDX_member_company_accounts_member" ON member_company_accounts ("memberId")`);
  // An email open at one company belongs to one person, as main company emails do.
  await q.query(`CREATE UNIQUE INDEX "UQ_member_company_accounts_email" ON member_company_accounts (lower("companyEmail")) WHERE status <> 'CLOSED' AND "companyEmail" IS NOT NULL`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},${NEW_EVENTS}))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_company_accounts) OR EXISTS(SELECT 1 FROM dispatch_events WHERE event IN (${NEW_EVENTS})) AS found`);
  if (found.found) throw new Error('Refusing to roll back while company accounts at other MCs are recorded.');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`DROP TABLE member_company_accounts`);
 }
}
