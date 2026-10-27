import { MigrationInterface, QueryRunner } from 'typeorm';
// Staff two-step verification. Additive: earlier API versions ignore these tables during overlapping deploys.
export class StaffMfa1792720000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE staff_mfa (
      "userId" uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, "secretCiphertext" text NOT NULL,
      "confirmedAt" timestamptz, "lastUsedStep" bigint,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE staff_mfa_recovery_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "codeHash" text NOT NULL, "usedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX staff_mfa_recovery_codes_user ON staff_mfa_recovery_codes ("userId")`);
    await q.query(`CREATE TABLE staff_security_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "actorId" uuid REFERENCES users(id) ON DELETE SET NULL, type varchar(40) NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}', "createdAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX staff_security_events_user ON staff_security_events ("userId", "createdAt")`);
    await q.query(`CREATE TABLE staff_security_settings (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      "mfaRequiredFor" varchar(20) NOT NULL DEFAULT 'ADMINS' CHECK ("mfaRequiredFor" IN ('ADMINS', 'ALL_STAFF')),
      "updatedById" uuid REFERENCES users(id) ON DELETE SET NULL, "updatedAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(`INSERT INTO staff_security_settings (id) VALUES (1)`);
  }
  async down(q: QueryRunner): Promise<void> {
    const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM staff_mfa) OR EXISTS(SELECT 1 FROM staff_mfa_recovery_codes)
      OR EXISTS(SELECT 1 FROM staff_security_events) AS recorded`);
    if (data.recorded) throw new Error('Cannot discard enrolled two-step verification secrets or security events');
    await q.query('DROP TABLE staff_security_settings');
    await q.query('DROP TABLE staff_security_events');
    await q.query('DROP TABLE staff_mfa_recovery_codes');
    await q.query('DROP TABLE staff_mfa');
  }
}
