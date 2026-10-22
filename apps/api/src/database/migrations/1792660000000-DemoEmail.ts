import { MigrationInterface, QueryRunner } from 'typeorm';
export class DemoEmail1792660000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE deployment_identity (
      id boolean PRIMARY KEY DEFAULT true CHECK (id), purpose varchar NOT NULL CHECK (purpose IN ('production','unassigned','demo')),
      "deploymentId" uuid, "webOrigin" text, "initializedAt" timestamptz);
      INSERT INTO deployment_identity (id,purpose) SELECT true, CASE
        WHEN current_database() ~ '_demo(_test)?$' AND NOT EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM invitations)
        THEN 'unassigned' ELSE 'production' END;
      CREATE TABLE demo_mailbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "challengeId" uuid NOT NULL UNIQUE REFERENCES applicant_challenges(id) ON DELETE CASCADE,
        ciphertext text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE FUNCTION protect_demo_emails() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM deployment_identity WHERE purpose='demo') THEN
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
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM demo_mailbox) OR EXISTS (SELECT 1 FROM deployment_identity WHERE purpose='demo')
      THEN RAISE EXCEPTION 'Demo identity or mailbox data exists; rollback requires a reviewed recovery plan'; END IF; END $$;
      DROP TRIGGER demo_users_email ON users; DROP TRIGGER demo_invitations_email ON invitations; DROP TRIGGER demo_challenges_email ON applicant_challenges;
      DROP FUNCTION protect_demo_emails(); DROP TABLE demo_mailbox, deployment_identity;`);
  }
}
