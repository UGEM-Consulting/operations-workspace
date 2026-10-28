import { MigrationInterface, QueryRunner } from 'typeorm';
// A manager's or administrator's saved signature for NDA countersigning, and a flag recording that a countersignature
// was applied from it. Each signing still copies the image into its own document_signatures row, so replacing or
// deleting a saved signature never changes a signed document. Adding a defaulted column leaves existing rows untouched.
export class SavedStaffSignatures1792780000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  await q.query(`CREATE TABLE staff_saved_signatures ("userId" uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
   "typedName" varchar(100) NOT NULL, "signatureImage" bytea NOT NULL,
   "signatureMethod" varchar NOT NULL CHECK ("signatureMethod" IN ('DRAWN','TYPED')),
   "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`);
  await q.query(`ALTER TABLE document_signatures ADD COLUMN "fromSavedSignature" boolean NOT NULL DEFAULT false`);
 }
 async down(q: QueryRunner): Promise<void> {
  const [data] = await q.query(`SELECT EXISTS(SELECT 1 FROM staff_saved_signatures) AS saved,
   EXISTS(SELECT 1 FROM document_signatures WHERE "fromSavedSignature") AS applied`);
  if (data.saved) throw new Error('Cannot discard saved staff signatures');
  if (data.applied) throw new Error('Cannot discard records of countersignatures applied from a saved signature');
  await q.query(`ALTER TABLE document_signatures DROP COLUMN "fromSavedSignature"`);
  await q.query(`DROP TABLE staff_saved_signatures`);
 }
}
