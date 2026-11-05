import { MigrationInterface, QueryRunner } from 'typeorm';
// A support or updater for a whole team (designed in the Design System and approved by the user 2026-11-05): they assist one dispatcher, as before, or everyone on one team.
// A link names exactly one. Everyone already recorded keeps their dispatcher, and an older API during an overlapping deploy still writes a dispatcher.
export class WholeTeamSupports1793020000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE member_support_links ALTER COLUMN "dispatcherId" DROP NOT NULL, ADD COLUMN "teamId" uuid NULL REFERENCES teams(id)`);
  await q.query(`ALTER TABLE member_support_links ADD CONSTRAINT "CHK_member_support_links_one" CHECK (("dispatcherId" IS NULL) <> ("teamId" IS NULL))`);
  await q.query(`CREATE INDEX "IDX_member_support_links_team" ON member_support_links ("teamId") WHERE "endedAt" IS NULL AND "teamId" IS NOT NULL`);
  await q.query(`ALTER TABLE invitations ADD COLUMN "supportsTeamId" uuid NULL REFERENCES teams(id)`);
  await q.query(`ALTER TABLE invitations DROP CONSTRAINT "CHK_invitations_support"`);
  await q.query(`ALTER TABLE invitations ADD CONSTRAINT "CHK_invitations_support" CHECK ((position = 'SUPPORT' OR ("supportsMemberId" IS NULL AND "supportsTeamId" IS NULL)) AND ("supportsMemberId" IS NULL OR "supportsTeamId" IS NULL))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_support_links WHERE "teamId" IS NOT NULL) OR EXISTS(SELECT 1 FROM invitations WHERE "supportsTeamId" IS NOT NULL) AS kept`);
  if (data.kept) throw new Error('Cannot discard whole team supports');
  await q.query(`ALTER TABLE invitations DROP CONSTRAINT "CHK_invitations_support"`);
  await q.query(`ALTER TABLE invitations ADD CONSTRAINT "CHK_invitations_support" CHECK (position = 'SUPPORT' OR "supportsMemberId" IS NULL)`);
  await q.query(`ALTER TABLE invitations DROP COLUMN "supportsTeamId"`);
  await q.query(`DROP INDEX "IDX_member_support_links_team"`);
  await q.query(`ALTER TABLE member_support_links DROP CONSTRAINT "CHK_member_support_links_one", DROP COLUMN "teamId", ALTER COLUMN "dispatcherId" SET NOT NULL`);
 }
}
