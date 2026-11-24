import Link from 'next/link';
import { requirePage } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { FilterBar } from '@/components/ui/filter-bar';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { CLOSED, driverBadge, driverTypes, licenseTypes, type DriverStatus, type DriverType, type LicenseType } from '@/features/safety/types';
import { NotAvailable, viewRead, ViewOnlyMark } from '@/features/view/ui';
export const metadata = { title: 'Drivers · view only' };

interface ViewDriver { id: string; firstName: string; lastName: string; driverType: DriverType; licenseType: LicenseType | null; licenseState: string | null; status: DriverStatus; owner: { name: string } | string | null; onHold: boolean }
const DEFAULTS: Record<string, string> = { status: 'OPEN', search: '' };

/** Safety › Drivers read only: every driver's status, license and Safety Manager, opening their page. */
export default async function ViewSafetyDriversPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('viewdrivers');
  const query = await searchParams;
  const filters = { status: ['OPEN', 'CLEARED', 'CLOSED', 'ALL'].includes(String(query.status)) ? String(query.status) : 'OPEN', search: typeof query.search === 'string' ? query.search.slice(0, 100) : '' };
  const data = await viewRead<{ items: ViewDriver[] }>('safety/drivers', 'drivers');
  if (!data) return <NotAvailable back="/account/security" label="Account security" />;
  const search = filters.search.trim().toLowerCase();
  const matching = data.items.filter(driver => !search || `${driver.firstName} ${driver.lastName}`.toLowerCase().includes(search));
  const closed = (driver: ViewDriver) => CLOSED.includes(driver.status);
  const rows = matching.filter(driver => filters.status === 'ALL' || (filters.status === 'CLOSED' ? closed(driver) : filters.status === 'CLEARED' ? driver.status === 'CLEARED' : !closed(driver)));
  const owner = (driver: ViewDriver) => typeof driver.owner === 'string' ? driver.owner : driver.owner?.name ?? null;
  return <div className="space-y-6">
    <PageHeader title="Drivers" badge={<ViewOnlyMark />} description="Every driver Safety works with: where they are, their license and their Safety Manager." />
    <Card>
      <FilterBar path="/view/safety/drivers" filters={filters} defaults={DEFAULTS} searchLabel="Search name" statuses={[
        { key: 'OPEN', label: 'Open', count: matching.filter(driver => !closed(driver)).length }, { key: 'CLEARED', label: 'Cleared', count: matching.filter(driver => driver.status === 'CLEARED').length },
        { key: 'CLOSED', label: 'Closed', count: matching.filter(closed).length }, { key: 'ALL', label: 'All', count: matching.length }]} />
      <Table caption="Drivers" className="border-t border-border" rows={rows} rowKey={driver => driver.id} columns={[
        { key: 'name', label: 'Driver', primary: true, cell: driver => <Link href={`/view/safety/drivers/${driver.id}`} className="font-medium text-foreground hover:underline">{driver.firstName} {driver.lastName}</Link> },
        { key: 'type', label: 'Type', hideBelow: 'md', cell: driver => driverTypes[driver.driverType] ?? driver.driverType },
        { key: 'license', label: 'License', hideBelow: 'md', cell: driver => [driver.licenseType ? licenseTypes[driver.licenseType] : null, driver.licenseState].filter(Boolean).join(' · ') || '—' },
        { key: 'owner', label: 'Safety Manager', hideBelow: 'lg', cell: driver => owner(driver) ?? <span className="text-muted-foreground">—</span> },
        { key: 'status', label: 'Status', cell: driver => { const badge = driverBadge(driver.status); return <span className="flex flex-wrap gap-1"><Badge label={badge.label} tone={badge.tone} />{driver.onHold && <Badge label="On hold" tone="danger" />}</span>; } },
      ]} empty={<EmptyState compact title={search ? 'Nobody matches' : 'No drivers here'} />} />
    </Card>
  </div>;
}
