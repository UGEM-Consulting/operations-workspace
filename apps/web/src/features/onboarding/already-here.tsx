import Link from 'next/link';
import { Users } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { Person } from '@/components/ui/avatar';

/**
 * Already here (section 37, designed as AlreadyHereInvitationsScreen, AlreadyHereReviewScreen and AlreadyHereRehireScreen and
 * approved 2026-11-11): people and open applications that share an applicant's verified email or submitted personal phone.
 * The applicant never sees it. Another manager's application shows that manager's name, never the applicant's.
 */
export interface HereMatch { on: 'EMAIL' | 'PHONE'; kind: 'MEMBER' | 'APPLICATION'; memberId: string | null; name: string | null; position: string | null; supportType: string | null; status: string; leftAt: string | null; applicationId: string | null; manager: string | null }
export interface HerePerson { name: string | null; status: string; leftAt: string | null; position?: string | null; supportType?: string | null }

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
const positionName = (match: Pick<HereMatch, 'position' | 'supportType'>) => match.position === 'SUPPORT' ? match.supportType === 'UPDATER' ? 'Updater' : 'Support' : 'Dispatcher';
/** Someone working now or on leave counts as here; only people who left can come back. */
export const hereNow = (match: Pick<HereMatch, 'kind' | 'status'>) => match.kind === 'MEMBER' && match.status !== 'LEFT';

function MatchStatus({ match }: { match: Pick<HereMatch, 'kind' | 'status' | 'leftAt'> }) {
 if (match.kind === 'APPLICATION') return <Badge label={match.status === 'DRAFT' || match.status === 'INVITED' ? 'Filling in the form' : match.status === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Waiting for review'} tone="info"/>;
 if (match.status === 'LEFT') return <Badge label={match.leftAt ? `Left ${day(match.leftAt)}` : 'Left'} tone="neutral"/>;
 if (match.status === 'ON_LEAVE') return <Badge label="On leave" tone="info"/>;
 return <Badge label={match.status === 'ONBOARDING' ? 'Onboarding' : 'Active'} tone="success"/>;
}

/** The line under an applicant on Invitations: "Same email as Jesse Lin, left Oct 31". */
export function AlreadyHereTag({ match }: { match: HerePerson }) {
 const when = match.status === 'LEFT' ? match.leftAt ? `, left ${new Date(match.leftAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}` : ', who left'
  : match.status === 'ON_LEAVE' ? ', on leave' : ', who works here';
 return <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-warning-background px-2 py-0.5 text-[12px] font-medium text-warning">
  <Users aria-hidden="true" className="size-3.5"/>Same email as {match.name ?? 'someone here'}{when}</span>;
}

/** The review page's card: every match, what matched and their status, with Open for people's pages. */
export function AlreadyHereCard({ matches, applicant }: { matches: HereMatch[]; applicant: string }) {
 return <Card>
  <CardHeader title="Already here?" description={`People and applications with the same personal email or phone. ${applicant} isn’t told about this check.`}/>
  <CardBody flush>
   <Table caption="Possible matches" rows={matches} rowKey={match => `${match.memberId ?? match.applicationId}-${match.on}`} columns={[
    { key: 'who', label: 'Who', primary: true, cell: match => match.kind === 'MEMBER'
     ? <Person name={match.name ?? 'Someone here'} secondary={positionName(match)}/>
     : <Person name="An application" secondary={match.manager ? `${match.manager} is the manager` : 'Another application'} avatar={false}/> },
    { key: 'on', label: 'Same', cell: match => match.on === 'EMAIL' ? 'Personal email' : 'Personal phone' },
    { key: 'status', label: 'Status', cell: match => <MatchStatus match={match}/> },
    { key: 'open', label: 'Actions', srOnly: true, align: 'right', cell: match => match.memberId
     ? <Link className="text-sm font-medium text-primary underline-offset-4 hover:underline" href={`/dispatch/dispatchers/${match.memberId}`}>Open<span className="sr-only"> {match.name}</span></Link> : null },
   ]}/>
  </CardBody>
 </Card>;
}

const listed = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '';
/** Who matched and on what, for the review page's alert: “Their phone matches Riley Santos, an Active dispatcher, and another application.” */
export function hereSentence(matches: HereMatch[]) {
 const who = (match: HereMatch) => {
  const position = positionName(match).toLowerCase(), name = match.name ?? 'someone here';
  if (match.status === 'LEFT') return `${name}, who left${match.leftAt ? ` on ${day(match.leftAt)}` : ''}`;
  return match.status === 'ON_LEAVE' ? `${name}, a ${position} on leave` : match.status === 'ONBOARDING' ? `${name}, an onboarding ${position}` : `${name}, an Active ${position}`;
 };
 return (['EMAIL', 'PHONE'] as const).flatMap(on => {
  const people = matches.filter(match => match.on === on && match.kind === 'MEMBER').map(who), applications = matches.filter(match => match.on === on && match.kind === 'APPLICATION').length;
  const items = [...people, ...(applications ? [applications === 1 ? 'another application' : `${applications} other applications`] : [])];
  return items.length ? [`Their ${on === 'EMAIL' ? 'email' : 'phone'} matches ${listed(items)}.`] : [];
 }).join(' ');
}

/** What the approval asks, from the matches: nothing, "a different person" for a phone shared with someone here, or a rehire. */
export function approvalQuestion(matches: HereMatch[] | null | undefined) {
 const people = (matches ?? []).filter(match => match.kind === 'MEMBER');
 const current = people.filter(hereNow);
 const email = current.find(match => match.on === 'EMAIL');
 if (email) return { kind: 'blocked' as const, name: email.name ?? 'someone here' };
 const phone = current.find(match => match.on === 'PHONE');
 if (phone) return { kind: 'different' as const, name: phone.name ?? 'someone here' };
 const left = people.find(match => match.status === 'LEFT');
 if (left?.memberId) return { kind: 'returning' as const, name: left.name ?? 'someone who left', memberId: left.memberId };
 return null;
}
