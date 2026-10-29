import { VERIFICATION_CODE_PATTERN } from '../onboarding/verification-code';
import { renderEmail } from './layout';
// Contains only the one-time code: never invitation links, tokens, references or applicant details.
export function verificationEmail(code: string) {
  if (!VERIFICATION_CODE_PATTERN.test(code)) throw new Error('Invalid verification code format');
  return renderEmail({
    subject: 'Your UGEM Workspace verification code',
    paragraphs: ['Your UGEM Workspace verification code is:'],
    code,
    after: ['It expires in 10 minutes. Enter it on the page where you requested it.'],
    note: 'If you did not request this code, you can ignore this email. Nobody can open your application without it.',
  });
}
