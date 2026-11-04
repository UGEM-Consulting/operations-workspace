import { MigrationInterface, QueryRunner } from 'typeorm';
// Missing details (designed in the Design System and approved by the user 2026-11-04). Someone already working here can be added
// with no start date and no MC. startDateKnown says dispatch_members.joinedAt is a real start date and not just the day they were
// added; periodDateKnown says the same of their first MC and team period, or a support's first dispatcher period. A dispatcher with
// no MC yet has no member_assignments row. member_start_date_changes keeps each date a manager added or corrected, with the reason.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED'`;
export class MissingDetails1792980000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE existing_member_records ADD COLUMN "startDateKnown" boolean NOT NULL DEFAULT true, ADD COLUMN "periodDateKnown" boolean NOT NULL DEFAULT true`);
  await q.query(`CREATE TABLE member_start_date_changes (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NOT NULL REFERENCES dispatch_members(id) ON DELETE CASCADE,
   "startedOn" date NOT NULL, "previousOn" date NULL, reason varchar(500) NULL, "actorId" uuid NOT NULL REFERENCES users(id),
   "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE INDEX "IDX_member_start_date_changes_member" ON member_start_date_changes ("memberId")`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},'MEMBER_PLACED','START_DATE_RECORDED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM existing_member_records WHERE NOT "startDateKnown" OR NOT "periodDateKnown") OR EXISTS(SELECT 1 FROM member_start_date_changes)
   OR EXISTS(SELECT 1 FROM dispatch_events WHERE event IN ('MEMBER_PLACED','START_DATE_RECORDED'))
   OR EXISTS(SELECT 1 FROM existing_member_records r JOIN dispatch_members d ON d.id = r."memberId" WHERE d.position = 'DISPATCHER' AND NOT EXISTS (SELECT 1 FROM member_assignments a WHERE a."memberId" = d.id)) AS kept`);
  if (data.kept) throw new Error('Cannot discard missing details or start date history');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`DROP TABLE member_start_date_changes`);
  await q.query(`ALTER TABLE existing_member_records DROP COLUMN "periodDateKnown", DROP COLUMN "startDateKnown"`);
 }
}
