import { EMAIL_CODE_PATTERN, type EmailCodePurpose } from '../auth/mfa-email';
import { renderEmail } from './layout';
const purposes: Record<EmailCodePurpose, string> = {
  login: 'to finish signing in',
  enrol: 'to turn on email codes for two-step verification',
  manage: 'to confirm a change to your two-step verification',
};
// Contains only the one-time code and what it is for: never names, addresses, links or device details.
export function staffCodeEmail(code: string, purpose: EmailCodePurpose) {
  if (!EMAIL_CODE_PATTERN.test(code)) throw new Error('Invalid verification code format');
  return renderEmail({
    subject: 'Your UGEM Workspace sign-in code',
    paragraphs: ['Your UGEM Workspace code is:'],
    code,
    after: [`Enter it ${purposes[purpose]}. It expires in 10 minutes and works once.`],
    note: 'If you did not try to sign in, someone may know your password: change it in Account security and tell your administrator.',
  });
}
