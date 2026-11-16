import { MigrationInterface, QueryRunner } from 'typeorm';
// Telegram groups (Design System section 34, "Telegram groups", approved 2026-11-16; phases 1 and 2 of the plan the user
// agreed on 2026-11-06): administrators link a department's or a team's Telegram group with a one-time code typed in the
// group, and choose for each alert whether it goes to people, to the group, or both. A group gets only what is waiting and a
// link to the workspace. Group messages have their own outbox, apart from notification_deliveries, so an older API never
// claims them; two new alerts join the staff ones (team lead sign-ins for IT, and a truck's Telegram group needing a change).
const DELIVERY_KINDS = `'SETUP_COMPLETE','REVIEW_WAITING','IT_SETUP_WAITING','IT_REMOVAL_WAITING','IT_REMOVAL_SCHEDULED','IT_REMOVAL_DUE','IT_REMOVAL_NOW','IT_LEAVE_SUSPEND','IT_LEAVE_RESTORE'`;
export class TelegramGroups1793290000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE telegram_groups (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "chatId" varchar(32) NOT NULL,
   title varchar(255),
   purpose varchar NOT NULL CHECK (purpose IN ('IT','SAFETY','DISPATCH_MANAGERS','TEAM')),
   "teamId" uuid REFERENCES teams(id),
   "linkedBy" uuid NOT NULL REFERENCES users(id),
   "linkedAt" timestamptz NOT NULL DEFAULT now(),
   "unlinkedAt" timestamptz,
   "unlinkedBy" uuid REFERENCES users(id),
   -- The bot was removed from the group, or the group can't be reached any more.
   "lostAt" timestamptz,
   "lastMessageAt" timestamptz,
   CONSTRAINT "CHK_telegram_groups_team" CHECK ((purpose = 'TEAM') = ("teamId" IS NOT NULL)))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_telegram_groups_chat" ON telegram_groups ("chatId") WHERE "unlinkedAt" IS NULL`);
  await q.query(`CREATE UNIQUE INDEX "UQ_telegram_groups_purpose" ON telegram_groups (purpose) WHERE "unlinkedAt" IS NULL AND purpose <> 'TEAM'`);
  await q.query(`CREATE UNIQUE INDEX "UQ_telegram_groups_team" ON telegram_groups ("teamId") WHERE "unlinkedAt" IS NULL`);
  await q.query(`CREATE TABLE telegram_group_link_codes (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "codeHash" char(64) NOT NULL,
   purpose varchar NOT NULL CHECK (purpose IN ('IT','SAFETY','DISPATCH_MANAGERS','TEAM')),
   "teamId" uuid REFERENCES teams(id),
   "createdBy" uuid NOT NULL REFERENCES users(id),
   "expiresAt" timestamptz NOT NULL,
   "consumedAt" timestamptz,
   "groupId" uuid REFERENCES telegram_groups(id),
   "createdAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE INDEX "IDX_telegram_group_link_codes_hash" ON telegram_group_link_codes ("codeHash") WHERE "consumedAt" IS NULL`);
  // Only what an administrator changed; every other alert keeps its default (groups.ts ALERT_ROUTES).
  await q.query(`CREATE TABLE telegram_alert_routes (
   alert varchar(32) PRIMARY KEY,
   "sendTo" varchar NOT NULL CHECK ("sendTo" IN ('PEOPLE','GROUP','BOTH')),
   "updatedBy" uuid NOT NULL REFERENCES users(id),
   "updatedAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`CREATE TABLE telegram_group_deliveries (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "groupId" uuid NOT NULL REFERENCES telegram_groups(id),
   kind varchar(32) NOT NULL,
   "referenceId" uuid,
   status varchar(10) NOT NULL CHECK (status IN ('PENDING','SENDING','SENT','FAILED','SKIPPED')),
   "failureCode" varchar(32),
   attempts integer NOT NULL DEFAULT 0,
   "claimedAt" timestamptz,
   "createdAt" timestamptz NOT NULL DEFAULT now(),
   "sentAt" timestamptz)`);
  await q.query(`CREATE INDEX "IDX_telegram_group_deliveries_pending" ON telegram_group_deliveries ("createdAt") WHERE status IN ('PENDING','SENDING')`);
  await q.query(`ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_kind_check,
   ADD CONSTRAINT notification_deliveries_kind_check CHECK (kind IN (${DELIVERY_KINDS},'TRUCK_GROUP_CHANGE'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM telegram_groups) OR EXISTS(SELECT 1 FROM telegram_alert_routes) OR EXISTS(SELECT 1 FROM notification_deliveries WHERE kind = 'TRUCK_GROUP_CHANGE') AS found`);
  if (found.found) throw new Error('Refusing to roll back while Telegram groups, alert routes or truck group alerts are recorded.');
  await q.query(`ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_kind_check, ADD CONSTRAINT notification_deliveries_kind_check CHECK (kind IN (${DELIVERY_KINDS}))`);
  await q.query(`DROP TABLE telegram_group_deliveries`);
  await q.query(`DROP TABLE telegram_alert_routes`);
  await q.query(`DROP TABLE telegram_group_link_codes`);
  await q.query(`DROP TABLE telegram_groups`);
 }
}
