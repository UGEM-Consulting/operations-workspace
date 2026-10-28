import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
// Same structural phone contract as the API: 7–15 digits, optional + and common separators.
const phonePattern = /^(?=(?:\D*\d){7,15}\D*$)\+?[\d\s().-]+$/;
const phone = z.string().trim().max(40).refine(value=>!value || phonePattern.test(value),'Enter a valid phone number with 7–15 digits; international formats are accepted.');
export const applicationDraftSchema = z.object({
 firstName:z.string().trim().max(100),lastName:z.string().trim().max(100),
 personalPhoneNumber:phone,workPhoneNumber:phone,
 preferredAmericanFirstName:z.string().trim().max(100),preferredAmericanLastName:z.string().trim().max(100),
 telegram:z.string().trim().max(100),mcName:z.string().trim().max(150),teamLead:z.string().trim().max(150),jobTitle:z.string().trim().max(100),accurate:z.boolean(),
});
export const applicationDraftResolver = zodResolver(applicationDraftSchema);
export const applicationSubmitSchema = (telegramRequired:boolean) => applicationDraftSchema.extend({
 firstName:z.string().trim().min(1,'Enter your first name.').max(100),lastName:z.string().trim().min(1,'Enter your last name.').max(100),
 personalPhoneNumber:phone.refine(value=>!!value,'Enter your personal phone number.'),workPhoneNumber:phone,
 preferredAmericanFirstName:z.string().trim().min(1,'Enter your American first name.').max(100),preferredAmericanLastName:z.string().trim().min(1,'Enter your American last name.').max(100),
 telegram:telegramRequired?z.string().trim().min(1,'Enter your Telegram username.').max(100):z.string().trim().max(100),
 mcName:z.string().trim().min(1,'Enter your MC name or select Independent.').max(150),teamLead:z.string().trim().min(1,'Enter your team lead or select Independent.').max(150),jobTitle:z.string().trim().min(1,'Enter your job title.').max(100),
 accurate:z.literal(true,{error:'Confirm that your information is accurate.'}),
});
export type ApplicationValues = z.infer<typeof applicationDraftSchema>;

// Used for both resolver errors and the stricter final-submission validation.
export function applicationValidationFeedback(issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
 const personal = ['firstName','lastName','personalPhoneNumber','workPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName','telegram'];
 const stepFor = (name: string) => personal.includes(name) ? 0 : ['mcName','teamLead','jobTitle'].includes(name) ? 1 : 2;
 const first = [...issues].sort((a,b) => stepFor(String(a.path[0])) - stepFor(String(b.path[0])))[0];
 return { step: first ? stepFor(String(first.path[0])) : 2,
  field: first ? String(first.path[0]) as keyof ApplicationValues : undefined,
  message: `Please correct the highlighted fields. ${[...new Set(issues.map(issue => issue.message))].join(' ')}` };
}

export const personalFields = ['firstName','lastName','preferredAmericanFirstName','preferredAmericanLastName','personalPhoneNumber','workPhoneNumber','telegram'] as const;
export const employmentFields = ['mcName','teamLead','jobTitle'] as const;
/**
 * The final-submission rules for one wizard step, used by Continue. Only the listed (editable) fields are checked, so a
 * locked legacy value never blocks a correction; the full schema still runs on submit.
 */
export function stepIssues(values: ApplicationValues, telegramRequired: boolean, fields: readonly (keyof ApplicationValues)[]) {
 const result = applicationSubmitSchema(telegramRequired).safeParse(values);
 return result.success ? [] : result.error.issues.filter(issue => fields.includes(issue.path[0] as keyof ApplicationValues));
}
