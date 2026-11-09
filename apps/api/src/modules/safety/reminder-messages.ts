import { renderEmail } from '../email/layout';

/** What a reminder is about, in the words people use. A work authorization here is always one that expires (a work permit or another document). */
export const REMINDER_WORDS: Record<string, string> = { LICENSE: 'driver’s license', MEDICAL_CARD: 'DOT medical card', WORK_AUTHORIZATION: 'work permit',
 INSURANCE: 'truck insurance', REGISTRATION: 'truck registration', ANNUAL_REVIEW: 'yearly review' };
const STAFF_WORDS: Record<string, string> = { ...REMINDER_WORDS, MEDICAL_CARD: 'medical card' };

/** "Dec 9, 2026" from a YYYY-MM-DD date. */
export const shortDate = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** Whole days from today to a date (negative once it has passed), both YYYY-MM-DD. */
export const daysUntil = (day: string, today: string) => Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400_000);
/** The latest step a date has reached (60, 30, 7 days before, or 0: the day or after), or null while it is further away. */
export function stepFor(dueOn: string, today: string, steps: readonly number[]): number | null {
 const left = daysUntil(dueOn, today);
 if (left > steps[0]) return null;
 return steps.filter(step => left <= step).at(-1)!;
}

/**
 * A driver's reminder: which document expires and when, and the renewal link (which still asks for a code emailed to them).
 * With no url, Safety already sent them a link that still works (until safetyLinkUntil), and the reminder points to it.
 * No name, number or other details.
 */
export function driverReminderMessage(kind: string, expiresOn: string, today: string, url: string | null, safetyLinkUntil: Date | null = null) {
 const word = REMINDER_WORDS[kind], left = daysUntil(expiresOn, today), date = shortDate(expiresOn);
 const subject = left > 0 ? `Your ${word} expires on ${date}` : left === 0 ? `Your ${word} expires today` : `Your ${word} expired on ${date}`;
 const ask = left > 0 ? `Send us a photo of your new one before then so you can keep getting loads.` : `Send us a photo of your new one as soon as you can, so you can keep getting loads.`;
 const paragraphs = [`Your ${word} on file with UGEM ${left > 0 ? `expires on ${date}` : left === 0 ? 'expires today' : `expired on ${date}`}.`, ask];
 const note = 'Want these reminders on Telegram instead? Ask UGEM Safety for a link.';
 if (!url) {
  const pointer = `Use the link UGEM Safety sent you${safetyLinkUntil ? `; it works until ${safetyLinkUntil.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}` : ''}.`;
  return { email: renderEmail({ subject, paragraphs: [...paragraphs, pointer], note }), telegram: `${subject}\n\n${ask} ${pointer}` };
 }
 const lead = 'Send it here. The link works for 7 days and asks for a code we email you:';
 return { email: renderEmail({ subject, paragraphs, link: { lead, url }, note }), telegram: `${subject}\n\n${ask}`, button: { text: 'Send the new one', url } };
}

export interface StaffReminderLine { firstName: string; lastName: string; kind: string; dueOn: string }
/** The Safety contact's morning message: first name and last initial, what, and when. The link opens Expiring documents. */
export function staffReminderMessage(lines: StaffReminderLine[], today: string, url: string) {
 const text = lines.map(line => {
  const left = daysUntil(line.dueOn, today), word = STAFF_WORDS[line.kind], who = `${line.firstName} ${line.lastName.slice(0, 1)}.`;
  if (line.kind === 'ANNUAL_REVIEW') return `${who}: yearly review ${left > 0 ? `due in ${left} days` : left === 0 ? 'due today' : `overdue since ${shortDate(line.dueOn)}`}.`;
  return `${who}: ${word} ${left > 1 ? `expires in ${left} days` : left === 1 ? 'expires tomorrow' : left === 0 ? 'expires today' : `expired ${shortDate(line.dueOn)}`}.`;
 });
 const subject = 'Documents to renew';
 return { email: renderEmail({ subject, paragraphs: text, link: { lead: 'Open Expiring documents:', url } }), telegram: `${subject}\n\n${text.join('\n')}\n\n${url}` };
}

export interface WeeklyCounts { expired: number; onHold: number; expiringSoon: number; waiting: number; reviewsDue: number }
/** The Safety manager's Monday summary: counts only, no names. */
export function weeklySummaryMessage(counts: WeeklyCounts, url: string) {
 const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
 const text = [`Expired: ${plural(counts.expired, 'document')}, ${plural(counts.onHold, 'driver')} on hold.`, `Expiring within 30 days: ${counts.expiringSoon}.`,
  `Waiting for a check: ${plural(counts.waiting, 'renewal scan')}.`, `Yearly reviews due: ${counts.reviewsDue}.`];
 const subject = 'Safety this week';
 return { email: renderEmail({ subject, paragraphs: text, link: { lead: 'Open Expiring documents:', url } }), telegram: `${subject}\n\n${text.join('\n')}\n\n${url}` };
}
