import { renderEmail } from '../email/layout';

/**
 * Sent to a new hire when IT finishes the setup checklist. Like decision updates it names no person and carries no
 * company address, phone number or employment detail: the new hire learns those from the invitations themselves.
 */
export function setupCompleteMessage() {
  const paragraphs = [
    'IT has finished setting up your UGEM work accounts.',
    'Look for an invitation email from Google in your personal inbox and follow its steps to sign in to your company email. If you don’t see it within 15 minutes, check your Spam folder.',
    'Your manager or team lead will contact you about your first day.',
  ];
  return { ...renderEmail({ subject: 'Your UGEM work accounts are ready', paragraphs }), telegram: paragraphs.join('\n\n') };
}

/** Telegram alerts for staff: what is waiting and a link to it. The link opens nothing without signing in. */
export function staffAlertMessage(kind: 'REVIEW_WAITING' | 'IT_SETUP_WAITING', url: string) {
  return kind === 'REVIEW_WAITING'
    ? `An application is waiting for your review in UGEM Workspace.\n\n${url}`
    : `A new IT setup checklist is waiting in UGEM Workspace.\n\n${url}`;
}
