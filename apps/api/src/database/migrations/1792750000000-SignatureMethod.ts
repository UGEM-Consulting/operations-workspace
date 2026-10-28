import { MigrationInterface, QueryRunner } from 'typeorm';
// Records how a signature image was made: DRAWN, or TYPED (adopted from the typed name). Existing rows stay NULL,
// meaning drawn. Adding a column does not touch existing rows, so the append-only trigger is unaffected.
export class SignatureMethod1792750000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE document_signatures ADD COLUMN "signatureMethod" varchar CHECK ("signatureMethod" IN ('DRAWN','TYPED'))`);
 }
 async down(q: QueryRunner): Promise<void> {
  // Dropping the column would erase how typed signatures were made; drawn and older rows lose nothing.
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM document_signatures WHERE "signatureMethod" = 'TYPED') AS recorded`);
  if (data.recorded) throw new Error('Cannot discard typed signature records');
  await q.query(`ALTER TABLE document_signatures DROP COLUMN "signatureMethod"`);
 }
}
