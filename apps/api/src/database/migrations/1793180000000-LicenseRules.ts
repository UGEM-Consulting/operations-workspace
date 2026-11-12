import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_LICENSE, EVENTS_AFTER_REMINDERS } from '../driver-event-lists';
// Rules by license (section 39, designed and approved 2026-11-12). Clearance follows the license in code: the Clearinghouse
// query only for CDL drivers, the road test only for a DL (a CDL stands in for it). This adds what is stored: the PSP report
// and a DL driver's road test certificate (driver_reports kinds), a CDL driver's return-to-duty papers (a driver document
// kind), the PSP form, the DOT testing authorization and the application certification (consent form kinds), and their
// events. The application's new answers live in its JSON fields and history.
const REPORTS_BEFORE = `'MVR','ANNUAL_MVR'`, DOCUMENTS_BEFORE = `'LICENSE','MEDICAL_CARD','WORK_AUTHORIZATION'`;
const CONSENTS_BEFORE = `'BACKGROUND_DISCLOSURE','BACKGROUND_AUTHORIZATION','CLEARINGHOUSE_CONSENT'`;
export class LicenseRules1793180000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await this.checks(q, EVENTS_AFTER_LICENSE, `${REPORTS_BEFORE},'PSP','ROAD_TEST'`, `${DOCUMENTS_BEFORE},'RETURN_TO_DUTY'`,
   `${CONSENTS_BEFORE},'PSP_AUTHORIZATION','DOT_TESTING_AUTHORIZATION','APPLICATION_CERTIFICATION'`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_reports WHERE kind IN ('PSP','ROAD_TEST')) OR EXISTS(SELECT 1 FROM driver_documents WHERE kind = 'RETURN_TO_DUTY')
   OR EXISTS(SELECT 1 FROM driver_consent_documents WHERE kind IN ('PSP_AUTHORIZATION','DOT_TESTING_AUTHORIZATION','APPLICATION_CERTIFICATION'))
   OR EXISTS(SELECT 1 FROM driver_events WHERE event IN ('PSP_UPLOADED','PSP_VIEWED','ROAD_TEST_RECORDED')) AS kept`);
  if (data.kept) throw new Error('Refusing to roll back license rules while PSP reports, road test certificates, return-to-duty papers, the new forms or their events exist.');
  await this.checks(q, EVENTS_AFTER_REMINDERS, REPORTS_BEFORE, DOCUMENTS_BEFORE, CONSENTS_BEFORE);
 }
 private async checks(q: QueryRunner, events: string, reports: string, documents: string, consents: string) {
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check", ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${events}))`);
  await q.query(`ALTER TABLE driver_reports DROP CONSTRAINT "driver_reports_kind_check", ADD CONSTRAINT "driver_reports_kind_check" CHECK (kind IN (${reports}))`);
  await q.query(`ALTER TABLE driver_documents DROP CONSTRAINT "driver_documents_kind_check", ADD CONSTRAINT "driver_documents_kind_check" CHECK (kind IN (${documents}))`);
  await q.query(`ALTER TABLE driver_consent_documents DROP CONSTRAINT "driver_consent_documents_kind_check", ADD CONSTRAINT "driver_consent_documents_kind_check" CHECK (kind IN (${consents}))`);
 }
}
