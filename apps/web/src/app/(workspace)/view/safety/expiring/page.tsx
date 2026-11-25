import Link from 'next/link';
import { requirePage } from '@/lib/auth';
import { Card, CardHeader } from '@/components/ui/card';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { documentLabels, type DocumentKind } from '@/features/safety/types';
import { NotAvailable, viewRead, ViewOnlyMark } from '@/features/view/ui';
export const metadata = { title: 'Expiring documents · view only' };

interface ViewExpiring { today: string; warningDays: number;
  items: { driverId: string; kind: string; expiresOn: string; expired: boolean; truck: string | null; firstName: string; lastName: string; owner: { name: string } | string | null }[];
  units: { unitId: string; number: string; kind: string; document: string; dueOn: string; expired: boolean; responsible: string | null; owner: string | null; driverNow: string | null }[] }
const OWNER_DOCS: Record<string, string> = { INSURANCE: 'Insurance', REGISTRATION: 'Registration' };
const UNIT_DOCS: Record<string, string> = { REGISTRATION: 'Registration', INSPECTION: 'Yearly inspection' };
const day = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const due = (value: string, expired: boolean) => <span className="flex flex-wrap items-center gap-1.5">{day(value)}{expired && <Badge label="Expired" tone="danger" />}</span>;

/** Safety › Expiring documents read only: what expired or expires soon, for drivers and units. Renewing stays with Safety. */
export default async function ViewExpiringPage() {
  await requirePage('viewexpiring');
  const data = await viewRead<ViewExpiring>('safety/expiring', 'expiring documents');
  if (!data) return <NotAvailable back="/account/security" label="Account security" />;
  const owner = (value: { name: string } | string | null) => typeof value === 'string' ? value : value?.name ?? null;
  return <div className="space-y-6">
    <PageHeader title="Expiring documents" badge={<ViewOnlyMark />} description={`What expired or expires in the next ${data.warningDays} days.`} />
    <Card>
      <CardHeader title="Drivers" />
      <Table caption="Driver documents" className="mt-3 border-t border-border" rows={data.items} rowKey={item => `${item.driverId}-${item.kind}-${item.truck ?? ''}`} columns={[
        { key: 'driver', label: 'Driver', primary: true, cell: item => <Link href={`/view/safety/drivers/${item.driverId}`} className="font-medium text-foreground hover:underline">{item.firstName} {item.lastName}</Link> },
        { key: 'doc', label: 'Document', cell: item => item.truck ? `${OWNER_DOCS[item.kind] ?? item.kind} · truck ${item.truck}` : documentLabels[item.kind as DocumentKind] ?? item.kind },
        { key: 'expires', label: 'Expires', nowrap: true, cell: item => due(item.expiresOn, item.expired) },
        { key: 'owner', label: 'Safety Manager', hideBelow: 'md', cell: item => owner(item.owner) ?? <span className="text-muted-foreground">—</span> },
      ]} empty={<p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">Nothing expiring soon.</p>} />
    </Card>
    <Card>
      <CardHeader title="Units" />
      <Table caption="Unit dates" className="mt-3 border-t border-border" rows={data.units} rowKey={item => `${item.unitId}-${item.document}`} columns={[
        { key: 'unit', label: 'Unit', primary: true, cell: item => <span className="font-medium">{item.number}</span> },
        { key: 'doc', label: 'What', cell: item => UNIT_DOCS[item.document] ?? `${item.document.replace(/_/g, ' ').toLowerCase().replace(/^\w/, letter => letter.toUpperCase())} permit` },
        { key: 'due', label: 'Due', nowrap: true, cell: item => due(item.dueOn, item.expired) },
        { key: 'driver', label: 'Driver now', hideBelow: 'md', cell: item => item.driverNow ?? <span className="text-muted-foreground">—</span> },
      ]} empty={<p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">Nothing due soon.</p>} />
    </Card>
  </div>;
}
