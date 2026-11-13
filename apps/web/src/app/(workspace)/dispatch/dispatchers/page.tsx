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
import { Pagination } from '@/components/ui/pagination';
import { Table, type Column } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { ListFilter, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PaperworkTable } from '@/features/dispatch/paperwork';
import { MemberFilters, PageSizeSelect } from '@/features/dispatch/member-list';
import { FILTER_KEYS, membersHref } from '@/features/dispatch/member-filters';
import { describeView, matchedRange } from '@/features/dispatch/member-view';
import { assists, fullName, underMc, memberBadge, supportName, toReassign, type MemberList, type MemberRow, type PaperworkList } from '@/features/dispatch/types';
export const metadata = { title: 'Dispatchers' };
type Row = MemberList['items'][number];
const TABS = ['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'LEAVING', 'LEFT', 'PAPERWORK', 'MISSING', 'ALL'];
const SORTS = ['name', 'mc', 'team', 'lead', 'drivers', 'since', 'status'];
/** A query value the API accepts, else its default, so a hand-edited URL never breaks the page. */
function clean(query: Record<string, string | string[] | undefined>) {
  const read = (key: string) => typeof query[key] === 'string' ? query[key].slice(0, 100) : MEMBER_DEFAULTS[key];
  const filters = Object.fromEntries(Object.keys(MEMBER_DEFAULTS).map(key => [key, read(key)]));
  const id = /^[0-9a-f-]{36}$/i;
  if (!TABS.includes(filters.status)) filters.status = MEMBER_DEFAULTS.status;
  for (const key of ['mcId', 'leadId', 'jobTitleId']) if (filters[key] && !id.test(filters[key])) filters[key] = '';
  if (filters.teamId && filters.teamId !== 'NONE' && !id.test(filters.teamId)) filters.teamId = '';
  if (!['', 'DISPATCHER', 'SUPPORT', 'UPDATER'].includes(filters.position)) filters.position = '';
  if (!['', 'ONBOARDED', 'ADDED'].includes(filters.source)) filters.source = '';
  if (!['', 'WITH', 'WITHOUT'].includes(filters.drivers)) filters.drivers = '';
  if (!SORTS.includes(filters.sort)) filters.sort = '';
  if (!['asc', 'desc'].includes(filters.direction)) filters.direction = '';
  if (!['20', '50', '100'].includes(filters.pageSize)) filters.pageSize = MEMBER_DEFAULTS.pageSize;
  if (!/^\d{1,5}$/.test(filters.page) || filters.page === '0') filters.page = '1';
  return filters;
}
const listQuery = (filters: Record<string, string>, changes: Record<string, string> = {}) => new URLSearchParams(Object.entries({ ...filters, ...changes })
  .filter(([key, value]) => value !== '' && ['status', 'search', 'sort', 'direction', 'page', 'pageSize', ...FILTER_KEYS].includes(key))).toString();
// A picked day (stored at midday UTC) without its year, as DispatchersOnLeaveScreen shows leave dates.
const monthDay = (day: string) => new Date(middayIso(day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const role = (member: Row) => member.lead ? 'Team lead' : member.position === 'SUPPORT' ? `${supportName(member)} for ${assists(member)}` : 'Dispatcher';
const driversText = (member: Row) => member.position === 'SUPPORT' || member.drivers === undefined ? '' : member.drivers === 0 ? 'no drivers' : `${member.drivers} driver${member.drivers === 1 ? '' : 's'}`;
/** The status badge, or null for the ordinary status of the tab a phone row is on (Active on Active). */
function statusBadge(member: Row) {
  if (member.lastDayPassed) return <Badge label="Last day passed" tone="danger" />;
  if (member.lastDay) return <Badge label="Leaving" tone="warning" />;
  if (member.leave) return <Badge label={member.leave.started ? 'On leave' : `Starts ${monthDay(member.leave.firstDay)}`} tone="info" />;
  return <Badge {...memberBadge(member.status)} />;
}
const exceptional = (member: Row) => !!(member.lastDay || member.leave || member.status !== 'ACTIVE');
/** The contact detail a search found, with the part that matched marked (DispatchersSearchContactScreen). */
function Matched({ value, search }: { value: string; search: string }) {
  const range = matchedRange(value, search);
  if (!range) return value;
  return <>{value.slice(0, range[0])}<mark className="rounded-xs bg-warning/25 px-0.5 text-foreground">{value.slice(...range)}</mark>{value.slice(range[1])}</>;
}

/** Dispatch › Dispatchers: every dispatch member record (no login), filtered, sorted and paged on the server. */
export default async function DispatchersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('dispatchers');
  const filters = clean(await searchParams);
  const paperworkNow = filters.status === 'PAPERWORK';
  // Paperwork has its own table; the counts still come from the list.
  const response = await apiRequest(`dispatch/members?${listQuery(filters, paperworkNow ? { status: 'ACTIVE', page: '1', pageSize: '20' } : {})}`);
  if (!response.ok) throw new Error('Unable to load dispatchers');
  const data = await readResponse<MemberList>(response, 'dispatchers', memberListSchema);
  // From an API with existing dispatchers; an older one simply has no Paperwork tab.
  const paperworkResponse = await apiRequest('dispatch/paperwork');
  const paperwork = paperworkResponse.ok ? await readResponse<PaperworkList>(paperworkResponse, 'paperwork', paperworkSchema) : null;
  // Whose last day has passed while someone is still assigned to them, wherever they are in the list.
  const leavingResponse = (data.counts.leaving ?? 0) > 0 ? await apiRequest(`dispatch/members?${listQuery({ status: 'LEAVING', page: '1', pageSize: '100' })}`) : null;
  const passed = leavingResponse?.ok ? (await readResponse<MemberList>(leavingResponse, 'leaving dispatchers', memberListSchema)).items.filter(member => member.lastDayPassed) : [];
  const status = filters.status, items = data.items, total = data.total ?? items.length, pageSize = data.pageSize ?? Number(filters.pageSize), page = data.page ?? 1;
  const options = data.options ?? { mcs: [], teams: [], leads: [], jobTitles: [] };
  const filtered = FILTER_KEYS.some(key => filters[key]) || filters.search !== '';
  // With no sort chosen the list is by name (DispatchersFiltersScreen: "Name ↑"), except Leaving and On leave, which keep their own order.
  const sorted = filters.sort || (status === 'LEAVING' || status === 'ON_LEAVE' ? '' : 'name');
  const sortBy = (key: string) => {
    const direction = sorted === key ? (filters.direction === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc' : undefined;
    return { href: membersHref(filters, { sort: key, direction: direction === 'asc' ? 'desc' : 'asc' }), direction };
  };
  const tabLabel = { ONBOARDING: 'Onboarding', ACTIVE: 'Active', ON_LEAVE: 'On leave', LEAVING: 'Leaving', LEFT: 'Left', MISSING: 'Missing details', ALL: 'All' }[status] ?? 'Active';
  const view = describeView(tabLabel, filters, options);
  const name: Column<Row> = { key: 'name', label: 'Name', primary: true, sort: sortBy('name'), cell: member => <Link href={`/dispatch/dispatchers/${member.id}`} className="block rounded-sm hover:underline focus-visible:outline-2">
    <span className="max-sm:hidden"><Person name={fullName(member)} secondary={role(member)} /></span>
    {/* Phones (DispatchersFiltersPhoneScreen): role, team and drivers on one line, and a badge only when it says something. */}
    <span className="grid justify-items-start gap-1.5 sm:hidden"><Person name={fullName(member)} secondary={[role(member), member.position === 'SUPPORT' ? '' : member.team, driversText(member)].filter(Boolean).join(' · ')} />
      {exceptional(member) && <span className="pl-11">{statusBadge(member)}</span>}</span>
    {member.matched && <span className="mt-0.5 block truncate pl-11 text-xs text-muted-foreground">{member.matched.label} <Matched value={member.matched.value} search={filters.search} /></span>}
  </Link> };
  const team = (member: Row) => member.team ?? <span className="text-muted-foreground">{underMc(member.mc) ? 'Independent' : '—'}</span>;
  const columns: Column<Row>[] = [name, { key: 'mc', label: 'MC', hideBelow: 'md', stacked: false, sort: sortBy('mc'), cell: member => member.mc ?? <span className="text-muted-foreground">No MC yet</span> },
    ...(status === 'LEAVING' ? [
      { key: 'lastDay', label: 'Last day', nowrap: true, cell: (member: Row) => <LocalTime iso={middayIso(member.lastDay!)} format="date" /> },
      { key: 'reassign', label: 'To reassign', cell: (member: Row) => toReassign(member.driversToReassign ?? 0, member.supportsToReassign ?? 0) },
      { key: 'it', label: 'IT removal', hideBelow: 'lg' as const, cell: (member: Row) => member.itRemoval ? <Badge label={member.itRemoval === 'SCHEDULED' ? 'Scheduled' : member.itRemoval === 'COMPLETED' ? 'Completed' : 'In progress'} tone={member.itRemoval === 'COMPLETED' ? 'success' : 'info'} /> : <span className="text-muted-foreground">No accounts</span> },
    ] : status === 'ON_LEAVE' ? [
      { key: 'away', label: 'Away', nowrap: true, cell: (member: Row) => `${monthDay(member.leave!.firstDay)} to ${monthDay(member.leave!.backOn)}` },
      { key: 'it', label: 'IT access', hideBelow: 'lg' as const, cell: (member: Row) => member.leave!.it === 'NONE' ? <Badge label="Nothing to suspend" tone="neutral" /> : <Badge label={member.leave!.it === 'SUSPENDED' ? 'Suspended' : member.leave!.started ? 'Suspending' : 'Suspend scheduled'} tone="info" /> },
    ] : status === 'MISSING' ? [
      { key: 'team', label: 'Team', hideBelow: 'lg' as const, cell: team },
      { key: 'started', label: 'Started', nowrap: true, cell: (member: Row) => member.startDateKnown === false ? <span className="text-muted-foreground">Not recorded</span> : <LocalTime iso={member.joinedAt} format="date" /> },
    ] : [
      { key: 'team', label: 'Team', hideBelow: 'md' as const, stacked: false as const, sort: sortBy('team'), cell: team },
      { key: 'lead', label: 'Team lead', hideBelow: 'lg' as const, stacked: false as const, sort: sortBy('lead'), cell: (member: Row) => member.teamLead ?? <span className="text-muted-foreground">—</span> },
      { key: 'drivers', label: 'Drivers', hideBelow: 'lg' as const, stacked: false as const, align: 'right' as const, sort: sortBy('drivers'), cell: (member: Row) => member.position === 'SUPPORT' || member.drivers === undefined ? <span className="text-muted-foreground">—</span> : member.drivers },
      { key: 'title', label: 'Job title', hideBelow: 'xl' as const, stacked: false as const, muted: true, cell: (member: Row) => member.position === 'SUPPORT' ? supportName(member) : member.jobTitle ?? 'Not set' },
      { key: 'since', label: 'Since', nowrap: true, muted: true, hideBelow: 'xl' as const, stacked: false as const, sort: sortBy('since'), cell: (member: Row) => member.sinceKnown === false ? 'Not recorded' : <LocalTime iso={member.since} format="date" /> },
    ]),
    { key: 'status', label: 'Status', stacked: false, sort: status === 'LEAVING' || status === 'ON_LEAVE' ? undefined : sortBy('status'), cell: statusBadge }];
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return <div className="space-y-6">
    <PageHeader title="Dispatchers" description="Everyone on a dispatch team, with their supports and updaters."
      action={paperwork && <Button asChild variant="outline"><Link href="/dispatch/dispatchers/add"><Plus aria-hidden="true" className="size-4" />Add existing dispatchers</Link></Button>} />
    {passed.map(member => <Alert key={member.id} tone="danger" title={`${fullName(member)}’s last day has passed`}><p>{toReassign(member.driversToReassign ?? 0, member.supportsToReassign ?? 0)} still assigned, so the record stays Leaving until they’re reassigned. IT’s removal of their access doesn’t wait for this.</p></Alert>)}
    <Card>
      <FilterBar path="/dispatch/dispatchers" filters={filters} defaults={MEMBER_DEFAULTS} searchLabel="Search name, email or phone" wideSearch statuses={[
        { key: 'ONBOARDING', label: 'Onboarding', count: data.counts.onboarding ?? 0 },
        { key: 'ACTIVE', label: 'Active', count: data.counts.active },
        { key: 'ON_LEAVE', label: 'On leave', count: data.counts.onLeave ?? 0 },
        { key: 'LEAVING', label: 'Leaving', count: data.counts.leaving ?? 0 },
        { key: 'LEFT', label: 'Left', count: data.counts.left },
        ...(paperwork ? [{ key: 'PAPERWORK', label: 'Paperwork', count: data.counts.paperwork ?? paperwork.items.filter(row => row.state !== 'FINISHED').length }, { key: 'MISSING', label: 'Missing details', count: data.counts.missing ?? 0 }] : []),
        { key: 'ALL', label: 'All', count: data.counts.all ?? total }]} />
      {paperworkNow && paperwork ? <PaperworkTable list={paperwork} search={filters.search} /> : <>
        <MemberFilters filters={filters} options={options} total={total} view={view} />
        <Table caption="Dispatchers, supports and updaters" className="border-t border-border" rows={items as MemberRow[]} rowKey={member => member.id} columns={columns}
          empty={filtered ? <EmptyState compact icon={ListFilter} title="Nothing matches these filters" description="Remove a filter or clear them all."
            action={<Button asChild variant="outline"><Link href={membersHref(filters, { search: '', ...Object.fromEntries(FILTER_KEYS.map(key => [key, ''])) })}>Clear filters</Link></Button>} />
            : <EmptyState compact title={status === 'ACTIVE' ? 'No dispatchers yet' : 'Nobody here'} description="Approving an application adds the dispatcher here. Add existing dispatchers for people already working here." />}
          footer={total > 0 && <div className="flex flex-wrap items-center justify-between gap-3">
            {filters.search && <p className="basis-full text-[13px] text-muted-foreground">{total === 1 ? '1 person matches' : `${total} people match`} “{filters.search}”. A number or email someone used before they left still finds them.</p>}
            <Pagination label="Dispatchers pages" page={page} pageCount={pageCount} pageSize={pageSize} total={total} href={target => membersHref(filters, { page: String(target) })} />
            <PageSizeSelect filters={filters} />
          </div>} />
      </>}
    </Card>
  </div>;
}
