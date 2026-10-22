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
 firstName:z.string().trim().min(1,'First Name is required').max(100),lastName:z.string().trim().min(1,'Last Name is required').max(100),
 personalPhoneNumber:phone.refine(value=>!!value,'Personal Phone Number is required'),workPhoneNumber:phone.refine(value=>!!value,'Work Phone Number is required'),
 preferredAmericanFirstName:z.string().trim().min(1,'American First Name is required').max(100),preferredAmericanLastName:z.string().trim().min(1,'American Last Name is required').max(100),
 telegram:telegramRequired?z.string().trim().min(1,'Telegram is required').max(100):z.string().trim().max(100),
 mcName:z.string().trim().min(1,'MC name or Independent is required').max(150),teamLead:z.string().trim().min(1,'Team lead or Independent is required').max(150),jobTitle:z.string().trim().min(1,'Job title is required').max(100),
 accurate:z.literal(true,{error:'Confirm your information is accurate'}),
});
export type ApplicationValues = z.infer<typeof applicationDraftSchema>;

// Used for both resolver errors and the stricter final-submission validation.
export function applicationValidationFeedback(issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
 const personal = ['firstName','lastName','personalPhoneNumber','workPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName','telegram'];
 const stepFor = (name: string) => personal.includes(name) ? 0 : ['mcName','teamLead','jobTitle'].includes(name) ? 1 : 3;
 const first = [...issues].sort((a,b) => stepFor(String(a.path[0])) - stepFor(String(b.path[0])))[0];
 return { step: first ? stepFor(String(first.path[0])) : 3,
  field: first ? String(first.path[0]) as keyof ApplicationValues : undefined,
  message: `Please correct the highlighted fields. ${[...new Set(issues.map(issue => issue.message))].join(' ')}` };
}
