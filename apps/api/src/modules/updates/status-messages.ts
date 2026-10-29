import type { ApplicationStatus } from '../onboarding/entities';
import { renderEmail } from '../email/layout';
export type DecisionStatus = Extract<ApplicationStatus, 'CHANGES_REQUESTED' | 'APPROVED' | 'REJECTED'>;
export const DECISION_STATUSES: readonly ApplicationStatus[] = ['CHANGES_REQUESTED', 'APPROVED', 'REJECTED'];

/**
 * Status update text for email and Telegram. It names no person, employment, field values or reviewer reasons;
 * the applicant reads details only after signing in. The reference alone opens nothing: resuming still needs
 * a fresh code sent to the verified email.
 */
export function statusMessage(status: DecisionStatus, reference: string, resumeUrl: string, accessUntil: Date) {
 const lines = {
  CHANGES_REQUESTED: ['Your manager asked for some changes to your UGEM dispatcher application.',
   `Sign in to see what to change, then send it again by ${accessUntil.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.`],
  APPROVED: ['Your UGEM dispatcher application was approved.', 'Our IT team is now setting up your work accounts. Your manager will contact you about next steps.'],
  REJECTED: ['Your UGEM dispatcher application was not approved.', 'Contact your manager if you have questions.'],
 }[status];
 const subject = { CHANGES_REQUESTED: 'Changes requested on your UGEM application', APPROVED: 'Your UGEM application was approved', REJECTED: 'An update on your UGEM application' }[status];
 const access = [`To check your application, open ${resumeUrl} and enter your email and this application reference:`, reference];
 const email = renderEmail({ subject, paragraphs: lines, link: { lead: 'To check your application, open this page and enter your email and the application reference below:', url: resumeUrl }, code: reference });
 return { ...email, telegram: [...lines, '', ...access].join('\n') };
}
