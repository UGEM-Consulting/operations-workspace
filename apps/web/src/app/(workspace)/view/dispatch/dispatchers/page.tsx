import { requirePage } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { FilterBar } from '@/components/ui/filter-bar';
import { Pagination } from '@/components/ui/pagination';
import { Table, type Column } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { ContactCell, HelpersCell, NameCell, PhoneDetails } from '@/features/dispatch/glance';
import { underMc, type MemberRow } from '@/features/dispatch/types';
import { memberState, NotAvailable, viewRead, ViewOnlyMark } from '@/features/view/ui';
import { middayIso } from '@/lib/navigation';
export const metadata = { title: 'Dispatchers · view only' };

interface ViewMembers { items: MemberRow[]; counts: Record<'onboarding' | 'active' | 'onLeave' | 'leaving' | 'left' | 'all', number>; total: number; page: number; pageSize: number }
const DEFAULTS: Record<string, string> = { status: 'ACTIVE', search: '', page: '1' };
const TABS = ['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'LEAVING', 'LEFT', 'ALL'];
const BASE = '/view/dispatch/dispatchers';
const monthDay = (day: string) => new Date(middayIso(day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const href = (filters: Record<string, string>, changes: Record<string, string>) => `${BASE}?${new URLSearchParams(Object.entries({ ...filters, ...changes }).filter(([, value]) => value !== ''))}`;

/** Dispatch › Dispatchers read only (ViewOnlyDispatchersScreen): the same tabs and search, work contacts, nothing that changes a record. */
export default async function ViewDispatchersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('viewdispatchers');
  const query = await searchParams;
  const read = (key: string) => typeof query[key] === 'string' ? query[key].slice(0, 100) : DEFAULTS[key];
  const filters = { status: TABS.includes(read('status')) ? read('status') : 'ACTIVE', search: read('search'), page: /^\d{1,5}$/.test(read('page')) && read('page') !== '0' ? read('page') : '1' };
  const data = await viewRead<ViewMembers>(`dispatch/members?${new URLSearchParams(Object.entries({ ...filters, pageSize: '20' }).filter(([, value]) => value !== ''))}`, 'dispatchers');
  if (!data) return <NotAvailable back="/account/security" label="Account security" />;
  const where = (row: MemberRow) => [row.mc, row.team ?? (underMc(row.mc) ? 'Independent' : '')].filter(Boolean).join(' · ');
  const state = (row: MemberRow) => {
    const { label, tone } = memberState(row);
    return <span className="grid justify-items-start gap-1"><Badge label={row.leave && !row.leave.started ? `Leave from ${monthDay(row.leave.firstDay)}` : label} tone={tone} />
      {row.lastDay && row.status !== 'LEFT' && <span className="text-xs text-muted-foreground">Last day {monthDay(row.lastDay)}</span>}
      {row.leave?.started && <span className="text-xs text-muted-foreground">Back {monthDay(row.leave.backOn)}</span>}</span>;
  };
  const columns: Column<MemberRow>[] = [
    { key: 'name', label: 'Name', primary: true, cell: row => <NameCell row={row} base={BASE}>
      {row.matched && <span className="truncate text-xs text-muted-foreground">{row.matched.label} {row.matched.value}</span>}
      <span className="grid justify-items-start gap-1 sm:hidden">{state(row)}<PhoneDetails row={row} where={where(row)} /></span>
    </NameCell> },
    { key: 'mc', label: 'MC', hideBelow: 'md', stacked: false, cell: row => row.mc ?? <span className="text-muted-foreground">No MC yet</span> },
    { key: 'team', label: 'Team', hideBelow: 'md', stacked: false, cell: row => row.team ?? <span className="text-muted-foreground">{underMc(row.mc) ? 'Independent' : '—'}</span> },
    { key: 'drivers', label: 'Drivers', hideBelow: 'lg', stacked: false, align: 'right', cell: row => row.position === 'SUPPORT' || row.drivers === undefined ? <span className="text-muted-foreground">—</span> : row.drivers },
    { key: 'contact', label: 'Work contact', stacked: false, cell: row => <ContactCell row={row} /> },
    { key: 'helpers', label: 'Helped by', hideBelow: 'lg', stacked: false, cell: row => <HelpersCell row={row} base={BASE} /> },
    { key: 'status', label: 'Status', stacked: false, cell: state },
  ];
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));
  return <div className="space-y-6">
    <PageHeader title="Dispatchers" badge={<ViewOnlyMark />} description="Everyone in Dispatch: where they work, their drivers and how to reach them at work." />
    <Card>
      <FilterBar path={BASE} filters={filters} defaults={DEFAULTS} searchLabel="Search name, work email or number" wideSearch statuses={[
        { key: 'ONBOARDING', label: 'Onboarding', count: data.counts.onboarding }, { key: 'ACTIVE', label: 'Active', count: data.counts.active },
        { key: 'ON_LEAVE', label: 'On leave', count: data.counts.onLeave }, { key: 'LEAVING', label: 'Leaving', count: data.counts.leaving },
        { key: 'LEFT', label: 'Left', count: data.counts.left }, { key: 'ALL', label: 'All', count: data.counts.all }]} />
      <Table caption="Dispatchers, supports and updaters" className="border-t border-border" rows={data.items} rowKey={row => row.id} columns={columns}
        empty={<EmptyState compact title={filters.search ? 'Nobody matches' : 'Nobody here'} description={filters.search ? 'Try another name, work email or number.' : undefined} />}
        footer={data.total > 0 && <Pagination label="Dispatchers pages" page={data.page} pageCount={pageCount} pageSize={data.pageSize} total={data.total} href={target => href(filters, { page: String(target) })} />} />
    </Card>
  </div>;
}
