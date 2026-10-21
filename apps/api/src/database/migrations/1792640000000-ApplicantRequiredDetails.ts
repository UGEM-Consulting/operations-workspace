import { MigrationInterface, QueryRunner } from 'typeorm';
export class ApplicantRequiredDetails1792640000000 implements MigrationInterface {
 async up(q: QueryRunner): Promise<void> {
  // Fields live in the existing JSONB entity contract. Preserve original values and keys;
  // missing work phones/names stay missing, including on historical approved records.
  for (const table of ['dispatcher_applications','application_submissions']) {
   await q.query(`UPDATE ${table} SET fields = jsonb_strip_nulls(jsonb_build_object(
    'personalPhoneNumber', fields->'phone',
    'preferredAmericanFirstName', fields->'preferredFirstName',
    'preferredAmericanLastName', fields->'preferredLastName')) || fields`);
  }
  await q.query(`UPDATE application_reviews SET "requestedFields" = (
   SELECT COALESCE(jsonb_agg(CASE value
    WHEN 'phone' THEN 'personalPhoneNumber'
    WHEN 'preferredFirstName' THEN 'preferredAmericanFirstName'
    WHEN 'preferredLastName' THEN 'preferredAmericanLastName'
    ELSE value END ORDER BY position), '[]'::jsonb)
   FROM jsonb_array_elements_text("requestedFields") WITH ORDINALITY AS f(value,position));`);
 }
 async down(q: QueryRunner): Promise<void> {
  // Restore the legacy keys from current values so downgrade preserves edits too.
  // Keep canonical keys/workPhoneNumber in JSONB: rollback must never discard collected data.
  for (const table of ['dispatcher_applications','application_submissions']) {
   await q.query(`UPDATE ${table} SET fields = fields || jsonb_strip_nulls(jsonb_build_object(
    'phone', fields->'personalPhoneNumber',
    'preferredFirstName', fields->'preferredAmericanFirstName',
    'preferredLastName', fields->'preferredAmericanLastName'))`);
  }
  await q.query(`UPDATE application_reviews SET "requestedFields" = (
   SELECT COALESCE(jsonb_agg(CASE value
    WHEN 'personalPhoneNumber' THEN 'phone'
    WHEN 'preferredAmericanFirstName' THEN 'preferredFirstName'
    WHEN 'preferredAmericanLastName' THEN 'preferredLastName'
    ELSE value END ORDER BY position), '[]'::jsonb)
   FROM jsonb_array_elements_text("requestedFields") WITH ORDINALITY AS f(value,position));`);
 }
}
