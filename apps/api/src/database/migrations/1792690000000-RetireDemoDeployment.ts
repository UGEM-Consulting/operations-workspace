import { MigrationInterface, QueryRunner } from 'typeorm';
// Removes the fictional demo simulator schema (mailbox, deployment binding, fictional-email triggers).
// It refuses the database bound to the demo deployment, so production code can never start against it:
// production must use a fresh database. Earlier migrations stay unchanged for history and rollback.
export class RetireDemoDeployment1792690000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM deployment_identity WHERE purpose='demo')
      THEN RAISE EXCEPTION 'This database belongs to the retired fictional demo deployment; use a fresh production database'; END IF; END $$;
      DROP TRIGGER demo_users_email ON users; DROP TRIGGER demo_invitations_email ON invitations; DROP TRIGGER demo_challenges_email ON applicant_challenges;
      DROP FUNCTION protect_demo_emails();
      DROP TABLE demo_mailbox, deployment_activity, deployment_identity;`);
  }
  async down(q: QueryRunner): Promise<void> {
    // Restores the StarterDemo schema state for a non-demo database (the only kind up() accepts).
    await q.query(`CREATE TABLE deployment_identity (
      id boolean PRIMARY KEY DEFAULT true CHECK (id), purpose varchar NOT NULL CHECK (purpose IN ('production','unassigned','demo')),
      "deploymentId" uuid, "webOrigin" text, "initializedAt" timestamptz,
      mode varchar NOT NULL DEFAULT 'isolated' CHECK (mode IN ('isolated','starter')), "operatorAdminId" uuid,
      CONSTRAINT demo_operator_check CHECK ((mode='starter')=("operatorAdminId" IS NOT NULL) AND (mode<>'starter' OR purpose='demo')));
      INSERT INTO deployment_identity (id,purpose) VALUES (true,'production');
      CREATE TABLE demo_mailbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "challengeId" uuid NOT NULL UNIQUE REFERENCES applicant_challenges(id) ON DELETE CASCADE,
        ciphertext text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE deployment_activity (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event varchar NOT NULL CHECK(event='STARTER_DEMO_CONVERTED'),
        "deploymentId" uuid NOT NULL, "operatorAdminId" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE FUNCTION protect_demo_emails() RETURNS trigger LANGUAGE plpgsql AS $$
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
      END $$;
      CREATE TRIGGER demo_users_email BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_demo_emails();
      CREATE TRIGGER demo_invitations_email BEFORE INSERT OR UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION protect_demo_emails();
      CREATE TRIGGER demo_challenges_email BEFORE INSERT OR UPDATE ON applicant_challenges FOR EACH ROW EXECUTE FUNCTION protect_demo_emails();`);
  }
}
