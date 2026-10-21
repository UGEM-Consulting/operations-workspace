import { MigrationInterface, QueryRunner } from 'typeorm';
export class ItOnboarding1792650000000 implements MigrationInterface {
 async up(q:QueryRunner):Promise<void>{
  await q.query(`CREATE TABLE it_onboarding_requests (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "applicationId" uuid NOT NULL UNIQUE REFERENCES dispatcher_applications(id),
   "approvalId" uuid NOT NULL UNIQUE REFERENCES application_reviews(id), "managerId" uuid NOT NULL REFERENCES users(id),
   profile jsonb NOT NULL, version integer NOT NULL DEFAULT 0, "assignedRingCentralPhoneNumber" varchar(40),
   "workPhoneVerifiedAt" timestamptz, "workPhoneVerifiedBy" uuid REFERENCES users(id),
   "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), "completedAt" timestamptz,
   CHECK (("workPhoneVerifiedAt" IS NULL)=("workPhoneVerifiedBy" IS NULL)),
   CHECK ("completedAt" IS NULL OR ("workPhoneVerifiedAt" IS NOT NULL AND "assignedRingCentralPhoneNumber" IS NOT NULL)));
  CREATE INDEX it_requests_queue ON it_onboarding_requests ("updatedAt" DESC,id);
  CREATE TABLE it_onboarding_tasks (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "requestId" uuid NOT NULL REFERENCES it_onboarding_requests(id),
   key varchar NOT NULL CHECK (key IN ('GOOGLE_WORKSPACE','DISPATCH_GROUP','RINGCENTRAL','SMS','CALL_RECORDING','BUSINESS_SOFTWARE')),
   status varchar NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_PROGRESS','BLOCKED','COMPLETED')),
   notes text NOT NULL DEFAULT '', "updatedBy" uuid REFERENCES users(id), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   UNIQUE ("requestId",key), CHECK (status <> 'BLOCKED' OR length(trim(notes))>0));
  CREATE TABLE it_onboarding_activity (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "requestId" uuid NOT NULL REFERENCES it_onboarding_requests(id),
   "actorId" uuid NOT NULL REFERENCES users(id), event varchar NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', "createdAt" timestamptz NOT NULL DEFAULT now());
  CREATE INDEX it_activity_request ON it_onboarding_activity ("requestId","createdAt");
  CREATE TABLE portal_notifications (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "recipientId" uuid NOT NULL REFERENCES users(id),
   "requestId" uuid NOT NULL REFERENCES it_onboarding_requests(id), kind varchar NOT NULL CHECK (kind='IT_ONBOARDING_COMPLETED'),
   "createdAt" timestamptz NOT NULL DEFAULT now(), "readAt" timestamptz, UNIQUE ("recipientId","requestId",kind));
  CREATE INDEX notifications_recipient ON portal_notifications ("recipientId","createdAt" DESC);`);
 }
 async down(q:QueryRunner):Promise<void>{
  await q.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM it_onboarding_requests)
   THEN RAISE EXCEPTION 'IT onboarding data exists; rollback requires a reviewed recovery plan'; END IF; END $$;
   DROP TABLE portal_notifications,it_onboarding_activity,it_onboarding_tasks,it_onboarding_requests;`);
 }
}
