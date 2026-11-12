import { MigrationInterface, QueryRunner } from 'typeorm';
// Trusted devices and paper copies (section 38, designed and approved 2026-11-11). Staff other than administrators may skip the
// sign-in code for 30 days on a device they trust: staff_trusted_devices holds only a hash of the device cookie, tied to the
// account's authVersion, so any change that ends their sessions forgets every device. member_paper_scans keeps scans of an NDA or
// SOP signed on paper by someone added by hand (private storage, members/<member>/paper/<kind>/<scan>.pdf); a replaced scan stays.
const EVENTS = `'MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED','TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED','PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED','NOTICE_RECORDED','NOTICE_CHANGED','NOTICE_CANCELLED','ACCESS_REMOVAL_REQUESTED','EXISTING_ADDED','EXISTING_UPDATED','CATCH_UP_LINK_CREATED','PAPERWORK_ACCEPTED','MEMBER_PLACED','START_DATE_RECORDED','SUPPORT_TYPE_CHANGED','DETAILS_CORRECTED','LEAVE_RECORDED','LEAVE_CHANGED','LEAVE_ENDED'`;
export class TrustedDevicesPaperScans1793170000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE staff_trusted_devices (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   "tokenHash" char(64) NOT NULL, "authVersion" integer NOT NULL, label varchar(80) NOT NULL,
   "createdAt" timestamptz NOT NULL DEFAULT now(), "lastUsedAt" timestamptz NOT NULL DEFAULT now(), "expiresAt" timestamptz NOT NULL,
   CONSTRAINT "UQ_staff_trusted_devices_token" UNIQUE ("tokenHash"))`);
  await q.query(`CREATE INDEX "IDX_staff_trusted_devices_user" ON staff_trusted_devices ("userId")`);
  await q.query(`CREATE TABLE member_paper_scans (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NOT NULL REFERENCES dispatch_members(id),
   kind varchar NOT NULL CHECK (kind IN ('NDA','SOP')), "pageCount" integer NOT NULL CHECK ("pageCount" > 0), sha256 char(64) NOT NULL, "byteSize" integer NOT NULL,
   "uploadedBy" uuid NOT NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now(), "replacedAt" timestamptz NULL)`);
  await q.query(`CREATE UNIQUE INDEX "UQ_member_paper_scans_current" ON member_paper_scans ("memberId", kind) WHERE "replacedAt" IS NULL`);
  // The profile's earlier scans (replaced ones pile up, never deleted) and the member foreign key.
  await q.query(`CREATE INDEX "IDX_member_paper_scans_member" ON member_paper_scans ("memberId", kind)`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check,
   ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS},'PAPER_SCAN_ADDED','PAPER_SCAN_VIEWED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [scans] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_paper_scans) OR EXISTS(SELECT 1 FROM dispatch_events WHERE event IN ('PAPER_SCAN_ADDED','PAPER_SCAN_VIEWED')) AS found`);
  if (scans.found) throw new Error('Refusing to roll back paper scans while scans or their events exist.');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_check, ADD CONSTRAINT dispatch_events_event_check CHECK (event IN (${EVENTS}))`);
  await q.query(`DROP TABLE member_paper_scans`);
  // Trusted devices are a convenience only: dropping them just asks for a code at the next sign-in.
  await q.query(`DROP TABLE staff_trusted_devices`);
 }
}
