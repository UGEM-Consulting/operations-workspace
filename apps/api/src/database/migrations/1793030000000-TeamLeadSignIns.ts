import { MigrationInterface, QueryRunner } from 'typeorm';
// A team lead's sign-in (designed in the Design System and approved by the user 2026-11-05): choosing a lead asks IT or an
// administrator to create it with the company email; someone who stops leading is asked to be turned off. Anyone leading a
// team with no working sign-in when this ships, or with an account while leading nothing, gets a request now.
export class TeamLeadSignIns1793030000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE team_lead_sign_ins (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "memberId" uuid NOT NULL REFERENCES dispatch_members(id),
   kind varchar NOT NULL CHECK (kind IN ('CREATE','TURN_ON','TURN_OFF')), "createdBy" uuid NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now(),
   "doneAt" timestamptz NULL, "doneBy" uuid NULL REFERENCES users(id), "userId" uuid NULL REFERENCES users(id), "cancelledAt" timestamptz NULL,
   CONSTRAINT "CHK_team_lead_sign_ins_done" CHECK (("doneAt" IS NULL) = ("doneBy" IS NULL) AND NOT ("doneAt" IS NOT NULL AND "cancelledAt" IS NOT NULL)))`);
  await q.query(`CREATE UNIQUE INDEX "UQ_team_lead_sign_ins_open" ON team_lead_sign_ins ("memberId") WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL`);
  await q.query(`INSERT INTO team_lead_sign_ins ("memberId", kind)
   SELECT d.id, CASE WHEN u.id IS NULL THEN 'CREATE' ELSE 'TURN_ON' END FROM dispatch_members d LEFT JOIN users u ON u.id = d."accountUserId"
   WHERE d.status <> 'LEFT' AND (u.id IS NULL OR u.status <> 'ACTIVE') AND EXISTS(SELECT 1 FROM teams t WHERE t."leadMemberId" = d.id AND t."archivedAt" IS NULL)
    AND NOT EXISTS(SELECT 1 FROM member_notices n WHERE n."memberId" = d.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL)
   UNION ALL
   SELECT d.id, 'TURN_OFF' FROM dispatch_members d JOIN users u ON u.id = d."accountUserId" AND u.status = 'ACTIVE'
   WHERE d.status <> 'LEFT' AND NOT EXISTS(SELECT 1 FROM teams t WHERE t."leadMemberId" = d.id AND t."archivedAt" IS NULL)`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM team_lead_sign_ins WHERE "doneAt" IS NOT NULL) AS kept`);
  if (data.kept) throw new Error('Cannot discard team lead sign-ins that IT already handled');
  await q.query(`DROP TABLE team_lead_sign_ins`);
 }
}
