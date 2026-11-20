import Link from 'next/link';
import { requirePage } from '@/lib/auth';
import { Card, CardHeader } from '@/components/ui/card';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { PositionChip } from '@/features/dispatch/glance';
import { supportName } from '@/features/dispatch/types';
import { memberState, NotAvailable, viewRead, ViewOnlyMark } from '@/features/view/ui';
export const metadata = { title: 'Team · view only' };

interface Person { id: string; firstName: string; lastName: string; status: string; position: 'DISPATCHER' | 'SUPPORT'; supportType?: 'SUPPORT' | 'UPDATER'; lastDay: string | null; onLeaveUntil: string | null }
interface ViewTeam { id: string; name: string; archived: boolean; leadId: string | null; mc: { id: string; name: string };
  dispatchers: (Person & { jobTitle: string | null; drivers: number; companyEmail: string | null })[]; helpers: (Person & { dispatcherId: string | null; teamId: string | null })[] }

/** One team read only: its dispatchers (the lead first) and everyone helping them or the whole team. */
export default async function ViewTeamPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePage('viewteams');
  const { id } = await params;
  const team = /^[0-9a-f-]{36}$/i.test(id) ? await viewRead<ViewTeam>(`dispatch/teams/${id}`, 'team') : null;
  if (!team) return <NotAvailable back="/view/dispatch/teams" label="Teams" />;
  const name = (person: Person) => <Link href={`/view/dispatch/dispatchers/${person.id}`} className="font-medium text-foreground hover:underline">{person.firstName} {person.lastName}</Link>;
  const state = (person: Person) => { const { label, tone } = memberState({ status: person.status, lastDay: person.lastDay, leave: person.onLeaveUntil ? { started: true } : null }); return <Badge label={label} tone={tone} />; };
  const dispatchers = [...team.dispatchers].sort((a, b) => Number(b.id === team.leadId) - Number(a.id === team.leadId));
  const helps = (helper: ViewTeam['helpers'][number]) => helper.teamId ? 'The whole team' : (() => { const of = team.dispatchers.find(person => person.id === helper.dispatcherId); return of ? `${of.firstName} ${of.lastName}` : '—'; })();
  return <div className="space-y-6">
    <PageHeader title={team.name} badge={<span className="flex items-center gap-2">{team.archived && <Badge label="Archived" tone="neutral" />}<ViewOnlyMark /></span>} meta={[team.mc.name]} />
    <Card>
      <CardHeader title="Dispatchers" />
      <Table caption="Dispatchers" className="mt-3 border-t border-border" rows={dispatchers} rowKey={person => person.id} columns={[
        { key: 'name', label: 'Name', primary: true, cell: person => <span className="grid justify-items-start gap-1">{name(person)}<PositionChip row={{ position: 'DISPATCHER', lead: person.id === team.leadId }} /></span> },
        { key: 'title', label: 'Job title', muted: true, hideBelow: 'md', cell: person => person.jobTitle ?? 'Not set' },
        { key: 'drivers', label: 'Drivers', align: 'right', cell: person => person.drivers },
        { key: 'email', label: 'Company email', hideBelow: 'lg', cell: person => person.companyEmail ?? <span className="text-muted-foreground">—</span> },
        { key: 'status', label: 'Status', cell: state },
      ]} empty={<p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">No dispatchers in this team.</p>} />
    </Card>
    <Card>
      <CardHeader title="Supports and updaters" />
      <Table caption="Supports and updaters" className="mt-3 border-t border-border" rows={team.helpers} rowKey={person => person.id} columns={[
        { key: 'name', label: 'Name', primary: true, cell: person => <span className="grid justify-items-start gap-1">{name(person)}<PositionChip row={{ position: 'SUPPORT', supportType: person.supportType, lead: false }} /></span> },
        { key: 'helps', label: 'Helps', cell: helps },
        { key: 'kind', label: 'Position', hideBelow: 'md', muted: true, cell: person => supportName(person) },
        { key: 'status', label: 'Status', cell: state },
      ]} empty={<p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">Nobody helps this team yet.</p>} />
    </Card>
  </div>;
}
