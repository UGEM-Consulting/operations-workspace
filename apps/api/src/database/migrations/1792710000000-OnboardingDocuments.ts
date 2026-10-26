import { MigrationInterface, QueryRunner } from 'typeorm';
// Company documents (NDA, SOP, contact list), applicant photos and append-only signature evidence.
// File contents live in private storage; only metadata, hashes and signature images are in PostgreSQL.
export class OnboardingDocuments1792710000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE company_documents (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind varchar NOT NULL CHECK (kind IN ('NDA','SOP','CONTACT_LIST')),
   version integer NOT NULL CHECK (version > 0), title varchar(200) NOT NULL CHECK (btrim(title) <> ''),
   sha256 char(64) NOT NULL, "byteSize" integer NOT NULL CHECK ("byteSize" > 0), "pageCount" integer NOT NULL CHECK ("pageCount" > 0),
   "uploadedBy" uuid NOT NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE (kind, version));
  CREATE TABLE applicant_photos (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "applicationId" uuid NOT NULL REFERENCES dispatcher_applications(id),
   kind varchar NOT NULL CHECK (kind IN ('SELFIE','ID_SELFIE')), sha256 char(64) NOT NULL, "byteSize" integer NOT NULL CHECK ("byteSize" > 0),
   "createdAt" timestamptz NOT NULL DEFAULT now(), "replacedAt" timestamptz);
  CREATE UNIQUE INDEX applicant_photos_current ON applicant_photos ("applicationId", kind) WHERE "replacedAt" IS NULL;
  CREATE TABLE document_signatures (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "applicationId" uuid NOT NULL REFERENCES dispatcher_applications(id),
   "documentId" uuid NOT NULL REFERENCES company_documents(id), "signerRole" varchar NOT NULL CHECK ("signerRole" IN ('APPLICANT','COMPANY')),
   "signerUserId" uuid REFERENCES users(id), "typedName" varchar(200) NOT NULL CHECK (btrim("typedName") <> ''), "signatureImage" bytea,
   consent text, statement text NOT NULL, "translatedStatement" text, "documentSha256" char(64) NOT NULL,
   "ipAddress" varchar(64), "userAgent" varchar(500), "signedAt" timestamptz NOT NULL DEFAULT now(),
   UNIQUE ("applicationId", "documentId", "signerRole"),
   CHECK (("signerRole" = 'COMPANY') = ("signerUserId" IS NOT NULL)), CHECK ("signerRole" = 'COMPANY' OR consent IS NOT NULL));
  CREATE TABLE document_views (
   "applicationId" uuid NOT NULL REFERENCES dispatcher_applications(id), "documentId" uuid NOT NULL REFERENCES company_documents(id),
   "firstViewedAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("applicationId", "documentId"));
  CREATE FUNCTION refuse_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME; END $$;
  CREATE TRIGGER company_documents_append_only BEFORE UPDATE OR DELETE ON company_documents FOR EACH ROW EXECUTE FUNCTION refuse_evidence_change();
  CREATE TRIGGER document_signatures_append_only BEFORE UPDATE OR DELETE ON document_signatures FOR EACH ROW EXECUTE FUNCTION refuse_evidence_change();`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM company_documents) OR EXISTS(SELECT 1 FROM applicant_photos) AS recorded`);
  if (data.recorded) throw new Error('Cannot discard company documents, applicant photos or signatures');
  await q.query(`DROP TABLE document_views; DROP TABLE document_signatures; DROP TABLE applicant_photos; DROP TABLE company_documents; DROP FUNCTION refuse_evidence_change()`);
 }
}
