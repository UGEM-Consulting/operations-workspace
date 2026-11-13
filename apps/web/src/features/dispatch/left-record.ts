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
