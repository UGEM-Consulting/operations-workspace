import { MigrationInterface, QueryRunner } from 'typeorm';
// Existing dispatchers (designed in the Design System and approved by the user 2026-11-02). People already working here get
// a record without onboarding: existing_member_records keeps who added them and the accounts and contacts a manager knows,
// and member_paper_documents the NDAs and SOPs signed on paper (the paper stays with the company). A catch-up link is an
// invitation naming the record (catchUpMemberId); accepting its application finishes the paperwork. Their IT removal has no
// setup request to name, so setupRequestId becomes optional.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED'`;
export class ExistingDispatchers1792960000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE existing_member_records (
   "memberId" uuid PRIMARY KEY REFERENCES dispatch_members(id) ON DELETE CASCADE, "addedBy" uuid NOT NULL REFERENCES users(id),
   "sourceName" varchar(200) NULL, "companyEmail" varchar(254) NULL, "ringCentralNumber" varchar(40) NULL,
   "personalEmail" varchar(254) NULL, "personalPhone" varchar(40) NULL, "acceptedAt" timestamptz NULL, "acceptedBy" uuid NULL REFERENCES users(id),
   "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE TABLE member_paper_documents (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NOT NULL REFERENCES dispatch_members(id) ON DELETE CASCADE,
   kind varchar NOT NULL CHECK (kind IN ('NDA','SOP')), "signedOn" date NOT NULL, "recordedBy" uuid NOT NULL REFERENCES users(id),
   "createdAt" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "UQ_member_paper_documents" UNIQUE ("memberId", kind))`);
  await q.query(`ALTER TABLE invitations ADD COLUMN "catchUpMemberId" uuid NULL REFERENCES dispatch_members(id)`);
  await q.query(`CREATE INDEX "IDX_invitations_catch_up" ON invitations ("catchUpMemberId") WHERE "catchUpMemberId" IS NOT NULL`);
  await q.query(`ALTER TABLE it_removal_requests ALTER "setupRequestId" DROP NOT NULL`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},'EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM existing_member_records) OR EXISTS(SELECT 1 FROM member_paper_documents) OR EXISTS(SELECT 1 FROM invitations WHERE "catchUpMemberId" IS NOT NULL)
   OR EXISTS(SELECT 1 FROM it_removal_requests WHERE "setupRequestId" IS NULL) AS kept`);
  if (data.kept) throw new Error('Cannot discard existing dispatcher records');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`ALTER TABLE it_removal_requests ALTER "setupRequestId" SET NOT NULL`);
  await q.query(`DROP INDEX "IDX_invitations_catch_up"`);
  await q.query(`ALTER TABLE invitations DROP COLUMN "catchUpMemberId"`);
  await q.query(`DROP TABLE member_paper_documents`);
  await q.query(`DROP TABLE existing_member_records`);
 }
}
