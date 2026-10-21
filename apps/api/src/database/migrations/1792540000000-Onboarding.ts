import { MigrationInterface, QueryRunner } from 'typeorm';
export class Onboarding1792540000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
 await q.query(`CREATE TABLE invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "managerId" uuid NOT NULL REFERENCES users(id),
 email varchar(254) NOT NULL CHECK (email = lower(trim(email))), "tokenHash" varchar(64) NOT NULL UNIQUE,
 "mcName" varchar(150) NOT NULL, "teamLead" varchar(150) NOT NULL, "jobTitle" varchar(100) NOT NULL,
 "telegramRequired" boolean NOT NULL DEFAULT false, "createdAt" timestamptz NOT NULL DEFAULT now(),
 "expiresAt" timestamptz NOT NULL, "openedAt" timestamptz, "consumedAt" timestamptz, "revokedAt" timestamptz, "completedAt" timestamptz);
 CREATE INDEX invitations_manager_created ON invitations ("managerId", "createdAt" DESC);
 CREATE TABLE dispatcher_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "invitationId" uuid NOT NULL UNIQUE REFERENCES invitations(id),
 "assignedManagerId" uuid NOT NULL REFERENCES users(id), status varchar NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED','DRAFT','SUBMITTED')),
 fields jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 0,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), "submittedAt" timestamptz,
 CHECK ((status = 'SUBMITTED') = ("submittedAt" IS NOT NULL)));
 CREATE INDEX applications_manager_status ON dispatcher_applications ("assignedManagerId",status);
 CREATE TABLE applicant_challenges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "invitationId" uuid REFERENCES invitations(id),
 resume boolean NOT NULL, "codeHash" varchar(64), "expiresAt" timestamptz NOT NULL, "consumedAt" timestamptz);
 CREATE INDEX challenges_expiry ON applicant_challenges ("expiresAt");
 CREATE TABLE applicant_sessions (LIKE staff_sessions INCLUDING ALL);
 CREATE TABLE application_activity (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "invitationId" uuid NOT NULL REFERENCES invitations(id),
 "actorId" uuid REFERENCES users(id), event varchar(50) NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
 CREATE INDEX activity_invitation ON application_activity ("invitationId", "createdAt");`);
 }
 async down(q: QueryRunner): Promise<void> {
 await q.query('DROP TABLE application_activity, applicant_sessions, applicant_challenges, dispatcher_applications, invitations');
 }
}
