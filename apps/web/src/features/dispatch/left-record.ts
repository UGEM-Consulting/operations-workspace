import type { MemberProfile } from './types.ts';

// The page of someone who left (LeftRecordScreen and LeftDispatcherScreen, approved): what was, never "now".
/** Where they last worked, for the header: "Dispatcher at Lakeside Carriers", or the job title alone with no MC. */
export function lastWorked(member: Pick<MemberProfile, 'jobTitle' | 'history'>) {
  const title = member.jobTitle?.name ?? 'Dispatcher', mc = member.history[0]?.mc;
  return mc ? `${title} at ${mc}` : title;
}
/** IT access for someone added as Left whose accounts IT hasn't been asked to close. */
export const itNotAsked = (accountsRecorded: boolean) => accountsRecorded
  ? 'IT hasn’t been asked to close anything. Ask only if their accounts might still be open.'
  : 'No accounts were recorded, so there’s nothing for IT to close.';

/** A change to the record itself, as the profile sends it (recordChanges): field names and flags, never the values. */
export interface RecordChange { id: string; event: string; createdAt: string; by: string | null; metadata: { fields?: string[]; from?: string; source?: string; otherNames?: number; reasonChanged?: boolean; forward?: boolean; note?: boolean } }
const FIELD_WORDS: Record<string, string> = { companyEmail: 'company email', ringCentralNumber: 'RingCentral number', ringCentralExtension: 'extension', personalEmail: 'personal email', personalPhone: 'personal phone',
  telegram: 'Telegram', datEmail: 'DAT sign-in', truckstopEmail: 'Truckstop sign-in', NDA: 'paper NDA date', SOP: 'paper SOP date', legalName: 'legal name', lastDay: 'last day', leftReason: 'reason for leaving',
  otherNames: 'other names', companyAccount: 'an account at another company', seats: 'load board seats' };
const sentence = (words: string[]) => { const text = words.join(', '); return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`; };
/** History's entries for changes to the record (HistoryFromFileScreen): what changed and, for a file, which one. */
export function recordChangeItems(changes: RecordChange[]) {
  return changes.map(change => {
    const fields = change.metadata.fields ?? [], count = change.metadata.otherNames;
    const words = fields.map(field => field === 'otherNames' && count ? `${count} other ${count === 1 ? 'name' : 'names'}` : FIELD_WORDS[field] ?? field);
    const fromFile = change.metadata.from === 'file';
    const title = change.event === 'NAMES_CHANGED' ? 'Names changed' : change.event === 'LEFT_DAY_RECORDED' ? 'Last day added' : change.event === 'CLOSE_ACCOUNTS_ASKED' ? 'IT asked to close their accounts'
      : fromFile ? (change.metadata.source ? `Details added from ${change.metadata.source}` : 'Details added from a file') : 'Recorded details changed';
    const body = change.event === 'LEFT_DAY_RECORDED' ? (change.metadata.reasonChanged ? 'With the reason they left.' : undefined) : change.event === 'CLOSE_ACCOUNTS_ASKED' ? (change.metadata.forward ? 'Email forwarded for 30 days.' : undefined) : words.length ? sentence(words) : undefined;
    return { id: change.id, at: change.createdAt, title, body, by: change.by };
  });
}
