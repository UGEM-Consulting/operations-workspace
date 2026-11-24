'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Input, RadioGroup, Select, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate, readApi } from '@/lib/client-api';
import { middayIso } from '@/lib/navigation';
import { fullName, type BringBackOptions, type Choice, type MemberProfile, type TeamRow } from './types';

/**
 * Bringing back someone who left (section 41: LeftBringBackScreen, UndoLeavingScreen, UndoLeavingDeletedEmailScreen,
 * RehireScreen, RehiredProfileScreen; approved 2026-11-24). Undo leaving, for a mistake or a change of mind, puts them back
 * as if they never left; Rehire brings them back later on the same record. Nobody is messaged.
 */
const Day = ({ day }: { day: string }) => <LocalTime iso={middayIso(day)} format="date" />;
const INDEPENDENT = 'INDEPENDENT';
const EMAIL_WAS = { ARCHIVED: 'Archived', SUSPENDED: 'Suspended', DELETED: 'Deleted' } as const;
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
const listWords = (words: string[]) => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
const PROVIDERS: Record<string, string> = { DAT: 'DAT', TRUCKSTOP: 'Truckstop' };
const KIND_WORDS = { EMAIL: 'company email', RINGCENTRAL: 'RingCentral number' } as const;
// The Eastern date, as the API counts the 30 days.
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** What the dialogs need, loaded when one opens. An older API without the route answers 404, which the dialog says plainly. */
function useBringBack(memberId: string) {
  const [options, setOptions] = useState<BringBackOptions | null>(null), [failed, setFailed] = useState('');
  useEffect(() => {
    let current = true;
    readApi<BringBackOptions>(`dispatch/members/${memberId}/bring-back`).then(found => { if (current) setOptions(found); })
      .catch(error => { if (current) setFailed(errorMessage(error, 'Unable to load what comes back. Close this and try again.')); });
    return () => { current = false; };
  }, [memberId]);
  return { options, failed };
}
const Loading = () => <div className="space-y-3" aria-busy="true"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-16 w-full" /></div>;

/** The page of someone who left, within 30 days of their last day: Undo leaving is in More actions until then (LeftBringBackScreen). */
export function UndoWindowAlert({ member }: { member: MemberProfile }) {
  const until = member.bringBack?.canUndo ? member.bringBack.undoUntil : null;
  if (!until || !member.leftAt) return null;
  const days = Math.max(0, Math.round((Date.parse(`${easternToday()}T12:00:00Z`) - Date.parse(`${member.leftAt.slice(0, 10)}T12:00:00Z`)) / 86400_000));
  return <Alert tone="info" title={days === 0 ? 'Left today' : `Left ${plural(days, 'day')} ago`}><p>If {member.firstName} didn’t really leave, use Undo leaving in More actions until <Day day={until} />. After that, Rehire brings them back.</p></Alert>;
}

/** Back after leaving (RehiredProfileScreen): the latest rehire, and the stay before it. */
export function lastRehire(member: MemberProfile) {
  const latest = member.returns?.[0];
  return latest?.kind === 'REHIRE' && member.status !== 'LEFT' ? latest : null;
}
export function rehiredMeta(member: MemberProfile) {
  const back = lastRehire(member);
  if (!back?.firstDay) return [];
  return [<>Back <Day day={back.firstDay} /></>, <>Worked here before {back.previousStartKnown ? <LocalTime iso={back.previousJoinedAt} format="date" /> : 'a day not recorded'} – {back.leftKnown ? <LocalTime iso={back.leftAt} format="date" /> : 'a day not recorded'}</>];
}
/** While IT sets someone rehired up again, or until their first day back when nothing was asked of IT. */
export function RehiredAlert({ member }: { member: MemberProfile }) {
  const back = lastRehire(member);
  if (!back || member.status !== 'ONBOARDING') return null;
  const asked = !!member.accounts?.total && !member.accounts.completedAt;
  return asked ? <Alert tone="info" title={`IT is setting ${member.firstName} up again`}><p>{member.accounts!.done ?? 0} of {member.accounts!.total} tasks done. {member.firstName} becomes Active when IT finishes, as a new hire does.</p></Alert>
    : <Alert tone="info" title={<>Back <Day day={back.firstDay!} /></>}><p>Nothing was asked of IT, so {member.firstName} becomes Active on their first day back.</p></Alert>;
}
/** The time away between two stays, for MC and team history: from the day after they left to the day before they came back. */
export function awayPeriods(member: MemberProfile) {
  return (member.returns ?? []).filter(row => row.kind === 'REHIRE' && row.firstDay).map(row => ({ id: `away-${row.id}`, firstDay: row.firstDay!, leftAt: row.leftAt, leftKnown: row.leftKnown }));
}

