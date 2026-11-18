import { MigrationInterface, QueryRunner } from 'typeorm';
// Announcements to team groups (Design System section 37, approved 2026-11-18; Telegram groups phase 3): a dispatch manager,
// an administrator or a team lead writes a message in the workspace and the bot posts it in the chosen teams' Telegram
// groups. The text is staff text kept for staff; deliveries keep each group's Telegram message id so it can be taken back
// (Telegram lets a bot delete its own group messages for 48 hours). Apart from telegram_group_deliveries, so an older API
// never claims an announcement.
export class TeamAnnouncements1793330000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE team_announcements (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   text varchar(1000) NOT NULL,
   "createdBy" uuid NOT NULL REFERENCES users(id),
   -- As the groups saw it: the writer's name and role when it was sent.
   "authorName" varchar(200) NOT NULL,
   "authorRole" varchar(40) NOT NULL,
   "createdAt" timestamptz NOT NULL DEFAULT now(),
   "takenBackAt" timestamptz,
   "takenBackBy" uuid REFERENCES users(id),
   "takeBackReason" varchar(500),
   CONSTRAINT "CHK_team_announcements_taken_back" CHECK (("takenBackAt" IS NULL) = ("takenBackBy" IS NULL)))`);
  await q.query(`CREATE INDEX "IDX_team_announcements_created" ON team_announcements ("createdAt")`);
  await q.query(`CREATE TABLE team_announcement_deliveries (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   "announcementId" uuid NOT NULL REFERENCES team_announcements(id),
   "teamId" uuid NOT NULL REFERENCES teams(id),
   "groupId" uuid NOT NULL REFERENCES telegram_groups(id),
   status varchar(12) NOT NULL CHECK (status IN ('PENDING','SENDING','SENT','FAILED','SKIPPED','TAKEN_BACK')),
   "messageId" bigint,
   "failureCode" varchar(32),
   attempts integer NOT NULL DEFAULT 0,
   "claimedAt" timestamptz,
   "createdAt" timestamptz NOT NULL DEFAULT now(),
   "sentAt" timestamptz,
   "takenBackAt" timestamptz,
   CONSTRAINT "UQ_team_announcement_deliveries_team" UNIQUE ("announcementId", "teamId"))`);
  await q.query(`CREATE INDEX "IDX_team_announcement_deliveries_pending" ON team_announcement_deliveries ("createdAt") WHERE status IN ('PENDING','SENDING')`);
  await q.query(`CREATE INDEX "IDX_team_announcement_deliveries_team" ON team_announcement_deliveries ("teamId")`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM team_announcements) AS found`);
  if (found.found) throw new Error('Refusing to roll back while team announcements are recorded.');
  await q.query(`DROP TABLE team_announcement_deliveries`);
  await q.query(`DROP TABLE team_announcements`);
 }
}
