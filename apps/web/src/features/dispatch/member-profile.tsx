'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Building2, FileText, Mail, Phone, Plus, Route, UserMinus, Users } from 'lucide-react';
import { PageCrumb } from '@/components/shell-context';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { DescriptionList } from '@/components/ui/description-list';
import { Progress } from '@/components/ui/feedback';
import { Input, Select, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PrivateImage } from '@/components/ui/private-image';
import { Timeline } from '@/components/ui/timeline';
import { Badge, statusLabel } from '@/components/ui/status-badge';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { Choice, fullName, memberBadge, MemberProfile, TeamRow } from './types';

type Action = 'move' | 'reassign' | 'leave' | 'title' | 'contact';
const today = () => new Date().toLocaleDateString('en-CA');
// One reachable way to contact the dispatcher: where it came from, and a copy button.
function ContactRow({ icon: Icon, value, source, action }: { icon: typeof Mail; value: string; source: string; action?: React.ReactNode }) {
  return <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
    <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{value}</p><p className="text-[13px] text-muted-foreground">{source}</p></div>
    <span className="flex shrink-0 items-center gap-1"><CopyButton text={value} label="Copy" size="sm" variant="ghost" />{action}</span>
  </li>;
}

/**
 * One dispatcher (a record, no login), for every dispatcher manager and administrator: the approved application details,
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
  const [removing, setRemoving] = useState<{ id: string; value: string } | null>(null);
  const name = fullName(member), open = member.status !== 'LEFT', current = member.current, details = member.details, accounts = member.accounts;
  const badge = memberBadge(member.status);
  // A support works where their dispatcher works and has no IT setup; their dispatcher changes instead of moving.
  const support = member.position === 'SUPPORT', supportOf = member.supportOf ?? null;
  const teamChoices = teams.filter(team => !team.archived && team.mc.id === mcId);
  function start(next: Action) { setAction(next); setError(''); setMcId(member.current?.mcId ?? ''); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !action) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPending('form'); setError('');
    try {
      if (action === 'reassign') await mutate(`dispatch/members/${member.id}/reassign`, 'POST', { version: member.version, dispatcherId: form.dispatcherId, startedAt: form.startedAt, reason: form.reason });
      else if (action === 'move') await mutate(`dispatch/members/${member.id}/move`, 'POST', { version: member.version, mcId: form.mcId || null, teamId: form.teamId || null, startedAt: form.startedAt, reason: form.reason });
      else if (action === 'leave') await mutate(`dispatch/members/${member.id}/leave`, 'POST', { version: member.version, leftAt: form.leftAt, reason: form.reason });
      else if (action === 'title') await mutate(`dispatch/members/${member.id}`, 'PATCH', { version: member.version, jobTitleId: form.jobTitleId || null });
      else await mutate(`dispatch/members/${member.id}/contacts`, 'POST', { kind, value: form.value, ...(form.label?.trim() ? { label: form.label } : {}) });
      toast({ title: action === 'reassign' ? 'Dispatcher changed' : action === 'move' ? `${name} moved` : action === 'leave' ? `${name} marked as left` : action === 'title' ? 'Job title updated' : kind === 'EMAIL' ? 'Email added' : 'Phone number added' });
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
  return <div className="space-y-6">
    <PageCrumb label={name} />
    <div className="flex flex-wrap items-start gap-4">
      {member.photo ? <a href={`/api/backend/dispatch/members/${member.id}/photos/selfie`} target="_blank" rel="noopener" className="shrink-0 rounded-lg focus-visible:outline-2" title="Open the photo full size">
        <PrivateImage src={`/api/backend/dispatch/members/${member.id}/photos/selfie`} alt={`Profile photo of ${name}`} className="size-24 rounded-lg border object-cover sm:size-28" /></a> : <Avatar name={name} size="lg" />}
      <div className="min-w-0 flex-1"><PageHeader title={name} badge={<Badge label={badge.label} tone={badge.tone} />}
        meta={[support ? (supportOf ? <>Support for {supportOf.dispatcher} · {where(supportOf)}</> : member.leftAt ? <>Left <LocalTime iso={member.leftAt} format="date" /></> : 'No dispatcher')
          : current ? <>{where(current)} since <LocalTime iso={current.startedAt} format="date" /></> : member.leftAt ? <>Left <LocalTime iso={member.leftAt} format="date" /></> : 'No MC or team',
          member.leadOf ? `Team lead of ${member.leadOf.name}` : member.position === 'SUPPORT' ? 'Support' : member.jobTitle?.name ?? 'Dispatcher',
          <>Approved <LocalTime iso={member.joinedAt} format="date" /></>]}
        action={open && <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => start('leave')}><UserMinus aria-hidden="true" className="size-4" />Mark as left</Button>
          {support ? <Button onClick={() => start('reassign')}><Route aria-hidden="true" className="size-4" />Change dispatcher</Button>
            : <Button onClick={() => start('move')}><Route aria-hidden="true" className="size-4" />Move to another MC or team</Button>}</div>} /></div>
    </div>
    {member.status === 'ONBOARDING' && <Alert tone="info" title="Waiting for IT setup"><p>This dispatcher becomes Active when IT finishes their company accounts{accounts?.total ? ` (${accounts.done} of ${accounts.total} tasks done)` : ''}.</p></Alert>}
    {member.status === 'LEFT' && <Alert tone="info" title="This dispatcher has left"><p>The record and its history are kept. It can’t be moved or edited.</p></Alert>}
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <div className="min-w-0">
        <Tabs label="Dispatcher sections" defaultValue="overview" items={[{ key: 'overview', label: 'Overview' }, { key: 'files', label: 'Photos and documents', count: (member.photo ? 1 : 0) + (member.idPhoto ? 1 : 0) + (member.documents?.length ?? 0) }, { key: 'history', label: 'History' }]}
          panels={{
            overview: <div className="space-y-6">
            {details && <Card>
              <CardHeader title="Personal details" description={<>From the approved application{details.submittedAt ? <>, last submitted <LocalTime iso={details.submittedAt} format="date" /></> : null}.</>} />
              <CardBody><DescriptionList items={[
                { label: 'First name', value: details.legalFirstName }, { label: 'Last name', value: details.legalLastName },
                { label: 'American first name', value: details.preferredAmericanFirstName }, { label: 'American last name', value: details.preferredAmericanLastName },
                { label: 'Telegram', value: details.telegram ? `@${details.telegram.replace(/^@/, '')}` : null },
                ...(support ? [] : [{ label: 'Employment on the application', value: [details.jobTitle, details.mcName, details.teamLead].filter(Boolean).join(' · ') || null }])]} /></CardBody>
            </Card>}
                <Card>
              <CardHeader title="Contacts" description="Every way to reach this dispatcher." actions={open && <Button size="sm" variant="outline" onClick={() => start('contact')}><Plus aria-hidden="true" className="size-4" />Add email or phone</Button>} />
              <ul className="mt-3 divide-y divide-border border-t border-border">
                {accounts?.companyEmail && <ContactRow icon={Mail} value={accounts.companyEmail} source="Company email (IT)" />}
                {accounts?.workPhone && <ContactRow icon={Phone} value={accounts.workPhone} source="Work phone, RingCentral (IT)" />}
                {details?.personalEmail && <ContactRow icon={Mail} value={details.personalEmail} source="Personal email (application)" />}
                {details?.personalPhoneNumber && <ContactRow icon={Phone} value={details.personalPhoneNumber} source="Personal phone (application)" />}
                {(member.contacts ?? []).map(contact => <ContactRow key={contact.id} icon={contact.kind === 'EMAIL' ? Mail : Phone} value={contact.value}
                  source={`${contact.label ?? (contact.kind === 'EMAIL' ? 'Email' : 'Phone')} · added${contact.addedBy ? ` by ${contact.addedBy}` : ''}`}
                  action={open && <Button size="sm" variant="ghost" className="text-danger" disabled={!!pending} onClick={() => setRemoving({ id: contact.id, value: contact.value })}>Remove<span className="sr-only"> {contact.value}</span></Button>} />)}
                {!accounts?.companyEmail && !accounts?.workPhone && !details?.personalEmail && !details?.personalPhoneNumber && !member.contacts?.length &&
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
        <Card>
          <CardHeader title={support ? 'Onboarding' : 'IT setup'} />
          <CardBody className="space-y-3 text-sm">
            {support ? <p className="text-muted-foreground">Supports need no IT setup or company accounts.</p>
              : !accounts ? <p className="text-muted-foreground">No IT setup request for this dispatcher.</p>
              : accounts.completedAt ? <p>Setup complete <LocalTime iso={accounts.completedAt} format="date" />.</p>
              : <><p>In progress. The dispatcher becomes Active when IT finishes.</p>{progress}</>}
            {member.canOpenApplication && member.applicationId && <Link href={`/onboarding/applications/${member.applicationId}`} className="inline-block text-primary underline-offset-4 hover:underline">Open onboarding record</Link>}
          </CardBody>
        </Card>
        <p className="text-xs leading-5 text-muted-foreground">Dispatcher managers and administrators see this record. Dispatchers don’t have accounts and never see the workspace.</p>
      </div>
    </div>
    {action && <Dialog open onClose={() => setAction(null)} busy={pending === 'form'} tone={action === 'leave' ? 'warning' : undefined}
      title={action === 'reassign' ? `Change ${name}’s dispatcher` : action === 'move' ? `Move ${name}` : action === 'leave' ? `Mark ${name} as left?` : action === 'title' ? 'Change job title' : 'Add email or phone'}
      description={action === 'reassign' ? 'They start assisting the new dispatcher on the start date; the current one stays in the history.' : action === 'move' ? 'The current MC and team end on the start date and stay in the history.' : action === 'leave' ? 'The record and its history are kept. Leaving a team also ends being its lead.' : action === 'contact' ? 'For another way to reach the dispatcher. Every manager can see it.' : undefined}
      actions={<Button type="submit" form="member-action" variant={action === 'leave' ? 'destructive' : 'default'}>{pending === 'form' ? 'Saving…' : action === 'reassign' ? 'Change dispatcher' : action === 'move' ? 'Move dispatcher' : action === 'leave' ? 'Mark as left' : action === 'title' ? 'Save job title' : 'Add contact'}</Button>}>
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
          <Input label="Last day" name="leftAt" type="date" required defaultValue={today()} max={today()} width="sm" />
          <Textarea label="Reason" name="reason" required maxLength={500} rows={3} hint="Kept with the record. Don’t include personal details." />
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
