import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_LETTERS, EVENTS_AFTER_RENEWALS } from '../driver-event-lists';
// The pre-adverse and final notice letters (designed as the Safety follow-ups group, approved 2026-11-06): the Safety
// manager publishes the PDFs their adviser approved, as immutable versions like the consent forms, with places for the
// driver's name, address and the date. A letter is filled in when it is downloaded and never stored; the driver's events
// record only that one was made (kind, and whether the MVR was attached).
export class NoticeLetters1793100000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_LETTERS}))`);
  await q.query(`CREATE TABLE driver_notice_letters (id uuid PRIMARY KEY, kind varchar NOT NULL CHECK (kind IN ('PRE_ADVERSE','FINAL')), version integer NOT NULL CHECK (version > 0),
   title varchar(200) NOT NULL CHECK (length(btrim(title)) > 0), sha256 char(64) NOT NULL, "byteSize" integer NOT NULL, "pageCount" integer NOT NULL CHECK ("pageCount" > 0),
   fields jsonb NOT NULL DEFAULT '[]', "uploadedBy" uuid NOT NULL REFERENCES users(id),
   "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE (kind, version))`);
  // refuse_evidence_change() comes from OnboardingDocuments1792710000000: a published version never changes.
  await q.query(`CREATE TRIGGER driver_notice_letters_append_only BEFORE UPDATE OR DELETE ON driver_notice_letters FOR EACH ROW EXECUTE FUNCTION refuse_evidence_change()`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_notice_letters) OR EXISTS(SELECT 1 FROM driver_events WHERE event = 'NOTICE_LETTER_DOWNLOADED') AS kept`);
  if (data.kept) throw new Error('Cannot discard notice letters');
  await q.query(`DROP TABLE driver_notice_letters`);
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_RENEWALS}))`);
 }
}
