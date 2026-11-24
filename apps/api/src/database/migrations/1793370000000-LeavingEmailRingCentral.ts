import { MigrationInterface, QueryRunner } from 'typeorm';
// Leaving: the company email and RingCentral user, and the position at another company (Design System section 40, approved
// 2026-11-23). The manager chooses what happens to the company email (emailAction: archive, suspend or delete; SUSPEND is
// what every earlier row meant, and what an older API writes during an overlapping deploy), IT records what it did
// (emailDone), and RingCentral users are disabled with SMS and call recording turned off (ringCentralOff) instead of
// recording what happens to the number. The completion CHECK accepts either, so removals finished before stay valid.
// An account at another company may say what the person was there. The rollback refuses while any of this is recorded.
const OFF = `ARRAY['USER','SMS','INBOUND_RECORDING','OUTBOUND_RECORDING']::text[]`;
export class LeavingEmailRingCentral1793370000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  for (const table of ['it_removal_requests', 'it_account_requests']) {
   await q.query(`ALTER TABLE ${table} ADD COLUMN "emailAction" varchar(10) NOT NULL DEFAULT 'SUSPEND' CHECK ("emailAction" IN ('ARCHIVE','SUSPEND','DELETE')),
    ADD COLUMN "emailDone" varchar(10) CHECK ("emailDone" IN ('ARCHIVED','SUSPENDED','DELETED'))`);
  }
  await q.query(`ALTER TABLE it_removal_requests ADD COLUMN "ringCentralOff" text[] NOT NULL DEFAULT '{}' CHECK ("ringCentralOff" <@ ${OFF})`);
  // Finishing needs what happens to the number (before) or all four turned off (now), unless the number was handed over.
  await q.query(`ALTER TABLE it_removal_requests DROP CONSTRAINT it_removal_number_check, ADD CONSTRAINT it_removal_number_check CHECK ("completedAt" IS NULL OR profile->>'ringCentralNumber' IS NULL
   OR "numberOutcome" IS NOT NULL OR "ringCentralOff" @> ${OFF} OR profile->'shared'->>'handOverToId' IS NOT NULL) NOT VALID`);
  await q.query(`ALTER TABLE member_company_accounts ADD COLUMN position varchar(10) CHECK (position IN ('DISPATCHER','SUPPORT','UPDATER'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT
   EXISTS(SELECT 1 FROM it_removal_requests WHERE "emailAction" <> 'SUSPEND' OR "emailDone" IS NOT NULL OR cardinality("ringCentralOff") > 0) OR
   EXISTS(SELECT 1 FROM it_account_requests WHERE "emailAction" <> 'SUSPEND' OR "emailDone" IS NOT NULL) OR
   EXISTS(SELECT 1 FROM member_company_accounts WHERE position IS NOT NULL) AS found`);
  if (found.found) throw new Error('Refusing to roll back while email choices, RingCentral steps or positions at other companies are recorded.');
  await q.query(`ALTER TABLE member_company_accounts DROP COLUMN position`);
  await q.query(`ALTER TABLE it_removal_requests DROP CONSTRAINT it_removal_number_check, ADD CONSTRAINT it_removal_number_check CHECK ("completedAt" IS NULL OR "numberOutcome" IS NOT NULL OR profile->>'ringCentralNumber' IS NULL) NOT VALID`);
  await q.query(`ALTER TABLE it_removal_requests DROP COLUMN "ringCentralOff"`);
  for (const table of ['it_account_requests', 'it_removal_requests']) await q.query(`ALTER TABLE ${table} DROP COLUMN "emailDone", DROP COLUMN "emailAction"`);
 }
}
