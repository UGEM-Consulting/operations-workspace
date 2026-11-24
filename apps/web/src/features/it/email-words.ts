/**
 * What happens to a company email when someone leaves or an account closes (section 40: LeavingEmailChoiceScreen,
 * LeavingEmailDeleteScreen, ItGoogleWorkspaceTaskScreen; approved 2026-11-23). The manager chooses Archive (chosen to start),
 * Suspend or Delete, and forwarding is its own tick; IT records what it did. SUSPEND is what every earlier request meant.
 */
export type EmailAction = 'ARCHIVE' | 'SUSPEND' | 'DELETE';
export type EmailDone = 'ARCHIVED' | 'SUSPENDED' | 'DELETED';
export interface EmailChoice { action: EmailAction; forward: boolean }

export const EMAIL_ACTION_OPTIONS: { value: EmailAction; label: string; description: string }[] = [
  { value: 'ARCHIVE', label: 'Archive it', description: 'Costs less than a full license. The email and Drive files stay, and IT can open them if needed.' },
  { value: 'SUSPEND', label: 'Suspend it', description: 'Keeps everything on a full license. For someone who may come back soon.' },
  { value: 'DELETE', label: 'Delete it', description: 'The account, email and Drive files are removed. IT can restore it for 20 days, then it’s gone.' },
];
export const EMAIL_DONE_OPTIONS: { value: EmailDone; label: string; description?: string }[] = [
  { value: 'ARCHIVED', label: 'Archived', description: 'License changed to Archived User.' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'DELETED', label: 'Deleted' },
];
const ACTION_WORDS: Record<EmailAction, string> = { ARCHIVE: 'Archive', SUSPEND: 'Suspend', DELETE: 'Delete' };
const DONE_WORDS: Record<EmailDone, string> = { ARCHIVED: 'Archived', SUSPENDED: 'Suspended', DELETED: 'Deleted' };
/** What IT records to start with: the manager's choice. */
export const doneFor = (action: EmailAction): EmailDone => ({ ARCHIVE: 'ARCHIVED', SUSPEND: 'SUSPENDED', DELETE: 'DELETED' } as const)[action];
export const actionWord = (action: EmailAction) => ACTION_WORDS[action];
export const doneWord = (done: EmailDone) => DONE_WORDS[done];
/** "Archive · forward to Avery Quinn for 30 days", or what IT did once it's recorded. */
export function emailAfterText(action: EmailAction | undefined, forward: boolean, forwardTo: string | null, done?: EmailDone | null) {
  const what = done ? doneWord(done) : action ? actionWord(action) : 'Suspend';
  return `${what}${forward ? ` · forward to ${forwardTo ?? 'the manager'} for 30 days` : action ? '' : ' only'}`;
}
/** IT's step, worded from the manager's choice. */
export function emailStepText(email: string, action: EmailAction, forward: boolean, forwardTo: string | null) {
  const step = action === 'ARCHIVE' ? `Archive ${email}: change its license to Archived User and sign it out everywhere.`
    : action === 'DELETE' ? `Delete ${email} after signing it out everywhere. Google lets you restore it for 20 days.`
    : `Suspend ${email} and sign it out everywhere.`;
  return `${step}${forward ? ` Forward new email to ${forwardTo ?? 'the manager'} for 30 days.` : ''}`;
}
