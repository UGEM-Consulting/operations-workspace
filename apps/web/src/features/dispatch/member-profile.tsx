'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Building2, Route, UserMinus, Users } from 'lucide-react';
import { PageCrumb } from '@/components/shell-context';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { DescriptionList } from '@/components/ui/description-list';
import { Input, Select, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Timeline } from '@/components/ui/timeline';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { Choice, fullName, MemberProfile, TeamRow } from './types';

type Action = 'move' | 'leave' | 'title';
const today = () => new Date().toLocaleDateString('en-CA');

/**
 * One dispatcher (a record, no login): where they work now, every MC and team before, and their company accounts.
 * Moves and departures add history; nothing is overwritten. Moving out of a team ends being its lead.
 */
export function MemberProfileView({ member, mcs, teams, jobTitles }: { member: MemberProfile; mcs: Choice[]; teams: TeamRow[]; jobTitles: Choice[] }) {
  const router = useRouter();
  const toast = useToast();
  const [action, setAction] = useState<Action | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [mcId, setMcId] = useState(member.current?.mcId ?? '');
  const name = fullName(member), active = member.status === 'ACTIVE', current = member.current;
  const teamChoices = teams.filter(team => !team.archived && team.mc.id === mcId);
  function open(next: Action) { setAction(next); setError(''); setMcId(member.current?.mcId ?? ''); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !action) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPending(true); setError('');
    try {
      if (action === 'move') await mutate(`dispatch/members/${member.id}/move`, 'POST', { version: member.version, mcId: form.mcId || null, teamId: form.teamId || null, startedAt: form.startedAt, reason: form.reason });
      else if (action === 'leave') await mutate(`dispatch/members/${member.id}/leave`, 'POST', { version: member.version, leftAt: form.leftAt, reason: form.reason });
      else await mutate(`dispatch/members/${member.id}`, 'PATCH', { version: member.version, jobTitleId: form.jobTitleId || null });
      toast({ title: action === 'move' ? `${name} moved` : action === 'leave' ? `${name} marked as left` : 'Job title updated' });
      setAction(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  const where = (row: { mc: string | null; team: string | null }) => row.mc ? `${row.mc}${row.team ? ` · ${row.team}` : ''}` : 'Independent';
  return <div className="space-y-6">
    <PageCrumb label={name} />
    <div className="flex flex-wrap items-start gap-4">
      <Avatar name={name} size="lg" />
      <div className="min-w-0 flex-1"><PageHeader title={name} badge={<Badge label={active ? 'Active' : 'Left'} tone={active ? 'success' : 'neutral'} />}
        meta={[current ? <>{where(current)} since <LocalTime iso={current.startedAt} format="date" /></> : member.leftAt ? <>Left <LocalTime iso={member.leftAt} format="date" /></> : 'No MC or team',
          member.leadOf ? `Team lead of ${member.leadOf.name}` : member.position === 'SUPPORT' ? 'Support' : 'Dispatcher',
          <>Joined <LocalTime iso={member.joinedAt} format="date" /></>]}
        action={active && <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => open('leave')}><UserMinus aria-hidden="true" className="size-4" />Mark as left</Button>
          <Button onClick={() => open('move')}><Route aria-hidden="true" className="size-4" />Move to another MC or team</Button></div>} /></div>
    </div>
    {!active && <Alert tone="info" title="This dispatcher has left"><p>The record and its history are kept. It can’t be moved or edited.</p></Alert>}
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <Card>
        <CardHeader title="MC and team history" description="Every MC and team this dispatcher has worked for. Moves are recorded, never overwritten." />
        <CardBody><Timeline items={member.history.map((row, index) => ({ id: row.id, tone: row.endedAt ? 'neutral' as const : 'success' as const,
          icon: index < member.history.length - 1 && member.history[index + 1].mcId === row.mcId ? <Users aria-hidden="true" /> : <Building2 aria-hidden="true" />,
          title: where(row), meta: <><LocalTime iso={row.startedAt} format="date" /> – {row.endedAt ? <LocalTime iso={row.endedAt} format="date" /> : 'today'}{row.movedBy ? ` · by ${row.movedBy}` : ''}</>,
          body: row.reason ?? undefined }))} /></CardBody>
      </Card>
      <div className="min-w-0 space-y-6 xl:sticky xl:top-20">
        <Card>
          <CardHeader title="Now" actions={active && <Button variant="ghost" size="sm" onClick={() => open('title')}>Change job title</Button>} />
          <CardBody><DescriptionList layout="rows" items={[
            { label: 'MC', value: current?.mc ? `${current.mc}${current.mcNumber ? ` · MC ${current.mcNumber}` : ''}` : current ? 'Independent' : null, emptyLabel: 'None' },
            { label: 'Team', value: current?.team, emptyLabel: 'No team' },
            { label: 'Job title', value: member.jobTitle?.name, emptyLabel: 'Not set' },
            { label: 'Since', value: current ? <LocalTime iso={current.startedAt} format="date" /> : null, emptyLabel: '—' }]} /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Employee details" description="The company accounts IT recorded." />
          <CardBody><DescriptionList layout="rows" items={[
            { label: 'Company email', value: member.accounts?.companyEmail, emptyLabel: 'Pending IT setup' },
            { label: 'Work phone (RingCentral)', value: member.accounts?.workPhone, mono: true, emptyLabel: 'Pending IT setup' }]} />
            {member.applicationId && <Link href={`/onboarding/applications/${member.applicationId}`} className="mt-4 inline-block text-sm text-primary underline-offset-4 hover:underline">Open onboarding record</Link>}</CardBody>
        </Card>
        <p className="text-xs leading-5 text-muted-foreground">Dispatcher managers and administrators see this record. Dispatchers don’t have accounts and never see the workspace.</p>
      </div>
    </div>
    {action && <Dialog open onClose={() => setAction(null)} busy={pending} tone={action === 'leave' ? 'warning' : undefined}
      title={action === 'move' ? `Move ${name}` : action === 'leave' ? `Mark ${name} as left?` : 'Change job title'}
      description={action === 'move' ? 'The current MC and team end on the start date and stay in the history.' : action === 'leave' ? 'The record and its history are kept. Leaving a team also ends being its lead.' : undefined}
      actions={<Button type="submit" form="member-action" variant={action === 'leave' ? 'destructive' : 'default'}>{pending ? 'Saving…' : action === 'move' ? 'Move dispatcher' : action === 'leave' ? 'Mark as left' : 'Save job title'}</Button>}>
      <form id="member-action" onSubmit={submit} className="space-y-4">
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
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
