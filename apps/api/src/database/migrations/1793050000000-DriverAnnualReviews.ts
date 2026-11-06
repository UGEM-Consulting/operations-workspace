import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_ANNUAL, EVENTS_AFTER_LEFT } from '../driver-event-lists';
// Yearly driver reviews (Safety compliance, phase 3; FMCSA 391.25): once a cleared driver has been with the company for a
// year, the owner or Safety manager pulls a new MVR, reviews the driving record and records the outcome. Reviews are
// append-only history; the MVR is an ordinary driver_reports row of kind ANNUAL_MVR (so the sweeper keeps its file).
export class DriverAnnualReviews1793050000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_reports DROP CONSTRAINT "driver_reports_kind_check"`);
  await q.query(`ALTER TABLE driver_reports ADD CONSTRAINT "driver_reports_kind_check" CHECK (kind IN ('MVR','ANNUAL_MVR'))`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_ANNUAL}))`);
  await q.query(`CREATE TABLE driver_annual_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   "reviewedOn" date NOT NULL, outcome varchar NOT NULL CHECK (outcome IN ('QUALIFIED','NOT_QUALIFIED')), note varchar(1000) NULL,
   "reportId" uuid NULL REFERENCES driver_reports(id), "reviewerId" uuid NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now(),
   CHECK (outcome = 'QUALIFIED' OR note IS NOT NULL))`);
  await q.query(`CREATE INDEX "IDX_driver_annual_reviews_driver" ON driver_annual_reviews ("driverId", "reviewedOn")`);
  await q.query(`CREATE TRIGGER driver_annual_reviews_append_only BEFORE UPDATE OR DELETE ON driver_annual_reviews FOR EACH ROW EXECUTE FUNCTION refuse_evidence_change()`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_annual_reviews) OR EXISTS(SELECT 1 FROM driver_reports WHERE kind = 'ANNUAL_MVR')
   OR EXISTS(SELECT 1 FROM driver_events WHERE event = 'ANNUAL_REVIEW_RECORDED') AS kept`);
  if (data.kept) throw new Error('Cannot discard yearly driver reviews or their MVRs');
  await q.query(`DROP TABLE driver_annual_reviews`);
  await q.query(`ALTER TABLE driver_reports DROP CONSTRAINT "driver_reports_kind_check"`);
  await q.query(`ALTER TABLE driver_reports ADD CONSTRAINT "driver_reports_kind_check" CHECK (kind IN ('MVR'))`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_LEFT}))`);
 }
}
