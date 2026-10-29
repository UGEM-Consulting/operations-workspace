import { EMAIL_CODE_PATTERN, type EmailCodePurpose } from '../auth/mfa-email';
const purposes: Record<EmailCodePurpose, string> = {
  login: 'to finish signing in',
  enrol: 'to turn on email codes for two-step verification',
  manage: 'to confirm a change to your two-step verification',
};
// Contains only the one-time code and what it is for: never names, addresses, links or device details.
export function staffCodeEmail(code: string, purpose: EmailCodePurpose) {
  if (!EMAIL_CODE_PATTERN.test(code)) throw new Error('Invalid verification code format');
  const text = [
    `Your UGEM Workspace code is: ${code}`,
    '',
    `Enter it ${purposes[purpose]}. It expires in 10 minutes and works once.`,
    '',
    'If you did not try to sign in, someone may know your password: change it in Account security and tell your administrator.',
    'This is an automated message; replies are not monitored.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#202020;background:#ffffff">
<p style="margin:0 0 16px">Your UGEM Workspace code is:</p>
<p style="margin:0 0 16px;font-size:28px;font-weight:bold;letter-spacing:4px;font-family:'Courier New',monospace">${code}</p>
<p style="margin:0 0 16px">Enter it ${purposes[purpose]}. It expires in 10 minutes and works once.</p>
<p style="margin:0;color:#5f5a57;font-size:13px">If you did not try to sign in, someone may know your password: change it in Account security and tell your administrator. This is an automated message; replies are not monitored.</p>
</body></html>`;
  return { subject: 'Your UGEM Workspace sign-in code', text, html };
}
