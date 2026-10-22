import type { ApplicationFields, CorrectionField } from './entities';
// Structural validation: 7–15 digits, optional leading +, common international separators.
// Preserve supplied formatting and do not assume a country or invent a work number.
export const INTERNATIONAL_PHONE_PATTERN = /^(?=(?:\D*\d){7,15}\D*$)\+?[\d\s().-]+$/;
export function requiredApplicantFields(fields: ApplicationFields): CorrectionField[] {
 const required: CorrectionField[] = ['firstName','lastName','personalPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName','mcName','teamLead','jobTitle'];
 const missing = required.filter(key => {
  const value = fields[key];
  if (typeof value !== 'string' || !value.trim()) return true;
  if (key === 'personalPhoneNumber') return value.length > 40 || !INTERNATIONAL_PHONE_PATTERN.test(value.trim());
  return value.trim().length > (key === 'mcName' || key === 'teamLead' ? 150 : 100);
 });
 if (fields.workPhoneNumber?.trim() && (fields.workPhoneNumber.length > 40 || !INTERNATIONAL_PHONE_PATTERN.test(fields.workPhoneNumber.trim()))) missing.push('workPhoneNumber');
 return missing;
}
export function provisioningDetails(fields: ApplicationFields) {
 const first = fields.preferredAmericanFirstName?.trim() || null;
 const last = fields.preferredAmericanLastName?.trim() || null;
 return {
  legalFirstName:fields.firstName ?? null,legalLastName:fields.lastName ?? null,
  preferredAmericanFirstName:first,preferredAmericanLastName:last,
  proposedDisplayName:first && last ? `${first} ${last}` : null,
  personalPhoneNumber:fields.personalPhoneNumber ?? null,workPhoneNumber:fields.workPhoneNumber?.trim() || null,
 };
}
