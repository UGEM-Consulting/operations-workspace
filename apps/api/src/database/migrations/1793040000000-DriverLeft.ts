import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_LEFT, EVENTS_BEFORE_LEFT } from '../driver-event-lists';
// Driver Left (Safety compliance, phase 2): an approved or cleared driver who stops driving for the company is marked Left
// with a reason and a last day. The status already exists; this adds the LEFT event and nothing else. Rollback refuses
// while any driver is Left or any LEFT event exists.
export class DriverLeft1793040000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_LEFT}))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM drivers WHERE status = 'LEFT') OR EXISTS(SELECT 1 FROM driver_events WHERE event = 'LEFT') AS kept`);
  if (data.kept) throw new Error('Cannot discard drivers marked as left');
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_BEFORE_LEFT}))`);
 }
}
