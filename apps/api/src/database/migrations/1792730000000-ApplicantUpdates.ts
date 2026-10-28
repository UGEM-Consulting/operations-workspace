import { MigrationInterface, QueryRunner } from 'typeorm';
// Applicant status updates: chosen channels, the connected Telegram chat, one-time connect links,
// a metadata-only delivery outbox and the Telegram polling position. All additive.
export class ApplicantUpdates1792730000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE applicant_update_settings (
   "applicationId" uuid PRIMARY KEY REFERENCES dispatcher_applications(id), email boolean NOT NULL DEFAULT true, telegram boolean NOT NULL DEFAULT false,
   "telegramChatId" varchar(32), "telegramUsername" varchar(32), "telegramLinkedAt" timestamptz, "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CHECK (email OR telegram), CHECK (("telegramChatId" IS NULL) = ("telegramLinkedAt" IS NULL)))`);
  await q.query(`CREATE TABLE telegram_link_tokens (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "applicationId" uuid NOT NULL REFERENCES dispatcher_applications(id),
   "tokenHash" char(64) NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL, "consumedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE TABLE applicant_update_deliveries (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "applicationId" uuid NOT NULL REFERENCES dispatcher_applications(id),
   "reviewId" uuid NOT NULL REFERENCES application_reviews(id), channel varchar NOT NULL CHECK (channel IN ('EMAIL','TELEGRAM')),
   status varchar NOT NULL CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')), "failureCode" varchar(32),
   "createdAt" timestamptz NOT NULL DEFAULT now(), "sentAt" timestamptz, UNIQUE ("reviewId",channel),
   CHECK ((status = 'SENT') = ("sentAt" IS NOT NULL)))`);
  await q.query(`CREATE INDEX update_deliveries_application ON applicant_update_deliveries ("applicationId","createdAt")`);
  await q.query(`CREATE TABLE telegram_poll_state (id smallint PRIMARY KEY CHECK (id = 1), "updateOffset" bigint NOT NULL)`);
  await q.query(`INSERT INTO telegram_poll_state (id,"updateOffset") VALUES (1,0)`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM applicant_update_deliveries) OR EXISTS(SELECT 1 FROM applicant_update_settings) AS recorded`);
  if (data.recorded) throw new Error('Cannot discard applicant update preferences or delivery records');
  await q.query(`DROP TABLE telegram_poll_state, applicant_update_deliveries, telegram_link_tokens, applicant_update_settings`);
 }
}
