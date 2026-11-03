'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ban, Building2, Calendar, Ellipsis, FileText, Mail, Phone, Plus, RotateCcw, Route, UserMinus, Users } from 'lucide-react';
import { PageCrumb } from '@/components/shell-context';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
import { Alert, Notice } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { DescriptionList } from '@/components/ui/description-list';
import { Progress } from '@/components/ui/feedback';
import { Input, RadioGroup, Select, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PrivateImage } from '@/components/ui/private-image';
import { Timeline } from '@/components/ui/timeline';
import { Badge, statusLabel } from '@/components/ui/status-badge';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { middayIso } from '@/lib/navigation';
import { CatchUpButton, ExistingAccountsCard, ExistingPaperworkCard } from './paperwork';
import { Choice, fullName, memberBadge, MemberProfile, TeamRow, toReassign } from './types';

type Action = 'move' | 'reassign' | 'leave' | 'lastDay' | 'cancel' | 'removeNow' | 'title' | 'contact';
// The Eastern date, as the API uses to tell a notice from leaving today; the browser's own date could promise the wrong one.
const today = (at = Date.now()) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const NOTICE_MAX_DAYS = 90;
const noticeLimit = () => today(Date.now() + NOTICE_MAX_DAYS * 86400_000);
const LastDay = ({ day }: { day: string }) => <LocalTime iso={middayIso(day)} format="date" />;
// One reachable way to contact the dispatcher: where it came from, and a copy button.
function ContactRow({ icon: Icon, value, source, action }: { icon: typeof Mail; value: string; source: string; action?: React.ReactNode }) {
  return <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
    <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{value}</p><p className="text-[13px] text-muted-foreground">{source}</p></div>
    <span className="flex shrink-0 items-center gap-1"><CopyButton text={value} label="Copy" size="sm" variant="ghost" />{action}</span>
  </li>;
}

/**
 * One dispatcher (a record, no login), for every dispatch manager and administrator: the approved application details,
 * every way to reach them (company accounts, application contacts and ones staff added), signed documents, IT setup
 * progress, and where they work now and before. Moves and departures add history; nothing is overwritten.
 */
