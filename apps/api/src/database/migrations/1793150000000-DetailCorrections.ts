import { MigrationInterface, QueryRunner } from 'typeorm';
// Correcting a dispatcher's details (section 36, designed and approved 2026-11-11): an administrator's corrections of what an
// application says live on the dispatcher record, and each change is kept with the earlier and new value, the reason and who
// made it. The application never changes. The column default keeps rows an older API writes during an overlapping deploy correct.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED'`;
export class DetailCorrections1793150000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE dispatch_members ADD COLUMN "correctedDetails" jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await q.query(`CREATE TABLE member_detail_corrections (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NOT NULL REFERENCES dispatch_members(id),
   changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array' AND jsonb_array_length(changes) > 0),
   reason varchar(500) NOT NULL CHECK (btrim(reason) <> ''), "actorId" uuid NOT NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE INDEX "IDX_member_detail_corrections_member" ON member_detail_corrections ("memberId", "createdAt")`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},'DETAILS_CORRECTED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [row] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_detail_corrections) OR EXISTS(SELECT 1 FROM dispatch_events WHERE event = 'DETAILS_CORRECTED') AS kept`);
  if (row.kept) throw new Error('Cannot discard corrected dispatcher details');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`DROP TABLE member_detail_corrections`);
  await q.query(`ALTER TABLE dispatch_members DROP COLUMN "correctedDetails"`);
 }
}
