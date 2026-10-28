import { MigrationInterface, QueryRunner } from 'typeorm';
// Adds the optional EQUIPMENT task and the NOT_NEEDED outcome (allowed only for that task).
// Open requests get a pending Equipment task; completed requests keep their original checklist.
export class OptionalEquipmentTask1792740000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE it_onboarding_tasks DROP CONSTRAINT it_onboarding_tasks_key_check, DROP CONSTRAINT it_onboarding_tasks_status_check`);
  await q.query(`ALTER TABLE it_onboarding_tasks
   ADD CONSTRAINT it_onboarding_tasks_key_check CHECK (key IN ('GOOGLE_WORKSPACE','DISPATCH_GROUP','RINGCENTRAL','SMS','CALL_RECORDING','BUSINESS_SOFTWARE','EQUIPMENT')),
   ADD CONSTRAINT it_onboarding_tasks_status_check CHECK (status IN ('PENDING','IN_PROGRESS','BLOCKED','COMPLETED','NOT_NEEDED')),
   ADD CONSTRAINT it_onboarding_tasks_not_needed_check CHECK (status <> 'NOT_NEEDED' OR key = 'EQUIPMENT')`);
  await q.query(`INSERT INTO it_onboarding_tasks ("requestId",key,status,notes)
   SELECT id,'EQUIPMENT','PENDING','' FROM it_onboarding_requests WHERE "completedAt" IS NULL
   ON CONFLICT ("requestId",key) DO NOTHING`);
 }
 async down(q: QueryRunner): Promise<void> {
  // Only untouched backfilled tasks may be removed; recorded equipment outcomes are never discarded.
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM it_onboarding_tasks WHERE key='EQUIPMENT' AND (status<>'PENDING' OR notes<>'' OR "updatedBy" IS NOT NULL)) AS recorded`);
  if (data.recorded) throw new Error('Cannot discard recorded equipment tasks');
  await q.query(`DELETE FROM it_onboarding_tasks WHERE key='EQUIPMENT'`);
  await q.query(`ALTER TABLE it_onboarding_tasks DROP CONSTRAINT it_onboarding_tasks_not_needed_check,
   DROP CONSTRAINT it_onboarding_tasks_key_check, DROP CONSTRAINT it_onboarding_tasks_status_check`);
  await q.query(`ALTER TABLE it_onboarding_tasks
   ADD CONSTRAINT it_onboarding_tasks_key_check CHECK (key IN ('GOOGLE_WORKSPACE','DISPATCH_GROUP','RINGCENTRAL','SMS','CALL_RECORDING','BUSINESS_SOFTWARE')),
   ADD CONSTRAINT it_onboarding_tasks_status_check CHECK (status IN ('PENDING','IN_PROGRESS','BLOCKED','COMPLETED'))`);
 }
}
