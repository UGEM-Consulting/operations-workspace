import { VERIFICATION_CODE_PATTERN } from '../onboarding/verification-code';
// Contains only the one-time code: never invitation links, tokens, references or applicant details.
export function verificationEmail(code: string) {
  if (!VERIFICATION_CODE_PATTERN.test(code)) throw new Error('Invalid verification code format');
  const text = [
    `Your Operations Workspace verification code is: ${code}`,
    '',
    'It expires in 10 minutes. Enter it on the page where you requested it.',
    '',
    'If you did not request this code, you can ignore this email. Nobody can open your application without it.',
    'This is an automated message; replies are not monitored.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#202020;background:#ffffff">
<p style="margin:0 0 16px">Your Operations Workspace verification code is:</p>
<p style="margin:0 0 16px;font-size:28px;font-weight:bold;letter-spacing:4px;font-family:'Courier New',monospace">${code}</p>
<p style="margin:0 0 16px">It expires in 10 minutes. Enter it on the page where you requested it.</p>
<p style="margin:0;color:#5f5a57;font-size:13px">If you did not request this code, you can ignore this email. Nobody can open your application without it. This is an automated message; replies are not monitored.</p>
</body></html>`;
  return { subject: 'Your Operations Workspace verification code', text, html };
}
