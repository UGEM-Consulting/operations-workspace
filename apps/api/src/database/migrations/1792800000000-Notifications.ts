import { MigrationInterface, QueryRunner } from 'typeorm';
// Staff Telegram connections and an outbox for notifications other than applicant decisions (setup complete for new
// hires, review and IT alerts for staff). Separate tables, so an older API never claims or misreads these rows.
export class Notifications1792800000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE staff_telegram_links (
      "userId" uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, "chatId" varchar(32) NOT NULL UNIQUE,
      username varchar(32), "linkedAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE staff_telegram_link_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "tokenHash" char(64) NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL, "consumedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now())`);
    // Exactly one recipient: an applicant (by application) or a staff user. No message text or addresses are stored.
    await q.query(`CREATE TABLE notification_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind varchar(20) NOT NULL CHECK (kind IN ('SETUP_COMPLETE', 'REVIEW_WAITING', 'IT_SETUP_WAITING')),
      "applicationId" uuid REFERENCES dispatcher_applications(id) ON DELETE CASCADE,
      "recipientId" uuid REFERENCES users(id) ON DELETE CASCADE,
      "referenceId" uuid NOT NULL,
      channel varchar(10) NOT NULL CHECK (channel IN ('EMAIL', 'TELEGRAM')),
      status varchar(10) NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED')),
      "failureCode" varchar(32), attempts integer NOT NULL DEFAULT 0, "claimedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "sentAt" timestamptz,
      CHECK (("applicationId" IS NULL) <> ("recipientId" IS NULL)))`);
    await q.query(`CREATE INDEX notification_deliveries_due ON notification_deliveries (status, "createdAt")`);
  }
  async down(q: QueryRunner): Promise<void> {
    const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM staff_telegram_links) OR EXISTS(SELECT 1 FROM notification_deliveries) AS recorded`);
    if (data.recorded) throw new Error('Cannot discard staff Telegram connections or notification history');
    await q.query('DROP TABLE notification_deliveries');
    await q.query('DROP TABLE staff_telegram_link_tokens');
    await q.query('DROP TABLE staff_telegram_links');
  }
}
