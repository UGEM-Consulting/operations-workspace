import { MigrationInterface, QueryRunner } from 'typeorm';
// Documents in a modal (designed in the Design System and approved by the user 2026-11-03). A published version can name
// where its signing fields go, as fractions of each page, so signed copies show the form filled in; a version with none
// signs as before, with a certificate page only. Each version stays immutable: the fields are set when it is published.
// A countersigner's job title goes in a form's Title field. A document only read, like the contact list, takes one button
// with no e-sign consent, so a signer's consent is required only where there's a signature.
export class DocumentFields1792970000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`ALTER TABLE company_documents ADD COLUMN fields jsonb NOT NULL DEFAULT '[]'`);
  await q.query(`ALTER TABLE driver_consent_documents ADD COLUMN fields jsonb NOT NULL DEFAULT '[]'`);
  await q.query(`ALTER TABLE document_signatures ADD COLUMN "signerTitle" varchar(100) NULL`);
  await q.query(`ALTER TABLE document_signatures DROP CONSTRAINT document_signatures_check1, ADD CONSTRAINT document_signatures_consent_check CHECK ("signerRole" = 'COMPANY' OR consent IS NOT NULL OR "signatureImage" IS NULL)`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS (SELECT 1 FROM company_documents WHERE fields <> '[]') OR EXISTS (SELECT 1 FROM driver_consent_documents WHERE fields <> '[]')
   OR EXISTS (SELECT 1 FROM document_signatures WHERE "signerTitle" IS NOT NULL OR ("signerRole" = 'APPLICANT' AND consent IS NULL)) AS kept`);
  if (data.kept) throw new Error('Cannot discard placed signing fields, countersigners’ titles or one-button reads');
  await q.query(`ALTER TABLE document_signatures DROP CONSTRAINT document_signatures_consent_check, ADD CONSTRAINT document_signatures_check1 CHECK ("signerRole" = 'COMPANY' OR consent IS NOT NULL)`);
  await q.query(`ALTER TABLE document_signatures DROP COLUMN "signerTitle"`);
  await q.query(`ALTER TABLE driver_consent_documents DROP COLUMN fields`);
  await q.query(`ALTER TABLE company_documents DROP COLUMN fields`);
 }
}