/** Undo leaving (UndoLeavingScreen, UndoLeavingDeletedEmailScreen). */
export function UndoLeavingDialog({ member, onClose }: { member: MemberProfile; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const { options, failed } = useBringBack(member.id);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const name = fullName(member), first = member.firstName;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '');
    if (!reason.trim()) { setError('Say why their leaving is undone.'); return; }
    setPending(true); setError('');
    try { await mutate(`dispatch/members/${member.id}/undo-leaving`, 'POST', { version: member.version, reason }); toast({ title: `${name} is back`, description: 'Their leaving was undone.' }); onClose(); router.refresh(); }
    catch (caught) { setError(errorMessage(caught, 'Unable to undo their leaving. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  const undo = options?.undo, back = undo?.comesBack, notBack = undo?.notBack, removal = options?.removal, email = options?.email;
  const notBackItems = notBack ? [
    ...(notBack.drivers.length ? [`${plural(notBack.drivers.length, 'driver')} now with ${[...new Set(notBack.drivers.map(driver => driver.now ?? 'nobody yet'))].join(' and ')}: reassign them from Dispatch › Drivers.`] : []),
    ...notBack.supports.map(row => `${row.name} (${row.supportType === 'UPDATER' ? 'updater' : 'support'}) ${row.status === 'LEFT' ? 'has left' : `now helps ${row.now ?? 'nobody'}`}: change their dispatcher on ${row.name.split(' ')[0]}’s page.`),
    ...notBack.ledTeams.map(team => `Team lead of ${team}: choose them again on the team page.`),
    ...(notBack.seats ?? []).map(seat => `Their ${PROVIDERS[seat.provider] ?? seat.provider} seat on ${seat.name} ended: IT or an administrator adds it again from the Load boards card.`),
    ...(notBack.sharing ?? []).map(row => row.user ? `${row.user} stopped using their ${KIND_WORDS[row.kind]}: record it again if they still use it.` : `${first} stopped using ${row.owner ?? 'someone'}’s ${KIND_WORDS[row.kind]}: record it again if they still use it.`)] : [];
  // What IT is asked to do, from the steps the API restores (an older API sends none, and the earlier wording shows).
  const restoreWords = undo?.restore ? [
    undo.restore.includes('GOOGLE_WORKSPACE') ? (email?.restorable ? `restore the ${email.was ? `${EMAIL_WAS[email.was].toLowerCase()} ` : ''}email` : 'create a new company email') : null,
    undo.restore.includes('RINGCENTRAL') ? (options?.ringCentral?.restorable ? 'enable the RingCentral user with SMS and call recording' : 'set up a new RingCentral number') : null,
    undo.restore.includes('DISPATCH_GROUP') ? 'add back the Dispatch group' : null, undo.restore.includes('BUSINESS_SOFTWARE') ? 'add back business software' : null,
    undo.restore.includes('EQUIPMENT') ? 'give back their equipment' : null].filter((item): item is string => !!item) : null;
  // IT setup the leaving cancelled carries on, so they're Onboarding until IT finishes it.
  const onboarding = undo?.status === 'ONBOARDING';
  return <Dialog open onClose={onClose} size="lg" title={`Undo ${name}’s leaving`} busy={pending}
    description={`For a mistake or a change of mind, until 30 days after the last day. ${first} is ${onboarding ? 'back in Onboarding' : 'Active again'}, as if they never left.`}
    actions={undo?.allowed && <Button form="undo-leaving" type="submit">{pending ? 'Undoing…' : 'Undo leaving'}</Button>}>
    {failed ? <Alert tone="danger" title="Couldn’t load what comes back"><p>{failed}</p></Alert> : !options ? <Loading /> : !undo!.allowed ? <Alert tone="warning" title="Their leaving can’t be undone"><p>{undo!.why}</p></Alert>
      : <form id="undo-leaving" onSubmit={submit} className="space-y-4">
        <Textarea label="Why" name="reason" rows={2} maxLength={500} required hint="Staff only. Never health or other private details." />
        <Card><CardHeader title="Comes back" /><CardBody><DescriptionList layout="rows" items={[
          { label: 'Status', value: onboarding ? 'Onboarding, until IT finishes the setup the leaving stopped' : 'Active' },
          ...(member.position === 'SUPPORT' ? [{ label: 'Helps', value: back?.helps ? (back.helps.carriesOn ? `${back.helps.name}, carrying on from before` : `Not ${back.helps.name}: choose who they help again`) : null, emptyLabel: 'Choose who they help again' }]
            : [{ label: 'MC and team', value: back?.place ? (back.place.carriesOn ? `${back.place.mc} · ${back.place.team ?? 'Independent'}, carrying on from before` : `${back.place.mc} · ${back.place.team ?? 'Independent'} is archived: set MC and team again`) : null, emptyLabel: 'Set MC and team again' },
              { label: 'Job title', value: back?.jobTitle ?? null }])]} /></CardBody></Card>
        {notBackItems.length > 0 && <Card><CardHeader title="Doesn’t come back by itself" description={`These changed when ${first} left. Do them again if they should.`} />
          <CardBody><ul className="list-disc space-y-1 pl-5 text-sm">{notBackItems.map(item => <li key={item}>{item}</li>)}</ul></CardBody></Card>}
        {email?.was === 'DELETED' && email.deletedOn && (email.restorable
          ? <Alert tone="warning" title={<>Their company email was deleted on <Day day={email.deletedOn} /></>}><p>IT can restore it until <Day day={email.restorableUntil!} />. After that IT creates a new email instead.</p></Alert>
          : <Alert tone="warning" title="Their company email can’t be restored"><p>{email.why} IT creates a new one on the restore checklist.</p></Alert>)}
        {removal && (removal.open ? <Alert tone="info" title="IT stops removing their access"><p>{restoreWords ? (restoreWords.length ? `IT had already started, so undoing asks IT to ${listWords(restoreWords)}.` : 'IT hadn’t removed anything yet, so there is nothing to restore.') : 'Anything IT had already done goes on a restore checklist for IT.'}</p></Alert>
          : <Alert tone="info" title={restoreWords && !restoreWords.length ? 'Nothing for IT to restore' : 'IT gets a restore checklist'}><p>IT finished removing {first}’s access{removal.completedAt ? <> on <LocalTime iso={removal.completedAt} format="date" /></> : null}.{' '}
            {restoreWords ? (restoreWords.length ? `Undoing asks IT to ${listWords(restoreWords)}.` : 'Nothing IT did needs restoring.')
              : `Undoing asks IT to ${[email && email.restorable ? `restore the ${email.was ? EMAIL_WAS[email.was].toLowerCase() : ''} email`.replace('  ', ' ') : null, options.ringCentral ? 'enable the RingCentral user with SMS and call recording' : null, 'add back the Dispatch group and business software'].filter(Boolean).join(', ')}.`}</p></Alert>)}
        <p className="text-[13px] leading-5 text-muted-foreground">{first} isn’t messaged. History keeps the leaving and shows it was undone.</p>
        <Notice message={error} error /><PendingHint pending={pending} />
      </form>}
  </Dialog>;
}

type Account = 'RESTORE' | 'NEW' | 'NONE';
/** Rehire (RehireScreen): back on the same record from their first day back, placed again, with IT asked to restore or create their accounts. */
type RehireProps = { member: MemberProfile; mcs: Choice[]; teams: TeamRow[]; jobTitles: Choice[]; dispatchers: { id: string; name: string; mc: string | null; team: string | null }[]; onClose: () => void };
export function RehireDialog(props: RehireProps) {
  const { options, failed } = useBringBack(props.member.id);
  const blocked = (body: React.ReactNode) => <Dialog open onClose={props.onClose} size="lg" title={`Rehire ${fullName(props.member)}`}>{body}</Dialog>;
  if (failed) return blocked(<Alert tone="danger" title="Couldn’t load their accounts"><p>{failed}</p></Alert>);
  if (!options) return blocked(<Loading />);
  if (!options.rehire.allowed) return blocked(<Alert tone="warning" title="They can’t be rehired yet"><p>{options.rehire.why}</p></Alert>);
  return <RehireForm {...props} options={options} />;
}
/** The form, once their old accounts are known: it starts from where they were before, when that's still active. */
function RehireForm({ member, mcs, teams, jobTitles, dispatchers, onClose, options }: RehireProps & { options: BringBackOptions }) {
  const router = useRouter(), toast = useToast(), previous = options.rehire.previous;
  const active = <T extends { id: string; archived: boolean }>(list: T[], id: string | null) => id && list.some(item => item.id === id && !item.archived) ? id : '';
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const [position, setPosition] = useState<'DISPATCHER' | 'SUPPORT' | 'UPDATER'>(previous.position);
  const [mcId, setMcId] = useState(active(mcs, previous.mcId)), [teamId, setTeamId] = useState(active(teams, previous.teamId) || INDEPENDENT), [titleId, setTitleId] = useState(active(jobTitles, previous.jobTitleId));
  const wholeTeam = active(teams, previous.supportsTeamId);
  const [assisting, setAssisting] = useState<'DISPATCHER' | 'TEAM'>(wholeTeam ? 'TEAM' : 'DISPATCHER'), [helpsTeamId, setHelpsTeamId] = useState(wholeTeam);
  const [helpsId, setHelpsId] = useState(previous.supportsMemberId && dispatchers.some(row => row.id === previous.supportsMemberId) ? previous.supportsMemberId : '');
  const was = member.position === 'DISPATCHER' ? 'NEW' as const : 'NONE' as const;
  const [email, setEmail] = useState<Account>(options.email?.restorable ? 'RESTORE' : was), [ringCentral, setRingCentral] = useState<Account>(options.ringCentral?.restorable ? 'RESTORE' : was);
  const [software, setSoftware] = useState(member.position === 'DISPATCHER'), [equipment, setEquipment] = useState(false), [firstDay, setFirstDay] = useState(options.rehire.earliest);
  const name = fullName(member), first = member.firstName, dispatcher = position === 'DISPATCHER';
  const teamChoices = teams.filter(team => !team.archived && team.mc.id === mcId);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (dispatcher && (!mcId || !titleId)) { setError('Choose their MC and job title.'); return; }
    if (!dispatcher && !(assisting === 'TEAM' ? helpsTeamId : helpsId)) { setError(assisting === 'TEAM' ? 'Choose the team they help.' : 'Choose the dispatcher they help.'); return; }
    setPending(true); setError('');
    try {
      await mutate(`dispatch/members/${member.id}/rehire`, 'POST', { version: member.version, firstDay, position, email, ringCentral, businessSoftware: software, equipment,
        ...(dispatcher ? { mcId, teamId: teamId === INDEPENDENT ? null : teamId, jobTitleId: titleId } : assisting === 'TEAM' ? { supportsTeamId: helpsTeamId } : { supportsMemberId: helpsId }) });
      const asked = email !== 'NONE' || ringCentral !== 'NONE' || software || equipment || dispatcher;
      toast({ title: `${name} rehired`, description: asked ? 'IT got a setup checklist.' : 'Nothing was asked of IT.' }); onClose(); router.refresh();
    } catch (caught) { setError(errorMessage(caught, 'Unable to rehire them. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  const rehire = options.rehire, oldEmail = options.email, oldNumber = options.ringCentral;
  const emailOptions = [...(oldEmail?.restorable ? [{ value: 'RESTORE', label: `Restore ${oldEmail.value}`, description: oldEmail.was === 'DELETED' && oldEmail.restorableUntil ? `Deleted, and IT can still restore it until ${new Date(middayIso(oldEmail.restorableUntil)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.` : `${oldEmail.was ? EMAIL_WAS[oldEmail.was] : 'Closed'}, so their old email and files come back.` }] : []),
    { value: 'NEW', label: 'A new email', description: oldEmail && !oldEmail.restorable ? oldEmail.why ?? undefined : undefined }, { value: 'NONE', label: 'No company email' }];
  const numberOptions = [...(oldNumber?.restorable ? [{ value: 'RESTORE', label: 'Enable their user again', description: `${oldNumber.number}${oldNumber.extension ? `, ext ${oldNumber.extension}` : ''}, with SMS and call recording.` }] : []),
    { value: 'NEW', label: 'A new number', description: oldNumber && !oldNumber.restorable ? oldNumber.why ?? undefined : undefined }, { value: 'NONE', label: 'No RingCentral number' }];
  return <Dialog open onClose={onClose} size="lg" title={`Rehire ${name}`} busy={pending}
    description={`Same record, so their history, documents and names stay together. They’re Onboarding until IT finishes, then Active.`}
    actions={<Button form="rehire" type="submit">{pending ? 'Rehiring…' : 'Rehire'}</Button>}>
    <form id="rehire" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="First day back" name="firstDay" type="date" required min={rehire.earliest} max={rehire.latest} value={firstDay} onChange={event => setFirstDay(event.target.value)} width="full" hint="Today, or up to 90 days ahead." />
          <Select label="Position" name="position" value={position} width="full" onChange={event => setPosition(event.target.value as typeof position)}
            options={[{ value: 'DISPATCHER', label: 'Dispatcher' }, { value: 'SUPPORT', label: 'Support' }, { value: 'UPDATER', label: 'Updater' }]} />
        </div>
        {dispatcher ? <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="MC" name="mcId" required value={mcId} placeholder="Choose an MC" width="full" onChange={event => { setMcId(event.target.value); setTeamId(INDEPENDENT); }} options={mcs.filter(mc => !mc.archived).map(mc => ({ value: mc.id, label: mc.name }))} />
            <Select label="Team" name="teamId" value={teamId} width="full" disabled={!mcId} onChange={event => setTeamId(event.target.value)} options={[{ value: INDEPENDENT, label: 'Independent' }, ...teamChoices.map(team => ({ value: team.id, label: team.name }))]} />
          </div>
          <Select label="Job title" name="jobTitleId" required value={titleId} placeholder="Choose a job title" onChange={event => setTitleId(event.target.value)} options={jobTitles.filter(title => !title.archived).map(title => ({ value: title.id, label: title.name }))} />
        </> : <>
          <RadioGroup name="assisting" label="They help" value={assisting} onChange={value => setAssisting(value as typeof assisting)} options={[{ value: 'DISPATCHER', label: 'A dispatcher' }, { value: 'TEAM', label: 'A whole team' }]} />
          {assisting === 'TEAM' ? <Select label="Team" name="supportsTeamId" required value={helpsTeamId} placeholder="Choose a team" onChange={event => setHelpsTeamId(event.target.value)} options={teams.filter(team => !team.archived).map(team => ({ value: team.id, label: `${team.name} · ${team.mc.name}` }))} />
            : <Select label="Dispatcher" name="supportsMemberId" required value={helpsId} placeholder="Choose a dispatcher" onChange={event => setHelpsId(event.target.value)} options={dispatchers.map(row => ({ value: row.id, label: [row.name, row.mc, row.team].filter(Boolean).join(' · ') }))} />}
        </>}
        <Card><CardHeader title="Accounts" description="IT gets a setup checklist with what you choose." /><CardBody className="space-y-4">
          <RadioGroup name="email" label="Company email" cards value={email} onChange={value => setEmail(value as Account)} options={emailOptions} />
          <RadioGroup name="ringCentral" label="RingCentral" cards value={ringCentral} onChange={value => setRingCentral(value as Account)} options={numberOptions} />
          <Checkbox label="Business software and load boards" checked={software} onChange={event => setSoftware(event.target.checked)} />
          <Checkbox label="Equipment" description="Laptop and headset." checked={equipment} onChange={event => setEquipment(event.target.checked)} />
          {dispatcher && <p className="text-[13px] leading-5 text-muted-foreground">IT also adds a dispatcher back to the Dispatch group.</p>}
        </CardBody></Card>
        <p className="text-[13px] leading-5 text-muted-foreground">{first} isn’t messaged. Documents they signed stay on file.</p>
        <Notice message={error} error /><PendingHint pending={pending} />
      </form>
  </Dialog>;
}
