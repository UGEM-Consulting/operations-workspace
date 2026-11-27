import { MigrationInterface, QueryRunner } from 'typeorm';
// Section 45 (approved by the user 2026-11-27): a dispatcher's American name changes through Change name, or with a move, rehire
// or a support's change of who they assist. Each change is a member_detail_corrections row; kind says whether it was a new name
// (NEW_NAME, the old one kept as an other name) or a fixed mistake (NAME_FIX), and context what it came with. Both stay null
// on an older correction, as an older API writes them. The rollback refuses while any name change is recorded.
export class NameChanges1793410000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE member_detail_corrections ADD COLUMN kind varchar(10) NULL, ADD COLUMN context varchar(10) NULL,
   ADD CONSTRAINT "CHK_member_detail_corrections_kind" CHECK (kind IS NULL OR kind IN ('NEW_NAME', 'NAME_FIX')),
   ADD CONSTRAINT "CHK_member_detail_corrections_context" CHECK (context IS NULL OR (kind IS NOT NULL AND context IN ('MOVE', 'REHIRE', 'REASSIGN')))`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [found] = await q.query(`SELECT EXISTS(SELECT 1 FROM member_detail_corrections WHERE kind IS NOT NULL) AS found`);
  if (found.found) throw new Error('Refusing to roll back while name changes are recorded.');
  await q.query(`ALTER TABLE member_detail_corrections DROP CONSTRAINT "CHK_member_detail_corrections_context", DROP CONSTRAINT "CHK_member_detail_corrections_kind", DROP COLUMN context, DROP COLUMN kind`);
 }
}
