import { MigrationInterface, QueryRunner } from 'typeorm';
// Forced password change after an administrator sets a password. Additive with a false default: earlier API versions
// ignore the column during overlapping deploys and keep creating users that need no change. Account-administration
// and password-change audit events reuse staff_security_events (type is varchar without a CHECK).
export class StaffPasswordChange1792760000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE users ADD COLUMN "mustChangePassword" boolean NOT NULL DEFAULT false`);
  }
  async down(q: QueryRunner): Promise<void> {
    // Dropping the flag would silently let administrator-chosen passwords stay in use.
    const [pending] = await q.query(`SELECT EXISTS(SELECT 1 FROM users WHERE "mustChangePassword") AS pending`);
    if (pending.pending) throw new Error('Cannot discard pending forced password changes');
    await q.query(`ALTER TABLE users DROP COLUMN "mustChangePassword"`);
  }
}
