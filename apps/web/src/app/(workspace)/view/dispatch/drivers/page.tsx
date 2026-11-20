import { requirePage } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { FilterBar } from '@/components/ui/filter-bar';
import { LocalTime } from '@/components/ui/local-time';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { NotAvailable, viewRead, ViewOnlyMark } from '@/features/view/ui';
import { middayIso } from '@/lib/navigation';
export const metadata = { title: 'Drivers · view only' };

interface ViewDriver { id: string; firstName: string; lastName: string; phone: string; driverType: string; licenseType: string | null; clearedAt: string | null; onHold: boolean; gettingReady?: boolean;
  assignment: { mc: string; dispatcher: string; team: string | null; truck: string | null; trailer: string | null; startedAt: string; covering: { for: string; until: string } | null } | null }
const DEFAULTS: Record<string, string> = { status: 'ALL', search: '' };
const TYPE: Record<string, string> = { COMPANY: 'Company driver', OWNER_OPERATOR: 'Owner-operator' };
const LICENSE: Record<string, string> = { CDL_A: 'CDL A', CDL_B: 'CDL B', CDL_C: 'CDL C', DL: 'DL' };

/** Dispatch › Drivers read only: cleared drivers, where they work and whether they're on hold, as Dispatch sees them. */
export default async function ViewDispatchDriversPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('viewdispatchdrivers');
  const query = await searchParams;
  const filters = { status: ['ALL', 'WORKING', 'READY'].includes(String(query.status)) ? String(query.status) : 'ALL', search: typeof query.search === 'string' ? query.search.slice(0, 100) : '' };
  const data = await viewRead<{ items: ViewDriver[] }>('dispatch/drivers', 'drivers');
  if (!data) return <NotAvailable back="/account/security" label="Account security" />;
  const search = filters.search.trim().toLowerCase();
  const matching = data.items.filter(driver => !search || `${driver.firstName} ${driver.lastName} ${driver.assignment?.dispatcher ?? ''} ${driver.assignment?.truck ?? ''}`.toLowerCase().includes(search));
  const rows = matching.filter(driver => filters.status === 'ALL' || (filters.status === 'WORKING') === !!driver.assignment);
  return <div className="space-y-6">
    <PageHeader title="Drivers" badge={<ViewOnlyMark />} description="Drivers Safety cleared, the MC and dispatcher they work with, and their unit." />
    <Card>
      <FilterBar path="/view/dispatch/drivers" filters={filters} defaults={DEFAULTS} searchLabel="Search driver, dispatcher or unit" statuses={[
        { key: 'WORKING', label: 'Working', count: matching.filter(driver => driver.assignment).length },
        { key: 'READY', label: 'Not assigned', count: matching.filter(driver => !driver.assignment).length },
        { key: 'ALL', label: 'All', count: matching.length }]} />
      <Table caption="Drivers" className="border-t border-border" rows={rows} rowKey={driver => driver.id} columns={[
        { key: 'name', label: 'Driver', primary: true, cell: driver => <span className="grid justify-items-start gap-1"><span className="font-medium">{driver.firstName} {driver.lastName}</span>
          <span className="text-[13px] text-muted-foreground">{[TYPE[driver.driverType] ?? driver.driverType, driver.licenseType ? LICENSE[driver.licenseType] : null].filter(Boolean).join(' · ')}</span></span> },
        { key: 'phone', label: 'Phone', nowrap: true, cell: driver => <a href={`tel:${driver.phone.replace(/[^\d+]/g, '')}`} className="hover:underline">{driver.phone}</a> },
        { key: 'where', label: 'MC and dispatcher', cell: driver => driver.assignment ? <span className="grid gap-0.5"><span>{driver.assignment.dispatcher}</span><span className="text-[13px] text-muted-foreground">{[driver.assignment.mc, driver.assignment.team].filter(Boolean).join(' · ')}</span>
          {driver.assignment.covering && <span className="text-xs text-muted-foreground">Covering for {driver.assignment.covering.for} until {new Date(middayIso(driver.assignment.covering.until)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>}</span>
          : <span className="text-muted-foreground">Not assigned</span> },
        { key: 'unit', label: 'Unit', hideBelow: 'md', cell: driver => [driver.assignment?.truck, driver.assignment?.trailer].filter(Boolean).join(' · ') || <span className="text-muted-foreground">—</span> },
        { key: 'cleared', label: 'Cleared', nowrap: true, muted: true, hideBelow: 'lg', cell: driver => driver.clearedAt ? <LocalTime iso={driver.clearedAt} format="date" /> : '—' },
        { key: 'status', label: 'Status', cell: driver => driver.onHold ? <Badge label="On hold" tone="danger" /> : driver.gettingReady ? <Badge label="Getting ready" tone="info" /> : <Badge label="Cleared" tone="success" /> },
      ]} empty={<EmptyState compact title={search ? 'Nobody matches' : 'No drivers here'} />} />
    </Card>
  </div>;
}
