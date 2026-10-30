import { MigrationInterface, QueryRunner } from 'typeorm';
// A team lead must be an active dispatcher. DispatcherContacts1792830000000 moved backfilled members whose IT request was
// still open back to ONBOARDING without clearing them as team leads, so this clears any lead that isn't ACTIVE (and bumps
// the team's version so open edit forms reload). An automatic data fix: no dispatch events, like the backfill itself.
export class ClearInactiveTeamLeads1792890000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`UPDATE teams t SET "leadMemberId" = NULL, version = t.version + 1, "updatedAt" = now()
   FROM dispatch_members d WHERE d.id = t."leadMemberId" AND d.status <> 'ACTIVE'`);
 }
 async down(): Promise<void> {
  // Nothing to restore: the cleared leads broke the team lead rule, and which teams they led isn't kept.
 }
}
