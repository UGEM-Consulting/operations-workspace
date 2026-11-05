import { MigrationInterface, QueryRunner } from 'typeorm';
// Driver Left (Safety compliance, phase 2): an approved or cleared driver who stops driving for the company is marked Left
// with a reason and a last day. The status already exists; this adds the LEFT event and nothing else. Rollback refuses
// while any driver is Left or any LEFT event exists.
const EVENTS = `'CREATED','UPDATED','WITHDRAWN','REOPENED','SAFETY_LEAD_CHANGED','OWNER_ASSIGNED','LINK_SENT','LINK_CANCELLED','APPLICATION_VERIFIED','APPLICATION_SUBMITTED','SSN_REVEALED','DOCUMENT_UPLOADED','DOCUMENT_VERIFIED','DOCUMENT_VIEWED','SCREENING_CHECKED','MVR_UPLOADED','MVR_VIEWED','CORRECTIONS_REQUESTED','SENT_FOR_DECISION','APPROVED','MORE_INFO_REQUESTED','PRE_ADVERSE_RECORDED','REJECTED','CONSENT_SIGNED','CLEARANCE_RECORDED','EMPLOYER_RECORDED','CLEARED','DISPATCH_ASSIGNED'`;
export class DriverLeft1793040000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS},'LEFT'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM drivers WHERE status = 'LEFT') OR EXISTS(SELECT 1 FROM driver_events WHERE event = 'LEFT') AS kept`);
  if (data.kept) throw new Error('Cannot discard drivers marked as left');
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS}))`);
 }
}
