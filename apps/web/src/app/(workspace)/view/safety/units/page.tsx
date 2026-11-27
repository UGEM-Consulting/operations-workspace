import { requirePage } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { FilterBar } from '@/components/ui/filter-bar';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { OpenFile } from '@/features/view/files';
import { NotAvailable, viewRead, ViewOnlyMark } from '@/features/view/ui';
import { dayLabel } from '@/lib/navigation';
export const metadata = { title: 'Units · view only' };

interface ViewUnit { id: string; number: string; kind: 'SEMI' | 'PICKUP' | 'TRAILER'; trailerType: string | null; year: number | null; make: string | null; ownerKind: 'COMPANY' | 'OWNER' | 'DRIVER'; owner: string | null;
  registrationExpiresOn: string | null; inspectedOn: string | null; outOfServiceAt: string | null; responsible: string | null; permits: { kind: string; expiresOn: string | null }[]; driverNow: string | null;
  files: { id: string; kind: string; createdAt: string }[] | null }
const DEFAULTS: Record<string, string> = { status: 'TRUCKS', search: '' };
const KIND: Record<string, string> = { SEMI: 'Semi truck', PICKUP: 'Pickup', TRAILER: 'Trailer' };
const FILE: Record<string, string> = { REGISTRATION: 'Registration', INSPECTION: 'Inspection', PERMITS: 'Permits', OTHER: 'Other paper' };
const day = (value: string) => dayLabel(value);

/** Safety › Units read only: trucks and trailers, whose they are, their dates and who drives them; unit papers when given. */
export default async function ViewUnitsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('viewunits');
  const query = await searchParams;
  const filters = { status: ['TRUCKS', 'TRAILERS', 'ALL'].includes(String(query.status)) ? String(query.status) : 'TRUCKS', search: typeof query.search === 'string' ? query.search.slice(0, 100) : '' };
  const data = await viewRead<{ today: string; withFiles: boolean; items: ViewUnit[] }>('safety/units', 'units');
  if (!data) return <NotAvailable back="/account/security" label="Account security" />;
  const search = filters.search.trim().toLowerCase();
  const matching = data.items.filter(unit => !search || `${unit.number} ${unit.make ?? ''} ${unit.owner ?? ''} ${unit.driverNow ?? ''}`.toLowerCase().includes(search));
  const rows = matching.filter(unit => filters.status === 'ALL' || (filters.status === 'TRAILERS') === (unit.kind === 'TRAILER'));
  const date = (value: string | null) => value ? <span className="flex flex-wrap items-center gap-1.5">{day(value)}{value < data.today && <Badge label="Expired" tone="danger" />}</span> : <span className="text-muted-foreground">—</span>;
  return <div className="space-y-6">
    <PageHeader title="Units" badge={<ViewOnlyMark />} description="Trucks and trailers, whose they are, their dates and who has them now." />
    <Card>
      <FilterBar path="/view/safety/units" filters={filters} defaults={DEFAULTS} searchLabel="Search unit, owner or driver" statuses={[
        { key: 'TRUCKS', label: 'Trucks', count: matching.filter(unit => unit.kind !== 'TRAILER').length }, { key: 'TRAILERS', label: 'Trailers', count: matching.filter(unit => unit.kind === 'TRAILER').length },
        { key: 'ALL', label: 'All', count: matching.length }]} />
      <Table caption="Units" className="border-t border-border" rows={rows} rowKey={unit => unit.id} columns={[
        { key: 'unit', label: 'Unit', primary: true, cell: unit => <span className="grid gap-0.5"><span className="font-medium">{unit.number}</span><span className="text-[13px] text-muted-foreground">{[KIND[unit.kind], unit.year, unit.make].filter(Boolean).join(' · ')}</span></span> },
        { key: 'owner', label: 'Owner', hideBelow: 'md', cell: unit => unit.ownerKind === 'COMPANY' ? 'Company' : unit.owner ?? '—' },
        { key: 'driver', label: 'Driver now', cell: unit => unit.driverNow ?? <span className="text-muted-foreground">—</span> },
        { key: 'registration', label: 'Registration', nowrap: true, cell: unit => date(unit.registrationExpiresOn) },
        { key: 'inspected', label: 'Last inspection', nowrap: true, hideBelow: 'lg', cell: unit => unit.inspectedOn ? day(unit.inspectedOn) : <span className="text-muted-foreground">—</span> },
        { key: 'status', label: 'Status', cell: unit => unit.outOfServiceAt ? <Badge label="Out of service" tone="warning" /> : <Badge label="In service" tone="success" /> },
        ...(data.withFiles ? [{ key: 'files', label: 'Papers', cell: (unit: ViewUnit) => unit.files?.length ? <span className="flex flex-wrap gap-1">{unit.files.map(file => <OpenFile key={file.id} url={`/api/backend/view/safety/units/${unit.id}/files/${file.id}/file`} title={`${unit.number} · ${FILE[file.kind] ?? file.kind}`} label={`View ${FILE[file.kind] ?? file.kind} of unit ${unit.number}`} />)}</span> : <span className="text-muted-foreground">—</span> }] : []),
      ]} empty={<EmptyState compact title={search ? 'Nothing matches' : 'No units here'} />} />
    </Card>
  </div>;
}
