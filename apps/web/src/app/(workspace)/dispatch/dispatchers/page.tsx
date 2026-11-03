import Link from 'next/link';
import { apiRequest, requirePage } from '@/lib/auth';
import { memberListSchema, paperworkSchema, readResponse } from '@/lib/api-schemas';
import { MEMBER_DEFAULTS, middayIso } from '@/lib/navigation';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Person } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/feedback';
import { FilterBar } from '@/components/ui/filter-bar';
import { LocalTime } from '@/components/ui/local-time';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PaperworkTable } from '@/features/dispatch/paperwork';
import { fullName, memberBadge, toReassign, type MemberList, type PaperworkList } from '@/features/dispatch/types';
export const metadata = { title: 'Dispatchers' };
/** Dispatch › Dispatchers: every dispatch member record (no login), with where they work now. */
export default async function DispatchersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('dispatchers');
  const query = await searchParams;
  const filters = Object.fromEntries(Object.entries(MEMBER_DEFAULTS).map(([key, value]) => [key, typeof query[key] === 'string' ? query[key].slice(0, 100) : value]));
  const response = await apiRequest('dispatch/members');
  if (!response.ok) throw new Error('Unable to load dispatchers');
  const data = await readResponse<MemberList>(response, 'dispatchers', memberListSchema);
  // From an API with existing dispatchers; an older one simply has no Paperwork tab.
  const paperworkResponse = await apiRequest('dispatch/paperwork');
  const paperwork = paperworkResponse.ok ? await readResponse<PaperworkList>(paperworkResponse, 'paperwork', paperworkSchema) : null;
  const paperworkNow = filters.status === 'PAPERWORK' && !!paperwork;
  const search = filters.search.toLowerCase();
  const searched = data.items.filter(member => `${fullName(member)} ${member.mc ?? 'independent'} ${member.team ?? ''} ${member.jobTitle ?? ''}`.toLowerCase().includes(search));
  // Leaving: on notice, the soonest last day first. They also still count as Active (or Onboarding) until they've left.
  const leavingNow = filters.status === 'LEAVING', leaving = searched.filter(member => member.lastDay).sort((a, b) => a.lastDay!.localeCompare(b.lastDay!));
  const visible = leavingNow ? leaving : searched.filter(member => filters.status === 'ALL' || member.status === filters.status);
  const passed = data.items.filter(member => member.lastDayPassed);
  const filtered = filters.search !== '' || filters.status !== MEMBER_DEFAULTS.status;
  return <div className="space-y-6">
    <PageHeader title="Dispatchers" description="Approved dispatchers and where they work. Onboarding until IT finishes their setup, then Active. Records only: dispatchers don’t sign in."
      action={paperwork && <Button asChild variant="outline"><Link href="/dispatch/dispatchers/add"><Plus aria-hidden="true" className="size-4" />Add existing dispatchers</Link></Button>} />
    {passed.map(member => <Alert key={member.id} tone="danger" title={`${fullName(member)}’s last day has passed`}><p>{toReassign(member.driversToReassign ?? 0, member.supportsToReassign ?? 0)} still assigned, so the record stays Leaving until they’re reassigned. IT’s removal of their access doesn’t wait for this.</p></Alert>)}
    <Card>
      <FilterBar path="/dispatch/dispatchers" filters={filters} defaults={MEMBER_DEFAULTS} searchLabel="Search name, MC, team or job title" statuses={[
        { key: 'ONBOARDING', label: 'Onboarding', count: searched.filter(member => member.status === 'ONBOARDING').length },
        { key: 'ACTIVE', label: 'Active', count: searched.filter(member => member.status === 'ACTIVE').length },
        { key: 'LEAVING', label: 'Leaving', count: leaving.length },
        { key: 'LEFT', label: 'Left', count: searched.filter(member => member.status === 'LEFT').length },
        ...(paperwork ? [{ key: 'PAPERWORK', label: 'Paperwork', count: paperwork.items.filter(row => row.state !== 'FINISHED').length }] : []),
        { key: 'ALL', label: 'All', count: searched.length }]} />
      {paperworkNow ? <PaperworkTable list={paperwork} search={filters.search} /> : <Table caption="Dispatchers" className="border-t border-border" rows={visible} rowKey={member => member.id} columns={[
        { key: 'name', label: 'Dispatcher', primary: true, cell: member => <Link href={`/dispatch/dispatchers/${member.id}`} className="block rounded-sm hover:underline focus-visible:outline-2"><Person name={fullName(member)} secondary={member.lead ? 'Team lead' : member.position === 'SUPPORT' ? `Support for ${member.dispatcher ?? 'a dispatcher'}` : 'Dispatcher'} /></Link> },
        { key: 'mc', label: 'MC', cell: member => member.mc ?? <span className="text-muted-foreground">Independent</span> },
        ...(leavingNow ? [
          { key: 'lastDay', label: 'Last day', nowrap: true, cell: (member: MemberList['items'][number]) => <LocalTime iso={middayIso(member.lastDay!)} format="date" /> },
          { key: 'reassign', label: 'To reassign', cell: (member: MemberList['items'][number]) => toReassign(member.driversToReassign ?? 0, member.supportsToReassign ?? 0) },
          { key: 'it', label: 'IT removal', hideBelow: 'lg' as const, cell: (member: MemberList['items'][number]) => member.itRemoval ? <Badge label={member.itRemoval === 'SCHEDULED' ? 'Scheduled' : member.itRemoval === 'COMPLETED' ? 'Completed' : 'In progress'} tone={member.itRemoval === 'COMPLETED' ? 'success' : 'info'} /> : <span className="text-muted-foreground">No accounts</span> },
        ] : [
          { key: 'team', label: 'Team', hideBelow: 'md' as const, cell: (member: MemberList['items'][number]) => member.team ?? <span className="text-muted-foreground">No team</span> },
          { key: 'title', label: 'Job title', hideBelow: 'lg' as const, muted: true, cell: (member: MemberList['items'][number]) => member.jobTitle ?? 'Not set' },
          { key: 'since', label: 'Since', nowrap: true, muted: true, hideBelow: 'xl' as const, cell: (member: MemberList['items'][number]) => <LocalTime iso={member.since} format="date" /> },
        ]),
        { key: 'status', label: 'Status', cell: member => member.lastDayPassed ? <Badge label="Last day passed" tone="danger" /> : member.lastDay ? <Badge label="Leaving" tone="warning" /> : <Badge {...memberBadge(member.status)} /> },
      ]} empty={filtered ? <EmptyState compact title="Nothing matches these filters" description="Try another status or search." />
        : <EmptyState compact title="No dispatchers yet" description="Approving an application adds the dispatcher here. Add existing dispatchers for people already working here." />}
        footer={<p className="text-[13px] text-muted-foreground">{visible.length} of {data.items.length} dispatcher records.</p>} />}
    </Card>
  </div>;
}
