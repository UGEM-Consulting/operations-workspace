import Link from 'next/link';
import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { MEMBER_DEFAULTS } from '@/lib/navigation';
import { Card } from '@/components/ui/card';
import { Person } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/feedback';
import { FilterBar } from '@/components/ui/filter-bar';
import { LocalTime } from '@/components/ui/local-time';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { fullName, statusBadge, type MemberList } from '@/features/dispatch/types';
export const metadata = { title: 'Dispatchers' };
/** Dispatch › Dispatchers: every dispatch member record (no login), with where they work now. */
export default async function DispatchersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('dispatchers');
  const query = await searchParams;
  const filters = Object.fromEntries(Object.entries(MEMBER_DEFAULTS).map(([key, value]) => [key, typeof query[key] === 'string' ? query[key].slice(0, 100) : value]));
  const response = await apiRequest('dispatch/members');
  if (!response.ok) throw new Error('Unable to load dispatchers');
  const data = await readResponse<MemberList>(response, 'dispatchers');
  const search = filters.search.toLowerCase();
  const searched = data.items.filter(member => `${fullName(member)} ${member.mc ?? 'independent'} ${member.team ?? ''} ${member.jobTitle ?? ''}`.toLowerCase().includes(search));
  const visible = searched.filter(member => filters.status === 'ALL' || member.status === filters.status);
  const filtered = filters.search !== '' || filters.status !== MEMBER_DEFAULTS.status;
  return <div className="space-y-6">
    <PageHeader title="Dispatchers" description="Approved dispatchers and where they work. Onboarding until IT finishes their setup, then Active. Records only: dispatchers don’t sign in." />
    <Card>
      <FilterBar path="/dispatch/dispatchers" filters={filters} defaults={MEMBER_DEFAULTS} searchLabel="Search name, MC, team or job title" statuses={[
        { key: 'ONBOARDING', label: 'Onboarding', count: searched.filter(member => member.status === 'ONBOARDING').length },
        { key: 'ACTIVE', label: 'Active', count: searched.filter(member => member.status === 'ACTIVE').length },
        { key: 'LEFT', label: 'Left', count: searched.filter(member => member.status === 'LEFT').length },
        { key: 'ALL', label: 'All', count: searched.length }]} />
      <Table caption="Dispatchers" className="border-t border-border" rows={visible} rowKey={member => member.id} columns={[
        { key: 'name', label: 'Dispatcher', primary: true, cell: member => <Link href={`/dispatch/dispatchers/${member.id}`} className="block rounded-sm hover:underline focus-visible:outline-2"><Person name={fullName(member)} secondary={member.lead ? 'Team lead' : member.position === 'SUPPORT' ? 'Support' : 'Dispatcher'} /></Link> },
        { key: 'mc', label: 'MC', cell: member => member.mc ?? <span className="text-muted-foreground">Independent</span> },
        { key: 'team', label: 'Team', hideBelow: 'md', cell: member => member.team ?? <span className="text-muted-foreground">No team</span> },
        { key: 'title', label: 'Job title', hideBelow: 'lg', muted: true, cell: member => member.jobTitle ?? 'Not set' },
        { key: 'since', label: 'Since', nowrap: true, muted: true, hideBelow: 'xl', cell: member => <LocalTime iso={member.since} format="date" /> },
        { key: 'status', label: 'Status', cell: member => <Badge label={statusBadge[member.status].label} tone={statusBadge[member.status].tone} /> },
      ]} empty={filtered ? <EmptyState compact title="Nothing matches these filters" description="Try another status or search." />
        : <EmptyState compact title="No dispatchers yet" description="Approving an application adds the dispatcher here." />}
        footer={<p className="text-[13px] text-muted-foreground">{visible.length} of {data.items.length} dispatcher records.</p>} />
    </Card>
  </div>;
}
