import { MigrationInterface, QueryRunner } from 'typeorm';
import { EVENTS_AFTER_LETTERS, EVENTS_AFTER_REMINDERS } from '../driver-event-lists';
// Expiration reminders and E-Verify (designed as the Reminders and E-Verify group, approved 2026-11-09). Drivers connect
// their own Telegram chat with one-time links; reminders and their deliveries go in their own tables, apart from
// notification_deliveries, so an older API never claims or misreads them. E-Verify joins the clearance checklist as a
// result-only item: the case number and the I-9 stay out of the workspace.
const CLEARANCE_CHECKS = (items: string, results: string, everify: boolean) => [
 `key IN (${items})`,
 `status IN ('IN_PROGRESS','BLOCKED','COMPLETED','NOT_NEEDED')`,
 `result IN (${results})`,
 `status <> 'COMPLETED' OR "doneOn" IS NOT NULL`,
 `status <> 'NOT_NEEDED' OR (key IN ('PREVIOUS_EMPLOYERS','ROAD_TEST') AND note IS NOT NULL)`,
 `status <> 'BLOCKED' OR note IS NOT NULL OR key IN ('DRUG_TEST','CLEARINGHOUSE'${everify ? `,'E_VERIFY'` : ''})`,
 `(result IS NULL) = (key NOT IN ('DRUG_TEST','CLEARINGHOUSE'${everify ? `,'E_VERIFY'` : ''}))`,
 `key <> 'DRUG_TEST' OR result IN ('NEGATIVE','NOT_NEGATIVE','CANCELLED')`,
 `key <> 'CLEARINGHOUSE' OR result IN ('NO_VIOLATIONS','VIOLATIONS')`,
 `key <> 'DRUG_TEST' OR (status = 'COMPLETED') = (result = 'NEGATIVE')`,
 `key <> 'CLEARINGHOUSE' OR (status = 'COMPLETED') = (result = 'NO_VIOLATIONS')`,
 ...(everify ? [
  `key <> 'E_VERIFY' OR result IN ('EMPLOYMENT_AUTHORIZED','TENTATIVE_NONCONFIRMATION','FINAL_NONCONFIRMATION','CASE_CLOSED')`,
  `key <> 'E_VERIFY' OR status = CASE result WHEN 'EMPLOYMENT_AUTHORIZED' THEN 'COMPLETED' WHEN 'FINAL_NONCONFIRMATION' THEN 'BLOCKED' ELSE 'IN_PROGRESS' END`,
  `key <> 'E_VERIFY' OR "doneOn" IS NOT NULL`,
  `result IS DISTINCT FROM 'CASE_CLOSED' OR note IS NOT NULL`] : []),
];
const OLD_ITEMS = `'DRUG_TEST','CLEARINGHOUSE','PREVIOUS_EMPLOYERS','MEDICAL_REGISTRY','ROAD_TEST'`;
const OLD_RESULTS = `'NEGATIVE','NOT_NEGATIVE','CANCELLED','NO_VIOLATIONS','VIOLATIONS'`;
const EVERIFY_RESULTS = `'EMPLOYMENT_AUTHORIZED','TENTATIVE_NONCONFIRMATION','FINAL_NONCONFIRMATION','CASE_CLOSED'`;

