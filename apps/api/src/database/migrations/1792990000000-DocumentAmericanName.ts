import { MigrationInterface, QueryRunner } from 'typeorm';
// American name on company documents (designed in the Design System and approved by the user 2026-11-04). A version may mark where the
// signer's American name goes. It is kept on the signature row when they sign, so a later change to their application never changes a
// signed copy. Fields are stored as JSON on the version, so the new kind needs no change there.
export class DocumentAmericanName1792990000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE document_signatures ADD COLUMN "signerAmericanName" varchar(201) NULL`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM document_signatures WHERE "signerAmericanName" IS NOT NULL)
   OR EXISTS(SELECT 1 FROM company_documents d CROSS JOIN LATERAL jsonb_array_elements(d.fields::jsonb) f WHERE f->>'kind' = 'AMERICAN_NAME') AS kept`);
  if (data.kept) throw new Error('Cannot discard American names on documents');
  await q.query(`ALTER TABLE document_signatures DROP COLUMN "signerAmericanName"`);
 }
}
