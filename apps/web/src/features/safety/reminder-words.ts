import type { DriverProfile, DriverReminderRow } from './types';

// Plain helpers (no client code), so server pages such as Expiring documents can use them too.
export const reminderKinds: Record<string, string> = { LICENSE: 'Driver’s license', MEDICAL_CARD: 'Medical card' };
export const reminderStep = (step: number) => step === 0 ? 'the day' : `${step} days`;
const failures: Record<string, string> = { NO_ADDRESS: 'no email on file', NOT_CONNECTED: 'Telegram not connected', FORBIDDEN: 'they blocked the bot', DISABLED: 'sending is off',
  RENEWED: 'already renewed', CHANGED: 'date corrected since', WAITING: 'their new scan waits for a check', CLOSED: 'record closed' };
/** How a reminder went, in a few words: by Telegram or email, or why it wasn't sent. */
export function reminderOutcome(row: Pick<DriverReminderRow, 'channel' | 'status' | 'failureCode'>) {
  const channel = row.channel === 'TELEGRAM' ? 'Telegram' : 'Email';
  if (row.status === 'SENT') return channel;
  if (row.status === 'PENDING' || row.status === 'SENDING') return `${channel}, sending`;
  return `Not sent: ${failures[row.failureCode ?? ''] ?? 'couldn’t be delivered'}`;
}
/** The newest reminder about a document of this kind that expires on this day, for the Documents list. */
export function latestReminder(driver: DriverProfile, kind: string, expiresOn: string | null) {
  return driver.reminders?.items.find(row => row.kind === kind && row.dueOn === expiresOn) ?? null;
}
