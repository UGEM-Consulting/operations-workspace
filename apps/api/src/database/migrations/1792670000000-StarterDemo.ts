import { MigrationInterface, QueryRunner } from 'typeorm';
export class StarterDemo1792670000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE deployment_identity ADD COLUMN mode varchar NOT NULL DEFAULT 'isolated' CHECK (mode IN ('isolated','starter')),
      ADD COLUMN "operatorAdminId" uuid,
      ADD CONSTRAINT demo_operator_check CHECK ((mode='starter')=("operatorAdminId" IS NOT NULL) AND (mode<>'starter' OR purpose='demo'));
      CREATE TABLE deployment_activity (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event varchar NOT NULL CHECK(event='STARTER_DEMO_CONVERTED'),
        "deploymentId" uuid NOT NULL, "operatorAdminId" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE OR REPLACE FUNCTION protect_demo_emails() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM deployment_identity WHERE purpose='demo') THEN
          IF TG_TABLE_NAME='users' AND TG_OP='UPDATE' THEN
            IF EXISTS (SELECT 1 FROM deployment_identity WHERE purpose='demo' AND mode='starter' AND "operatorAdminId"=NEW.id)
              AND NEW.email=OLD.email AND NEW.role='SYSTEM_ADMIN' AND NEW.status='ACTIVE' THEN RETURN NEW; END IF;
          END IF;
          IF NEW.email IS NOT NULL AND NEW.email !~ '^[^@]+@example\\.test$' THEN RAISE EXCEPTION 'Demo database accepts fictional addresses only'; END IF;
          IF TG_TABLE_NAME='invitations' THEN
            IF NEW."expectedEmail" IS NOT NULL AND NEW."expectedEmail" !~ '^[^@]+@example\\.test$' THEN RAISE EXCEPTION 'Demo database accepts fictional addresses only'; END IF;
          END IF;
        END IF;
        RETURN NEW;
      END $$;`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM deployment_identity WHERE purpose='demo') OR EXISTS (SELECT 1 FROM deployment_activity)
      THEN RAISE EXCEPTION 'Demo identity or conversion audit exists; rollback requires a reviewed recovery plan'; END IF; END $$;
      CREATE OR REPLACE FUNCTION protect_demo_emails() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM deployment_identity WHERE purpose='demo') THEN
          IF NEW.email IS NOT NULL AND NEW.email !~ '^[^@]+@example\\.test$' THEN RAISE EXCEPTION 'Demo database accepts fictional addresses only'; END IF;
          IF TG_TABLE_NAME='invitations' THEN
            IF NEW."expectedEmail" IS NOT NULL AND NEW."expectedEmail" !~ '^[^@]+@example\\.test$' THEN RAISE EXCEPTION 'Demo database accepts fictional addresses only'; END IF;
          END IF;
        END IF; RETURN NEW;
      END $$;
      DROP TABLE deployment_activity;
      ALTER TABLE deployment_identity DROP CONSTRAINT demo_operator_check, DROP COLUMN mode, DROP COLUMN "operatorAdminId";`);
  }
}
