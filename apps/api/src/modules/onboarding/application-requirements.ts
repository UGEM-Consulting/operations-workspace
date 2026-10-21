import type { ApplicationFields, CorrectionField } from './entities';
// Structural validation: 7–15 digits, optional leading +, common international separators.
// Preserve supplied formatting and do not assume a country or invent a work number.
export const INTERNATIONAL_PHONE_PATTERN = /^(?=(?:\D*\d){7,15}\D*$)\+?[\d\s().-]+$/;
export function requiredApplicantFields(fields: ApplicationFields): CorrectionField[] {
 const required: CorrectionField[] = ['firstName','lastName','personalPhoneNumber','workPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName','mcName','teamLead','jobTitle'];
 return required.filter(key => {
  const value = fields[key];
  if (typeof value !== 'string' || !value.trim()) return true;
  if (key === 'personalPhoneNumber' || key === 'workPhoneNumber') return value.length > 40 || !INTERNATIONAL_PHONE_PATTERN.test(value.trim());
  return value.trim().length > (key === 'mcName' || key === 'teamLead' ? 150 : 100);
 });
}
export function provisioningDetails(fields: ApplicationFields) {
 const first = fields.preferredAmericanFirstName?.trim() || null;
 const last = fields.preferredAmericanLastName?.trim() || null;
 return {
  legalFirstName:fields.firstName ?? null,legalLastName:fields.lastName ?? null,
  preferredAmericanFirstName:first,preferredAmericanLastName:last,
  proposedDisplayName:first && last ? `${first} ${last}` : null,
  personalPhoneNumber:fields.personalPhoneNumber ?? null,workPhoneNumber:fields.workPhoneNumber ?? null,
 };
}
