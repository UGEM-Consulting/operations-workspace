import { MigrationInterface, QueryRunner } from 'typeorm';
// Email codes as a second two-step verification method. Additive: existing authenticator enrolments keep method TOTP
// and an older API keeps inserting TOTP rows with a secret during overlapping deploys.
export class EmailMfa1792790000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE staff_mfa ADD COLUMN method varchar(10) NOT NULL DEFAULT 'TOTP' CHECK (method IN ('TOTP', 'EMAIL'))`);
    await q.query(`ALTER TABLE staff_mfa ALTER COLUMN "secretCiphertext" DROP NOT NULL`);
    await q.query(`ALTER TABLE staff_mfa ADD CONSTRAINT staff_mfa_totp_secret CHECK (method <> 'TOTP' OR "secretCiphertext" IS NOT NULL)`);
    // At most one outstanding code per user and purpose; a new code replaces the previous one. Codes are hashed.
    await q.query(`CREATE TABLE staff_mfa_email_codes (
      "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose varchar(10) NOT NULL CHECK (purpose IN ('login', 'enrol', 'manage')),
      "codeHash" text NOT NULL, "sentAt" timestamptz NOT NULL DEFAULT now(), "expiresAt" timestamptz NOT NULL, "usedAt" timestamptz,
      PRIMARY KEY ("userId", purpose))`);
  }
  async down(q: QueryRunner): Promise<void> {
    const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM staff_mfa WHERE method = 'EMAIL') AS recorded`);
    if (data.recorded) throw new Error('Cannot discard email two-step verification enrolments');
    await q.query('DROP TABLE staff_mfa_email_codes');
    await q.query('ALTER TABLE staff_mfa DROP CONSTRAINT staff_mfa_totp_secret');
    await q.query(`ALTER TABLE staff_mfa ALTER COLUMN "secretCiphertext" SET NOT NULL`);
    await q.query('ALTER TABLE staff_mfa DROP COLUMN method');
  }
}
