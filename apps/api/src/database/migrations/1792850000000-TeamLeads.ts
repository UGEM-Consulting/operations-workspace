import { MigrationInterface, QueryRunner } from 'typeorm';
// Team leads sign in (role TEAM_LEAD) linked to their dispatcher record (dispatch_members.accountUserId, one account per
// dispatcher; the link points from the record to the account so clearing workflow data never cascades into accounts);
// what they see follows the team that dispatcher leads. They ask for a support in their team to become a dispatcher
// (promotion_requests); a dispatcher manager or administrator approves or declines. The role/link rule lives in the
// service: PostgreSQL cannot use an enum value added in the same transaction, so no CHECK names it here.
export class TeamLeads1792850000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'TEAM_LEAD'`);
  await q.query(`ALTER TABLE dispatch_members ADD COLUMN "accountUserId" uuid NULL REFERENCES users(id) ON DELETE SET NULL`);
  await q.query(`CREATE UNIQUE INDEX "UQ_dispatch_members_accountUserId" ON dispatch_members ("accountUserId") WHERE "accountUserId" IS NOT NULL`);
  await q.query(`CREATE TABLE promotion_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "supportId" uuid NOT NULL REFERENCES dispatch_members(id),
   "requestedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, reason varchar(1000) NOT NULL,
   status varchar NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','DECLINED','CANCELLED')),
   "decidedBy" uuid NULL REFERENCES users(id) ON DELETE SET NULL, "decidedAt" timestamptz NULL, note varchar(1000) NULL,
   "itRequestId" uuid NULL REFERENCES it_onboarding_requests(id), version integer NOT NULL DEFAULT 1,
   "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
   CHECK ((status = 'PENDING') = ("decidedAt" IS NULL)), CHECK (status <> 'DECLINED' OR note IS NOT NULL))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_promotion_requests_open" ON promotion_requests ("supportId") WHERE status = 'PENDING'`);
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT "dispatch_events_event_check"`);
  await q.query(`ALTER TABLE dispatch_events ADD CONSTRAINT "dispatch_events_event_check" CHECK (event IN ('MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED',
   'TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED',
   'PROMOTION_REQUESTED','PROMOTION_APPROVED','PROMOTION_DECLINED','PROMOTION_CANCELLED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM users WHERE role::text = 'TEAM_LEAD') OR EXISTS(SELECT 1 FROM dispatch_members WHERE "accountUserId" IS NOT NULL) AS leads,
   EXISTS(SELECT 1 FROM promotion_requests) AS requests, EXISTS(SELECT 1 FROM dispatch_events WHERE event LIKE 'PROMOTION_%') AS events`);
  if (data.leads || data.requests || data.events) throw new Error('Cannot discard team lead accounts or promotion requests');
  await q.query(`ALTER TABLE dispatch_events DROP CONSTRAINT "dispatch_events_event_check"`);
  await q.query(`ALTER TABLE dispatch_events ADD CONSTRAINT "dispatch_events_event_check" CHECK (event IN ('MEMBER_MOVED','MEMBER_LEFT','MEMBER_UPDATED',
   'TEAM_CREATED','TEAM_UPDATED','TEAM_ARCHIVED','TEAM_RESTORED','CONTACT_ADDED','CONTACT_REMOVED','SUPPORT_REASSIGNED'))`);
  await q.query(`DROP TABLE promotion_requests`);
  await q.query(`ALTER TABLE dispatch_members DROP COLUMN "accountUserId"`);
  // The TEAM_LEAD enum value stays: PostgreSQL cannot drop one, and an unused value is harmless to the previous version.
 }
}
