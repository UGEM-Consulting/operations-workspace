import { MigrationInterface, QueryRunner } from 'typeorm';
export class Identity1792530000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE user_role AS ENUM ('SYSTEM_ADMIN', 'DISPATCHER_MANAGER', 'IT_SPECIALIST')`);
    await q.query(`CREATE TYPE user_status AS ENUM ('ACTIVE', 'INACTIVE')`);
    await q.query(`CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "firstName" varchar(100) NOT NULL, "lastName" varchar(100) NOT NULL,
      email varchar(254) NOT NULL, "passwordHash" text, role user_role NOT NULL, status user_status NOT NULL DEFAULT 'ACTIVE',
      "authVersion" integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(), "lastLoginAt" timestamptz,
      CONSTRAINT users_email_normalized CHECK (email = lower(trim(email)))
    )`);
    await q.query(`CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email))`);
    await q.query(`CREATE TABLE staff_sessions (sid varchar NOT NULL PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL)`);
    await q.query(`CREATE INDEX staff_sessions_expire ON staff_sessions (expire)`);
    await q.query(`CREATE INDEX staff_sessions_user ON staff_sessions ((sess->>'userId'))`);
    await q.query(`CREATE TABLE login_attempts (key varchar(64) PRIMARY KEY, attempts integer NOT NULL, "expiresAt" timestamptz NOT NULL)`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE login_attempts');
    await q.query('DROP TABLE staff_sessions');
    await q.query('DROP TABLE users');
    await q.query('DROP TYPE user_status');
    await q.query('DROP TYPE user_role');
  }
}