export class SafetyReminders1793110000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_REMINDERS}))`);
  await this.clearanceChecks(q, CLEARANCE_CHECKS(`${OLD_ITEMS},'E_VERIFY'`, `${OLD_RESULTS},${EVERIFY_RESULTS}`, true));
  // A driver's private chat with the company bot, for reminders only. One chat belongs to one driver.
  await q.query(`CREATE TABLE driver_telegram_links ("driverId" uuid PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE, "chatId" varchar(32) NOT NULL UNIQUE,
   username varchar(32), "linkedAt" timestamptz NOT NULL DEFAULT now())`);
  // One-time connect links: from the driver's own page (createdBy NULL) or made by Safety to send. Only the SHA-256 is stored.
  await q.query(`CREATE TABLE driver_telegram_link_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   "tokenHash" char(64) NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL, "consumedAt" timestamptz, "createdBy" uuid REFERENCES users(id) ON DELETE SET NULL,
   "createdAt" timestamptz NOT NULL DEFAULT now())`);
  // One morning run per US Eastern day, whichever API instance gets there first.
  await q.query(`CREATE TABLE safety_reminder_runs (day date PRIMARY KEY, "createdAt" timestamptz NOT NULL DEFAULT now())`);
  // A staff member's morning message (DAILY) or the Safety manager's Monday summary (WEEKLY).
  await q.query(`CREATE TABLE safety_reminder_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "recipientId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   kind varchar(10) NOT NULL CHECK (kind IN ('DAILY','WEEKLY')), day date NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("recipientId", kind, day))`);
  // Each step a document (or a yearly review) reaches, once per audience and staff recipient: 60, 30 and 7 days before, and the day (0).
  await q.query(`CREATE TABLE safety_reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "driverId" uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
   audience varchar(10) NOT NULL CHECK (audience IN ('DRIVER','STAFF')),
   subject varchar(20) NOT NULL CHECK (subject IN ('DOCUMENT','OWNER_DOCUMENT','ANNUAL_REVIEW')), "subjectId" uuid NOT NULL,
   kind varchar(20) NOT NULL CHECK (kind IN ('LICENSE','MEDICAL_CARD','WORK_AUTHORIZATION','INSURANCE','REGISTRATION','ANNUAL_REVIEW')),
   "dueOn" date NOT NULL, step smallint NOT NULL CHECK (step IN (60,30,7,0)), "batchId" uuid REFERENCES safety_reminder_batches(id) ON DELETE CASCADE,
   "recipientId" uuid REFERENCES users(id) ON DELETE CASCADE, "createdAt" timestamptz NOT NULL DEFAULT now(),
   CHECK ((audience = 'STAFF') = ("batchId" IS NOT NULL)), CHECK ((audience = 'STAFF') = ("recipientId" IS NOT NULL)), CHECK (audience = 'STAFF' OR (step IN (30,7,0) AND kind IN ('LICENSE','MEDICAL_CARD'))))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_safety_reminders_step" ON safety_reminders (audience, subject, "subjectId", "dueOn", step, coalesce("recipientId", '00000000-0000-0000-0000-000000000000'))`);
  await q.query(`CREATE INDEX safety_reminders_driver ON safety_reminders ("driverId", "createdAt")`);
  // The outbox: a driver reminder or a staff batch, sent after the run commits and swept like the other outboxes. No text or addresses.
  await q.query(`CREATE TABLE safety_reminder_deliveries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "reminderId" uuid REFERENCES safety_reminders(id) ON DELETE CASCADE, "batchId" uuid REFERENCES safety_reminder_batches(id) ON DELETE CASCADE,
   channel varchar(10) NOT NULL CHECK (channel IN ('EMAIL','TELEGRAM')), status varchar(10) NOT NULL CHECK (status IN ('PENDING','SENDING','SENT','FAILED','SKIPPED')),
   "failureCode" varchar(32), attempts integer NOT NULL DEFAULT 0, "claimedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(), "sentAt" timestamptz,
   CHECK (num_nonnulls("reminderId", "batchId") = 1))`);
  await q.query(`CREATE INDEX safety_reminder_deliveries_due ON safety_reminder_deliveries (status, "createdAt")`);
  await q.query(`CREATE INDEX safety_reminder_deliveries_reminder ON safety_reminder_deliveries ("reminderId")`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM driver_telegram_links) OR EXISTS(SELECT 1 FROM driver_telegram_link_tokens) OR EXISTS(SELECT 1 FROM safety_reminders)
   OR EXISTS(SELECT 1 FROM safety_reminder_batches) OR EXISTS(SELECT 1 FROM driver_clearance_items WHERE key = 'E_VERIFY')
   OR EXISTS(SELECT 1 FROM driver_events WHERE event IN ('TELEGRAM_LINK_CREATED','TELEGRAM_CONNECTED','TELEGRAM_STOPPED')) AS kept`);
  if (data.kept) throw new Error('Cannot discard driver Telegram connections, reminders or E-Verify results');
  await q.query(`DROP TABLE safety_reminder_deliveries, safety_reminders, safety_reminder_batches, safety_reminder_runs, driver_telegram_link_tokens, driver_telegram_links`);
  await this.clearanceChecks(q, CLEARANCE_CHECKS(OLD_ITEMS, OLD_RESULTS, false));
  await q.query(`ALTER TABLE driver_events DROP CONSTRAINT "driver_events_event_check"`);
  await q.query(`ALTER TABLE driver_events ADD CONSTRAINT "driver_events_event_check" CHECK (event IN (${EVENTS_AFTER_LETTERS}))`);
 }
 /** Replaces every CHECK on driver_clearance_items (the first ones were unnamed) with this list, named in order. */
 private async clearanceChecks(q: QueryRunner, checks: string[]) {
  const existing: { conname: string }[] = await q.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'driver_clearance_items'::regclass AND contype = 'c'`);
  for (const { conname } of existing) await q.query(`ALTER TABLE driver_clearance_items DROP CONSTRAINT "${conname}"`);
  for (const [index, check] of checks.entries()) await q.query(`ALTER TABLE driver_clearance_items ADD CONSTRAINT "CHK_driver_clearance_items_${index + 1}" CHECK (${check})`);
 }
}