export function MemberProfileView({ member, mcs, teams, jobTitles, dispatchers = [], dispatchersFailed = false }: { member: MemberProfile; mcs: Choice[]; teams: TeamRow[]; jobTitles: Choice[];
  dispatchers?: { id: string; name: string; mc: string | null; team: string | null }[]; dispatchersFailed?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [action, setAction] = useState<Action | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [mcId, setMcId] = useState(member.current?.mcId ?? '');
  const [kind, setKind] = useState<'EMAIL' | 'PHONE'>('PHONE');
  const [emailAfter, setEmailAfter] = useState<'FORWARD' | 'SUSPEND'>('FORWARD');
  const [lastDay, setLastDay] = useState(today());
  const [removing, setRemoving] = useState<{ id: string; value: string } | null>(null);
  const name = fullName(member), open = member.status !== 'LEFT', current = member.current, details = member.details, accounts = member.accounts;
  const badge = memberBadge(member.status);
  // A support works where their dispatcher works and has no IT setup; their dispatcher changes instead of moving.
  const support = member.position === 'SUPPORT', supportOf = member.supportOf ?? null;
  const teamChoices = teams.filter(team => !team.archived && team.mc.id === mcId);
  function start(next: Action) { setAction(next); setError(''); setMcId(member.current?.mcId ?? ''); setLastDay(next === 'lastDay' && member.notice ? member.notice.lastDay : today()); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !action) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPending('form'); setError('');
    try {
      if (action === 'reassign') await mutate(`dispatch/members/${member.id}/reassign`, 'POST', { version: member.version, dispatcherId: form.dispatcherId, startedAt: form.startedAt, reason: form.reason });
      else if (action === 'move') await mutate(`dispatch/members/${member.id}/move`, 'POST', { version: member.version, mcId: form.mcId || null, teamId: form.teamId || null, startedAt: form.startedAt, reason: form.reason });
      // The email choice goes only when IT has accounts to remove, so an older API never sees it otherwise.
      else if (action === 'leave') await mutate(`dispatch/members/${member.id}/leave`, 'POST', { version: member.version, leftAt: form.leftAt, reason: form.reason, ...(removesAccess && (accounts?.companyEmail || member.existing?.companyEmail) ? { emailAfter } : {}) });
      else if (action === 'lastDay') await mutate(`dispatch/members/${member.id}/last-day`, 'POST', { version: member.version, lastDay: form.lastDay, reason: form.reason });
      else if (action === 'cancel') await mutate(`dispatch/members/${member.id}/cancel-notice`, 'POST', { version: member.version, reason: form.reason });
      else if (action === 'removeNow') await mutate(`dispatch/members/${member.id}/remove-access`, 'POST', { version: member.version, reason: form.reason });
      else if (action === 'title') await mutate(`dispatch/members/${member.id}`, 'PATCH', { version: member.version, jobTitleId: form.jobTitleId || null });
      else await mutate(`dispatch/members/${member.id}/contacts`, 'POST', { kind, value: form.value, ...(form.label?.trim() ? { label: form.label } : {}) });
      toast({ title: action === 'reassign' ? 'Dispatcher changed' : action === 'move' ? `${name} moved` : action === 'leave' ? (lastDay > today() ? `Notice recorded for ${name}` : `${name} marked as left`) : action === 'lastDay' ? 'Last day changed' : action === 'cancel' ? 'Notice cancelled' : action === 'removeNow' ? 'IT was asked to remove access now' : action === 'title' ? 'Job title updated' : kind === 'EMAIL' ? 'Email added' : 'Phone number added' });
      setAction(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(null); }
  }
  async function removeContact(id: string) {
    if (pending) return;
    setPending(id);
    try { await mutate(`dispatch/members/${member.id}/contacts/${id}/remove`, 'POST', {}); setRemoving(null); toast({ title: 'Contact removed' }); router.refresh(); }
    catch (error) { setRemoving(null); toast({ tone: 'danger', title: 'Not removed', description: errorMessage(error, 'Reload the page and try again.') }); }
    finally { setPending(null); }
  }
  const where = (row: { mc: string | null; team: string | null }) => row.mc ? `${row.mc}${row.team ? ` · ${row.team}` : ''}` : 'Independent';
  const progress = accounts?.total ? <Progress label="IT setup" value={accounts.done ?? 0} max={accounts.total} /> : null;
  // Someone with IT setup (finished or not) gets an IT removal checklist when marked as left; supports never had accounts.
  const existing = member.existing ?? null;
  // Added by hand: a dispatcher always gets a checklist, a support only when accounts were recorded for them.
  const recordedAccounts = existing && (!support || existing.companyEmail || existing.ringCentralNumber) ? { companyEmail: existing.companyEmail, ringCentralNumber: existing.ringCentralNumber } : null;
  const removesAccess = (!support && !!accounts) || !!recordedAccounts, removal = member.removal ?? null;
  const removalOpen = !!removal && !removal.completedAt, notice = member.notice ?? null, onNotice = open && !!notice;
  const drivers = member.driversToReassign ?? [], supportsLeft = member.supports ?? [], reassign = toReassign(drivers.length, supportsLeft.length), anyoneLeft = drivers.length + supportsLeft.length > 0;
  const noticeDay = lastDay > today();
  const emailNow = removal?.tasks.find(task => task.key === 'GOOGLE_WORKSPACE')?.status === 'COMPLETED'
    ? (removal.emailAfter === 'FORWARD' ? `suspended and forwarded to ${removal.forwardTo ?? 'the manager'} for 30 days` : 'suspended') : null;
  return <div className="space-y-6">
    <PageCrumb label={name} />
    <div className="flex flex-wrap items-start gap-4">
      {member.photo ? <a href={`/api/backend/dispatch/members/${member.id}/photos/selfie`} target="_blank" rel="noopener" className="shrink-0 rounded-lg focus-visible:outline-2" title="Open the photo full size">
        <PrivateImage src={`/api/backend/dispatch/members/${member.id}/photos/selfie`} alt={`Profile photo of ${name}`} className="size-24 rounded-lg border object-cover sm:size-28" /></a> : <Avatar name={name} size="lg" />}
      <div className="min-w-0 flex-1"><PageHeader title={name} badge={<span className="flex flex-wrap gap-2"><Badge label={badge.label} tone={badge.tone} />{existing && <Badge label="Added by hand" tone="neutral" />}{notice && <Badge label={notice.passed ? 'Last day passed' : `Leaving ${new Date(middayIso(notice.lastDay)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`} tone={notice.passed ? 'danger' : 'warning'} />}</span>}
        meta={[support ? (supportOf ? <>Support for {supportOf.dispatcher} · {where(supportOf)}</> : member.leftAt ? <>Left <LocalTime iso={member.leftAt} format="date" /></> : 'No dispatcher')
          : current ? <>{where(current)} since <LocalTime iso={current.startedAt} format="date" /></> : member.leftAt ? <>Left <LocalTime iso={member.leftAt} format="date" /></> : 'No MC or team',
          member.leadOf ? `Team lead of ${member.leadOf.name}` : member.position === 'SUPPORT' ? 'Support' : member.jobTitle?.name ?? 'Dispatcher',
          notice ? <>Last day <LastDay day={notice.lastDay} /></> : existing ? <>Started <LocalTime iso={member.joinedAt} format="date" /></> : <>Approved <LocalTime iso={member.joinedAt} format="date" /></>]}
        action={open && <div className="flex flex-wrap gap-2 max-sm:w-full max-sm:[&>*]:w-full">
          {existing && !existing.acceptedAt && existing.personalEmail && !existing.catchUp?.started && <CatchUpButton member={member} />}
          {onNotice ? <><Button variant="outline" onClick={() => start('lastDay')}><Calendar aria-hidden="true" className="size-4" />Change last day</Button>
            <DropdownMenu label="More actions" triggerIcon={Ellipsis} align="end" items={[{ label: 'Cancel notice', icon: RotateCcw, onSelect: () => start('cancel') },
              ...(removalOpen && !removal?.removeNowAt ? [{ label: 'Remove access now', icon: Ban, danger: true, onSelect: () => start('removeNow') }] : [])]} /></>
            : <Button variant="outline" onClick={() => start('leave')}><UserMinus aria-hidden="true" className="size-4" />Mark as leaving</Button>}
          {support ? <Button onClick={() => start('reassign')}><Route aria-hidden="true" className="size-4" />Change dispatcher</Button>
            : !onNotice && <Button onClick={() => start('move')}><Route aria-hidden="true" className="size-4" />Move to another MC or team</Button>}</div>} /></div>
    </div>
    {notice && (notice.passed ? <Alert tone="danger" title="Their last day has passed"><p>{anyoneLeft ? `${reassign} still assigned, so this record stays Leaving until they’re reassigned, then it becomes Left automatically. ` : 'They’ll be marked as left within a few minutes. '}IT’s removal of their access doesn’t wait for this.</p></Alert>
      : anyoneLeft ? <Alert tone="warning" title={<>{reassign} to reassign by <LastDay day={notice.lastDay} /></>}><p>{name} can’t be marked as left while anyone is still with them. IT removes their access at the end of that day either way.</p></Alert>
      : <Alert tone="info" title={<>Leaving <LastDay day={notice.lastDay} /></>}><p>Everyone is reassigned. The workspace marks them as left once that day has passed.</p></Alert>)}
    {open && member.signInOff && !notice?.passed && !removal?.removeNowAt && <Alert tone="warning" title="Their team lead sign-in is off"><p>If they’re still working as a team lead, an administrator can turn it back on in Staff accounts.</p></Alert>}
    {member.status === 'ONBOARDING' && <Alert tone="info" title="Waiting for IT setup"><p>This dispatcher becomes Active when IT finishes their company accounts{accounts?.total ? ` (${accounts.done} of ${accounts.total} tasks done)` : ''}.</p></Alert>}
    {member.status === 'LEFT' && (removal && removalOpen ? <Alert tone="warning" title={`IT is removing access: ${removal.done} of ${removal.total} done`}>
      <p>{emailNow ? `Company email ${emailNow}. ` : ''}The record and its history are kept; it can’t be moved or edited.</p></Alert>
      : <Alert tone="info" title="This dispatcher has left"><p>{removal?.completedAt ? <>IT removed their access <LocalTime iso={removal.completedAt} format="date" />. </> : null}The record and its history are kept. It can’t be moved or edited.</p></Alert>)}
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <div className="min-w-0">
        <Tabs label="Dispatcher sections" defaultValue="overview" items={[{ key: 'overview', label: 'Overview' }, { key: 'files', label: 'Photos and documents', count: (member.photo ? 1 : 0) + (member.idPhoto ? 1 : 0) + (member.documents?.length ?? 0) }, { key: 'history', label: 'History' }]}
          panels={{
            overview: <div className="space-y-6">
            {notice && anyoneLeft && <Card><CardHeader title="Still to reassign" description="Move each one to another dispatcher before the last day." />
              <ul className="mt-3 divide-y divide-border border-t border-border">
                {drivers.map(driver => <li key={driver.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"><span className="min-w-0"><span className="block text-sm font-medium">{driver.name}</span><span className="text-[13px] text-muted-foreground">Driver{driver.truck ? ` · truck ${driver.truck}` : ''}</span></span>
                  <Button asChild size="sm" variant="outline"><Link href="/dispatch/drivers?status=ASSIGNED">Change dispatcher<span className="sr-only"> for {driver.name}</span></Link></Button></li>)}
                {supportsLeft.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"><span className="min-w-0"><span className="block text-sm font-medium">{row.name}</span><span className="text-[13px] text-muted-foreground">Support</span></span>
                  <Button asChild size="sm" variant="outline"><Link href={`/dispatch/dispatchers/${row.id}`}>Reassign<span className="sr-only"> {row.name}</span></Link></Button></li>)}
              </ul></Card>}
            {notice && <Card><CardHeader title="Why they’re leaving" /><CardBody className="space-y-1"><p className="whitespace-pre-wrap text-sm">{notice.reason}</p>
              <p className="text-[13px] text-muted-foreground">Notice recorded{notice.recordedBy ? ` by ${notice.recordedBy}` : ''} on <LocalTime iso={notice.createdAt} format="date" />.</p>
              {removal?.removeNowAt && <p className="pt-2 text-sm"><span className="font-medium">Access removal requested <LocalTime iso={removal.removeNowAt} format="date" />:</span> {removal.removeNowReason}</p>}</CardBody></Card>}
            {member.status === 'LEFT' && member.leftReason && <Card><CardHeader title="Why they left" />
              <CardBody className="space-y-1"><p className="whitespace-pre-wrap text-sm">{member.leftReason}</p>
                {(member.leftBy || member.leftAt) && <p className="text-[13px] text-muted-foreground">Marked as left{member.leftBy ? ` by ${member.leftBy}` : ''}{member.leftAt ? <> on <LocalTime iso={member.leftAt} format="date" /></> : null}.</p>}</CardBody></Card>}
            {existing && <ExistingPaperworkCard member={member} />}
            {details && <Card>
              <CardHeader title="Personal details" description={<>From the approved application{details.submittedAt ? <>, last submitted <LocalTime iso={details.submittedAt} format="date" /></> : null}.</>} />
              <CardBody><DescriptionList items={[
                { label: 'First name', value: details.legalFirstName }, { label: 'Last name', value: details.legalLastName },
                { label: 'American first name', value: details.preferredAmericanFirstName }, { label: 'American last name', value: details.preferredAmericanLastName },
                { label: 'Telegram', value: details.telegram ? `@${details.telegram.replace(/^@/, '')}` : null },
                ...(support || existing ? [] : [{ label: 'Employment on the application', value: [details.jobTitle, details.mcName, details.teamLead].filter(Boolean).join(' · ') || null }])]} /></CardBody>
            </Card>}
                <Card>
              <CardHeader title="Contacts" description="Every way to reach this dispatcher." actions={open && <Button size="sm" variant="outline" onClick={() => start('contact')}><Plus aria-hidden="true" className="size-4" />Add email or phone</Button>} />
              <ul className="mt-3 divide-y divide-border border-t border-border">
                {accounts?.companyEmail && <ContactRow icon={Mail} value={accounts.companyEmail} source="Company email (IT)" />}
                {accounts?.workPhone && <ContactRow icon={Phone} value={accounts.workPhone} source="Work phone, RingCentral (IT)" />}
                {existing?.personalEmail && existing.personalEmail !== details?.personalEmail && <ContactRow icon={Mail} value={existing.personalEmail} source="Personal email (recorded by a manager)" />}
                {existing?.personalPhone && existing.personalPhone !== details?.personalPhoneNumber && <ContactRow icon={Phone} value={existing.personalPhone} source="Personal phone (recorded by a manager)" />}
                {details?.personalEmail && <ContactRow icon={Mail} value={details.personalEmail} source="Personal email (application)" />}
                {details?.personalPhoneNumber && <ContactRow icon={Phone} value={details.personalPhoneNumber} source="Personal phone (application)" />}
                {(member.contacts ?? []).map(contact => <ContactRow key={contact.id} icon={contact.kind === 'EMAIL' ? Mail : Phone} value={contact.value}
                  source={`${contact.label ?? (contact.kind === 'EMAIL' ? 'Email' : 'Phone')} · added${contact.addedBy ? ` by ${contact.addedBy}` : ''}`}
                  action={open && <Button size="sm" variant="ghost" className="text-danger" disabled={!!pending} onClick={() => setRemoving({ id: contact.id, value: contact.value })}>Remove<span className="sr-only"> {contact.value}</span></Button>} />)}
                {!accounts?.companyEmail && !accounts?.workPhone && !details?.personalEmail && !details?.personalPhoneNumber && !existing?.personalEmail && !existing?.personalPhone && !member.contacts?.length &&
                  <li className="px-4 py-4 text-sm text-muted-foreground sm:px-5">No contacts yet.</li>}
              </ul>
            </Card>
                </div>,
            files: <div className="space-y-6">
              {(member.photo || member.idPhoto) && <Card><CardHeader title="Photos" description="As the applicant sent them. Open a photo to see it full size." />
                <CardBody><div className="grid max-w-md grid-cols-2 gap-4">
                  {member.photo && <figure className="space-y-2"><a href={`/api/backend/dispatch/members/${member.id}/photos/selfie`} target="_blank" rel="noopener" className="block rounded-md focus-visible:outline-2">
              <PrivateImage src={`/api/backend/dispatch/members/${member.id}/photos/selfie`} alt={`Selfie of ${name}`} className="aspect-[4/5] w-full rounded-md border bg-muted object-cover" /></a>
              <figcaption className="text-[13px] leading-5"><span className="font-medium">Selfie</span><span className="block text-muted-foreground">Also the profile photo.</span></figcaption></figure>}
                  {member.idPhoto && <figure className="space-y-2"><a href={`/api/backend/dispatch/members/${member.id}/photos/id-selfie`} target="_blank" rel="noopener" className="block rounded-md focus-visible:outline-2">
              <PrivateImage src={`/api/backend/dispatch/members/${member.id}/photos/id-selfie`} alt={`Selfie of ${name} holding an ID`} className="aspect-[4/5] w-full rounded-md border bg-muted object-cover" /></a>
              <figcaption className="text-[13px] leading-5"><span className="font-medium">Selfie holding an ID</span><span className="block text-muted-foreground">Visible to the responsible manager and administrators only.</span></figcaption></figure>}
                </div></CardBody></Card>}
            {member.documents && member.documents.length > 0 && <Card>
              <CardHeader title="Signed documents" />
              <ul className="mt-3 divide-y divide-border border-t border-border">{member.documents.map(doc => <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <span className="flex min-w-0 items-center gap-3"><FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block text-sm font-medium">{doc.title}</span>
                  <span className="text-[13px] text-muted-foreground">Version {doc.version} · signed <LocalTime iso={doc.signedAt} format="date" /></span></span></span>
                <a className="text-sm text-primary underline-offset-4 hover:underline" href={`/api/backend/dispatch/members/${member.id}/documents/${doc.id}/signed`} target="_blank" rel="noopener">Open signed copy<span className="sr-only"> of {doc.title}</span></a>
              </li>)}</ul>
            </Card>}
                  {!member.photo && !member.idPhoto && !member.documents?.length && <p className="text-sm text-muted-foreground">No photos or signed documents.</p>}
            </div>,
            history: <div className="space-y-6">
            {!!member.noticeHistory?.length && <Card><CardHeader title="Notices" description="Last days that changed, and notices that were cancelled." />
              <CardBody><Timeline items={member.noticeHistory.flatMap(row => [
                ...(row.cancelledAt ? [{ id: `${row.id}-cancelled`, title: `Notice cancelled${row.cancelledBy ? ` by ${row.cancelledBy}` : ''}`, meta: <LocalTime iso={row.cancelledAt} />, body: row.cancelReason ?? undefined }] : []),
                ...[...row.changes].reverse().map((change, index) => ({ id: `${row.id}-${index}`, title: <>Last day changed to <LastDay day={change.to} /></>, meta: <>From <LastDay day={change.from} /> · <LocalTime iso={change.at} /></>, body: change.reason })),
                { id: row.id, title: `Notice recorded${row.recordedBy ? ` by ${row.recordedBy}` : ''}`, meta: <LocalTime iso={row.createdAt} />, body: row.reason }])} /></CardBody></Card>}
            {support && <Card>
              <CardHeader title="Dispatcher history" description="Every dispatcher this support has assisted. Changes are recorded, never overwritten." />
              <CardBody><Timeline items={(member.supportHistory ?? []).map(row => ({ id: row.id, tone: row.endedAt ? 'neutral' as const : 'success' as const, icon: <Users aria-hidden="true" />,
                title: `${row.dispatcher}${row.dispatcherStatus === 'LEFT' ? ' (left)' : ''}`,
                meta: <><LocalTime iso={row.startedAt} format="date" /> – {row.endedAt ? <LocalTime iso={row.endedAt} format="date" /> : 'today'}{row.changedBy ? ` · by ${row.changedBy}` : ''}</>, body: row.reason ?? undefined }))} /></CardBody>
            </Card>}
            {!support && <Card>
              <CardHeader title="MC and team history" description="Every MC and team this dispatcher has worked for. Moves are recorded, never overwritten." />
              <CardBody><Timeline items={member.history.map((row, index) => ({ id: row.id, tone: row.endedAt ? 'neutral' as const : 'success' as const,
                icon: index < member.history.length - 1 && member.history[index + 1].mcId === row.mcId ? <Users aria-hidden="true" /> : <Building2 aria-hidden="true" />,
                title: where(row), meta: <><LocalTime iso={row.startedAt} format="date" /> – {row.endedAt ? <LocalTime iso={row.endedAt} format="date" /> : 'today'}{row.movedBy ? ` · by ${row.movedBy}` : ''}</>,
                body: row.reason ?? undefined }))} /></CardBody>
            </Card>}
                  {member.activity && member.activity.length > 0 && <Card><CardHeader title="Onboarding" description="From the invitation to IT setup." />
                <CardBody><Timeline items={[...member.activity].reverse().map(item => ({ id: item.id, title: statusLabel(item.event), meta: <LocalTime iso={item.createdAt} /> }))} /></CardBody></Card>}
            </div>,
          }} />
      </div>
      <div className="min-w-0 space-y-6 xl:sticky xl:top-20">
        {support ? <Card>
          <CardHeader title="Now" />
          <CardBody><DescriptionList layout="rows" items={[
            { label: 'Supports', value: supportOf ? <Link href={`/dispatch/dispatchers/${supportOf.dispatcherId}`} className="text-primary underline-offset-4 hover:underline">{supportOf.dispatcher}</Link> : null, emptyLabel: 'No dispatcher' },
            { label: 'MC', value: supportOf ? supportOf.mc ?? 'Independent' : null, emptyLabel: '—' },
            { label: 'Team', value: supportOf?.team, emptyLabel: 'No team' },
            { label: 'Since', value: supportOf ? <LocalTime iso={supportOf.startedAt} format="date" /> : null, emptyLabel: '—' }]} /></CardBody>
        </Card> : <Card>
          <CardHeader title="Now" actions={open && <Button variant="ghost" size="sm" onClick={() => start('title')}>Change job title</Button>} />
          <CardBody><DescriptionList layout="rows" items={[
            { label: 'MC', value: current?.mc ? `${current.mc}${current.mcNumber ? ` · MC ${current.mcNumber}` : ''}` : current ? 'Independent' : null, emptyLabel: 'None' },
            { label: 'Team', value: current?.team, emptyLabel: 'No team' },
            { label: 'Job title', value: member.jobTitle?.name, emptyLabel: 'Not set' },
            { label: 'Since', value: current ? <LocalTime iso={current.startedAt} format="date" /> : null, emptyLabel: '—' }]} /></CardBody>
        </Card>}
        {!support && !!member.supports?.length && <Card>
          <CardHeader title="Supports" description="Updaters who assist this dispatcher." />
          <ul className="mt-3 divide-y divide-border border-t border-border">{member.supports.map(row => <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
            <Link href={`/dispatch/dispatchers/${row.id}`} className="min-w-0 text-sm font-medium text-primary underline-offset-4 hover:underline">{row.name}</Link>
            <span className="shrink-0 text-[13px] text-muted-foreground">since <LocalTime iso={row.since} format="date" /></span></li>)}</ul>
        </Card>}
        {removal?.scheduled && <Card>
          <CardHeader title="IT access" actions={<Badge label="Scheduled" tone="info" />} />
          <CardBody className="text-sm"><DescriptionList layout="rows" items={[
            { label: 'Company email', value: <>Working until <LastDay day={removal.dueOn} /></> }, { label: 'RingCentral', value: <>Working until <LastDay day={removal.dueOn} /></> },
            { label: 'Email afterwards', value: removal.emailAfter === 'FORWARD' ? `Forward to ${removal.forwardTo ?? 'the manager'}, 30 days` : 'Suspend only' },
            { label: 'Remove', value: <>End of <LastDay day={removal.dueOn} /></> }]} /></CardBody></Card>}
        {notice && <Card><CardHeader title="On the last day" /><CardBody><p className="text-[13px] leading-5 text-muted-foreground">Once everyone is reassigned, the workspace marks {member.firstName} as left. A team lead sign-in ends then too. The workspace never messages the person leaving.</p></CardBody></Card>}
        {removal && !removal.scheduled && <Card>
          <CardHeader title="IT access" />
          <CardBody className="space-y-4 text-sm">
            <Progress label="Removal" value={removal.done} max={removal.total} />
            <DescriptionList layout="rows" items={[
              { label: 'Company email', value: emailNow ? emailNow[0].toUpperCase() + emailNow.slice(1) : removal.completedAt ? 'Removed' : 'Being removed' },
              { label: 'RingCentral', value: removal.tasks.find(task => task.key === 'RINGCENTRAL')?.status === 'COMPLETED' ? 'Removed' : 'Being removed' },
              { label: removal.completedAt ? 'Removed' : 'Remove by', value: <LocalTime iso={removal.completedAt ?? `${removal.dueOn}T12:00:00Z`} format="date" /> }]} />
          </CardBody>
        </Card>}
        {removalOpen && !removal?.scheduled && <Card><CardHeader title="When it’s done" /><CardBody><p className="text-[13px] leading-5 text-muted-foreground">You get a portal notice when IT finishes. The workspace never messages the person who left.</p></CardBody></Card>}
        {existing && !accounts && <ExistingAccountsCard member={member} open={open} />}
        {(!existing || accounts) && <Card>
          <CardHeader title={support ? 'Onboarding' : 'IT setup'} />
          <CardBody className="space-y-3 text-sm">
            {support ? <p className="text-muted-foreground">Supports need no IT setup or company accounts.</p>
              : !accounts ? <p className="text-muted-foreground">No IT setup request for this dispatcher.</p>
              : accounts.cancelledAt ? <p>Cancelled <LocalTime iso={accounts.cancelledAt} format="date" />: they left before setup finished.</p>
              : accounts.completedAt ? <p>Setup complete <LocalTime iso={accounts.completedAt} format="date" />.</p>
              : <><p>In progress. The dispatcher becomes Active when IT finishes.</p>{progress}</>}
            {member.canOpenApplication && member.applicationId && <Link href={`/onboarding/applications/${member.applicationId}`} className="inline-block text-primary underline-offset-4 hover:underline">Open onboarding record</Link>}
          </CardBody>
        </Card>}
        <p className="text-xs leading-5 text-muted-foreground">Dispatch managers and administrators see this record. Dispatchers don’t have accounts and never see the workspace.</p>
      </div>
    </div>
    {action && <Dialog open onClose={() => setAction(null)} busy={pending === 'form'} tone={action === 'leave' || action === 'removeNow' ? 'danger' : undefined} size={action === 'leave' && removesAccess ? 'lg' : undefined} closeLabel={action === 'cancel' ? 'Keep notice' : undefined}
      title={action === 'reassign' ? `Change ${name}’s dispatcher` : action === 'move' ? `Move ${name}` : action === 'leave' ? `Mark ${name} as leaving` : action === 'lastDay' ? `Change ${name}’s last day` : action === 'cancel' ? `Cancel ${name}’s notice?` : action === 'removeNow' ? `Remove ${name}’s access now?` : action === 'title' ? 'Change job title' : 'Add email or phone'}
      description={action === 'reassign' ? 'They start assisting the new dispatcher on the start date; the current one stays in the history.' : action === 'move' ? 'The current MC and team end on the start date and stay in the history.' : action === 'leave' ? 'Record the last day as soon as you know it. The record and its history are kept; leaving a team also ends being its lead.' : action === 'lastDay' ? 'IT’s checklist moves to the new date and shows that it changed.' : action === 'cancel' ? `${member.firstName} stays with no last day. The cancelled notice stays in their history.` : action === 'removeNow' ? 'Use this when they shouldn’t keep their accounts until their last day. It can’t be undone from here.' : action === 'contact' ? 'For another way to reach the dispatcher. Every manager can see it.' : undefined}
      actions={<Button type="submit" form="member-action" variant={action === 'leave' || action === 'removeNow' ? 'destructive' : 'default'}>{pending === 'form' ? 'Saving…' : action === 'reassign' ? 'Change dispatcher' : action === 'move' ? 'Move dispatcher' : action === 'leave' ? (noticeDay ? 'Record notice' : 'Mark as left') : action === 'lastDay' ? 'Change last day' : action === 'cancel' ? 'Cancel notice' : action === 'removeNow' ? 'Remove access now' : action === 'title' ? 'Save job title' : 'Add contact'}</Button>}>
      <form id="member-action" onSubmit={submit} className="space-y-4">
        {action === 'reassign' && <>
          {dispatchersFailed && <Alert tone="danger"><p>Couldn’t load dispatchers. Reload the page.</p></Alert>}
          <Select label="New dispatcher" name="dispatcherId" required placeholder="Choose a dispatcher" width="full"
            options={dispatchers.filter(option => option.id !== supportOf?.dispatcherId).map(option => ({ value: option.id, label: [option.name, option.mc ?? 'Independent', option.team].filter(Boolean).join(' · ') }))} />
          <Input label="Starts on" name="startedAt" type="date" required defaultValue={today()} max={today()} width="sm" />
          <Textarea label="Reason" name="reason" required maxLength={500} rows={3} hint="For the history, such as Blake needed help with updates." />
        </>}
        {action === 'move' && <>
          <Select label="MC" name="mcId" value={mcId} onChange={event => setMcId(event.target.value)} width="full"
            options={[{ value: '', label: 'Independent' }, ...mcs.filter(mc => !mc.archived).map(mc => ({ value: mc.id, label: mc.name }))]} />
          <Select key={mcId} label="Team" name="teamId" defaultValue={teamChoices.some(team => team.id === current?.teamId) ? current?.teamId ?? '' : ''} disabled={!mcId} placeholder="No team" width="full"
            options={teamChoices.map(team => ({ value: team.id, label: team.name }))} hint={!mcId ? 'Independent dispatchers have no team.' : teamChoices.length ? undefined : 'This MC has no teams yet.'} />
          {member.leadOf && <p className="rounded-md bg-warning-background px-3 py-2 text-sm text-warning">{name} leads {member.leadOf.name}. Moving to another team ends that.</p>}
          <Input label="Starts on" name="startedAt" type="date" required defaultValue={today()} max={today()} width="sm" />
          <Textarea label="Reason" name="reason" required maxLength={500} rows={3} hint="For the history, such as Lakeside needed more dispatchers." />
        </>}
        {action === 'leave' && <>
          <Input label="Last day" name="leftAt" type="date" required value={lastDay} onChange={event => setLastDay(event.target.value)} max={support || !accounts || accounts.completedAt ? noticeLimit() : today()} width="sm"
            hint={support || !accounts || accounts.completedAt ? `Up to ${NOTICE_MAX_DAYS} days ahead.` : 'Today or earlier: their IT setup isn’t finished.'} />
          <Textarea label={noticeDay ? 'Why they’re leaving' : 'Why they left'} name="reason" required maxLength={500} rows={2} hint="Staff only. Never health or other private details." />
          {noticeDay && <Alert tone="info" title={<>{member.firstName} stays {badge.label} until <LastDay day={lastDay} /></>}><p>They keep working, with their drivers and accounts, until the end of that day. Then the workspace marks them as left.</p></Alert>}
          {noticeDay && anyoneLeft && <Alert tone="warning" title={<>{reassign} to reassign by <LastDay day={lastDay} /></>}><p>You can do this during the notice. They can’t be marked as left until it’s done.</p></Alert>}
          {removesAccess && <Card><CardHeader title="IT removes their access" description={noticeDay ? 'IT gets the removal checklist and a Telegram alert now, so it can prepare.' : 'Mark as left starts an IT removal checklist and alerts the IT team on Telegram.'} />
            <CardBody className="space-y-4"><DescriptionList layout="rows" items={[
              { label: 'Company email', value: accounts?.companyEmail ?? recordedAccounts?.companyEmail, emptyLabel: recordedAccounts ? 'Not recorded' : 'None recorded' },
              { label: 'RingCentral number', value: accounts?.workPhone ?? recordedAccounts?.ringCentralNumber, mono: true, emptyLabel: recordedAccounts ? 'Not recorded' : 'None recorded' },
              { label: noticeDay ? 'Remove' : 'Remove by', value: noticeDay ? <>At the end of <LastDay day={lastDay} />, not before</> : 'End of their last day' }]} />
              {(accounts?.companyEmail || recordedAccounts?.companyEmail) && <RadioGroup name="emailAfter" label="Their company email" cards value={emailAfter} onChange={value => setEmailAfter(value as 'FORWARD' | 'SUSPEND')} options={[
                { value: 'FORWARD', label: 'Forward new email to me', description: 'IT suspends the account and forwards new email to you for 30 days.' },
                { value: 'SUSPEND', label: 'Just suspend it', description: 'New email bounces. IT keeps the mailbox until the retention rules say otherwise.' }]} />}
            </CardBody></Card>}
          {!noticeDay && <p className="text-[13px] leading-5 text-muted-foreground">A dispatcher with drivers or supports can’t be marked as left: reassign them first, or choose a later last day.</p>}
        </>}
        {action === 'lastDay' && <>
          <Input label="New last day" name="lastDay" type="date" required value={lastDay} onChange={event => setLastDay(event.target.value)} min={today()} max={noticeLimit()} width="sm" hint={<>Now <LastDay day={notice?.lastDay ?? today()} />. Today, or up to {NOTICE_MAX_DAYS} days ahead.</>} />
          <Textarea label="Why it changed" name="reason" required maxLength={500} rows={2} hint="Staff only. Never health or other private details." />
          <Alert tone="info"><p>Choosing today means they leave at the end of today, once everyone is reassigned.</p></Alert>
        </>}
        {action === 'cancel' && <>
          <Textarea label="Why they’re staying" name="reason" required maxLength={500} rows={2} hint="Staff only. Never health or other private details." />
          <Alert tone="info"><p>IT’s removal checklist is cancelled too. Once IT has started removing anything, or access removal was requested now, the notice can’t be cancelled: talk to IT.</p></Alert>
        </>}
        {action === 'removeNow' && <>
          <Textarea label="Why now" name="reason" required maxLength={500} rows={2} hint="Staff only. Never health or other private details." />
          <DescriptionList layout="rows" items={[{ label: 'IT', value: 'Removal due today; IT gets a Telegram alert now' }, { label: 'Team lead sign-in', value: 'Turned off now, if they have one' }, { label: 'Last day', value: <>Stays <LastDay day={notice?.lastDay ?? today()} /> until you change it</> }]} />
          {anyoneLeft && <Alert tone="warning" title={`Reassign their ${reassign}`}><p>{member.firstName} won’t be able to work with them without access. Removing access never waits for this.</p></Alert>}
        </>}
        {action === 'title' && <Select label="Job title" name="jobTitleId" defaultValue={member.jobTitle?.id ?? ''} placeholder="Not set" width="full"
          options={jobTitles.filter(title => !title.archived || title.id === member.jobTitle?.id).map(title => ({ value: title.id, label: title.name }))} />}
        {action === 'contact' && <>
          <Select label="Type" name="kind" value={kind} onChange={event => setKind(event.target.value as 'EMAIL' | 'PHONE')} width="sm" options={[{ value: 'PHONE', label: 'Phone number' }, { value: 'EMAIL', label: 'Email' }]} />
          <Input key={kind} label={kind === 'EMAIL' ? 'Email' : 'Phone number'} name="value" type={kind === 'EMAIL' ? 'email' : 'tel'} required maxLength={kind === 'EMAIL' ? 254 : 40} autoComplete="off" width="md"
            hint={kind === 'PHONE' ? 'Include the country code, such as +1 469 555 0181.' : undefined} />
          <Input label="Label" optional name="label" maxLength={50} autoComplete="off" width="md" hint="Such as Second phone or Spouse." />
        </>}
        <Notice message={error} error />
      </form>
    </Dialog>}
    {removing && <Dialog open size="sm" tone="danger" onClose={() => setRemoving(null)} busy={pending === removing.id} protectChanges={false} title="Remove this contact?"
      description="It no longer shows on this record. Who added and removed it, and when, are kept."
      actions={<Button variant="destructive" onClick={() => void removeContact(removing.id)}>{pending === removing.id ? 'Removing…' : 'Remove contact'}</Button>}>
      <p className="break-all text-sm font-medium">{removing.value}</p>
    </Dialog>}
  </div>;
}
