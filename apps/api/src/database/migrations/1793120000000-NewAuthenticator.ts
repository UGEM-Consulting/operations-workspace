import { MigrationInterface, QueryRunner } from 'typeorm';
// Setting up a new authenticator while two-step verification is on (designed as the New authenticator group, approved
// 2026-11-09): the new secret waits here, sealed like the current one, until its first code is confirmed, so the old
// authenticator keeps working until then. Additive: an older API never reads these columns.
export class NewAuthenticator1793120000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE staff_mfa ADD COLUMN "pendingSecretCiphertext" text NULL, ADD COLUMN "pendingCreatedAt" timestamptz NULL,
   ADD CONSTRAINT "CHK_staff_mfa_pending" CHECK (("pendingSecretCiphertext" IS NULL) = ("pendingCreatedAt" IS NULL))`);
 }
 async down(q: QueryRunner): Promise<void> {
  // A pending replacement is only half done: dropping it leaves the current authenticator, as if it was never started.
  await q.query(`ALTER TABLE staff_mfa DROP CONSTRAINT "CHK_staff_mfa_pending", DROP COLUMN "pendingCreatedAt", DROP COLUMN "pendingSecretCiphertext"`);
 }
}
