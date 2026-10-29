import { MigrationInterface, QueryRunner } from 'typeorm';
// Dispatchers are ONBOARDING from approval until IT completes setup, then ACTIVE (set in the IT completion transaction);
// existing members whose IT request is still open move back to ONBOARDING. member_contacts holds extra emails and phone
// numbers staff add later; removing one keeps the row with who and when. dispatch_events gains the contact events.
export class DispatcherContacts1792830000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE dispatch_members DROP CONSTRAINT "dispatch_members_status_check"`);
  await q.query(`ALTER TABLE dispatch_members ADD CONSTRAINT "dispatch_members_status_check" CHECK (status IN ('ONBOARDING','ACTIVE','LEFT'))`);
  await q.query(`UPDATE dispatch_members d SET status = 'ONBOARDING' FROM it_onboarding_requests r
   WHERE r."applicationId" = d."applicationId" AND r."completedAt" IS NULL AND d.status = 'ACTIVE'`);
  await q.query(`CREATE TABLE member_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NOT NULL REFERENCES dispatch_members(id),
   kind varchar NOT NULL CHECK (kind IN ('EMAIL','PHONE')), value varchar(254) NOT NULL, label varchar(50) NULL,
   "addedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
   "removedAt" timestamptz NULL, "removedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL)`);
  await q.query(`CREATE UNIQUE INDEX "UQ_member_contacts_open" ON member_contacts ("memberId", kind, lower(value)) WHERE "removedAt" IS NULL`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT "dispatch_events_event_check"`);
  await q.query(`ALTER TABLE dispatch_events ADD CONSTRAINT "dispatch_events_event_check" CHECK (event IN ('MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED',
   'TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_contacts) AS contacts`);
  if (data.contacts) throw new Error('Cannot discard added dispatcher contacts');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT "dispatch_events_event_check"`);
  await q.query(`ALTER TABLE dispatch_events ADD CONSTRAINT "dispatch_events_event_check" CHECK (event IN ('MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED',
   'TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED'))`);
  await q.query(`DROP TABLE member_contacts`);
  await q.query(`UPDATE dispatch_members SET status = 'ACTIVE' WHERE status = 'ONBOARDING'`);
  await q.query(`ALTER TABLE dispatch_members DROP CONSTRAINT "dispatch_members_status_check"`);
  await q.query(`ALTER TABLE dispatch_members ADD CONSTRAINT "dispatch_members_status_check" CHECK (status IN ('ACTIVE','LEFT'))`);
 }
}
