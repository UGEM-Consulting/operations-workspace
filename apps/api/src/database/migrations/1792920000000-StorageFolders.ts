import { MigrationInterface, QueryRunner } from 'typeorm';
// Storage folders (user request, 2026-10-30): new files go under one folder per person (applicants/<application>/...,
// drivers/<driver>/...) and blank company forms under company-documents/<group>/<kind>/. Each file record says which layout
// its file uses. The column defaults to 1 (the original flat layout), so existing files and any row an older API writes
// during an overlapping deploy keep naming the path they were stored under; only this version writes 2.
// signed_copies records the signed copies saved into each person's signed/ folder once a signature set is complete.
const FILE_TABLES = ['applicant_photos', 'company_documents', 'driver_documents', 'driver_reports', 'driver_consent_documents'];
export class StorageFolders1792920000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  for (const table of FILE_TABLES) await q.query(`ALTER TABLE ${table} ADD "storageLayout" smallint NOT NULL DEFAULT 1 CHECK ("storageLayout" IN (1, 2))`);
  // One row per saved copy: either an applicant's company document or a driver's consent form. No cascades, like the
  // signatures they copy (append-only evidence).
  await q.query(`CREATE TABLE signed_copies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "storageKey" varchar(300) NOT NULL UNIQUE,
   "applicationId" uuid NULL REFERENCES dispatcher_applications(id), "companyDocumentId" uuid NULL REFERENCES company_documents(id),
   "driverId" uuid NULL REFERENCES drivers(id), "consentDocumentId" uuid NULL REFERENCES driver_consent_documents(id),
   sha256 char(64) NOT NULL, "byteSize" integer NOT NULL CHECK ("byteSize" > 0), "createdAt" timestamptz NOT NULL DEFAULT now(),
   CHECK (("applicationId" IS NOT NULL AND "companyDocumentId" IS NOT NULL AND "driverId" IS NULL AND "consentDocumentId" IS NULL)
    OR ("applicationId" IS NULL AND "companyDocumentId" IS NULL AND "driverId" IS NOT NULL AND "consentDocumentId" IS NOT NULL)),
   UNIQUE ("applicationId", "companyDocumentId"), UNIQUE ("driverId", "consentDocumentId"))`);
  // refuse_evidence_change() comes from OnboardingDocuments1792710000000.
  await q.query(`CREATE TRIGGER signed_copies_append_only BEFORE UPDATE OR DELETE ON signed_copies FOR EACH ROW EXECUTE FUNCTION refuse_evidence_change()`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM signed_copies)
   ${FILE_TABLES.map(table => `OR EXISTS(SELECT 1 FROM ${table} WHERE "storageLayout" = 2)`).join(' ')} AS kept`);
  if (data.kept) throw new Error('Cannot discard files stored in the per-person folders or saved signed copies');
  await q.query(`DROP TABLE signed_copies`);
  for (const table of FILE_TABLES) await q.query(`ALTER TABLE ${table} DROP COLUMN "storageLayout"`);
 }
}
