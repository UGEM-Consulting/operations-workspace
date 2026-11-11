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
const STAFF_ALERTS = {
  REVIEW_WAITING: 'An application is waiting for your review in UGEM Workspace.',
  IT_SETUP_WAITING: 'A new IT setup checklist is waiting in UGEM Workspace.',
  IT_REMOVAL_WAITING: 'A dispatcher has left. Their accounts are waiting to be removed in UGEM Workspace.',
  IT_REMOVAL_SCHEDULED: 'A dispatcher is leaving. Their accounts are scheduled for removal in UGEM Workspace.',
  IT_REMOVAL_DUE: 'A dispatcher’s last day is today. Remove their accounts at the end of the day in UGEM Workspace.',
  IT_REMOVAL_NOW: 'A manager asked to remove a dispatcher’s accounts now in UGEM Workspace.',
  // Leave (section 35, approved 2026-11-11): like the others, they name no one.
  IT_LEAVE_SUSPEND: 'Someone is going on leave. Suspend their accounts from their first day away in UGEM Workspace.',
  IT_LEAVE_RESTORE: 'Someone is back from leave. Restore their accounts in UGEM Workspace.',
};
export type StaffAlertKind = keyof typeof STAFF_ALERTS;
export function staffAlertMessage(kind: StaffAlertKind, url: string) { return `${STAFF_ALERTS[kind]}\n\n${url}`; }
