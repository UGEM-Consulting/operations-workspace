import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { documentLabels, type DocumentKind } from './types';

export interface ExpiringItem { documentId: string; driverId: string; kind: string; expiresOn: string; firstName: string; lastName: string; status: string; owner: { name: string } | null; expired: boolean }
export interface ExpiringList { today: string; warningDays: number; items: ExpiringItem[] }

const day = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

/** Safety › Expiring documents: verified scans that have expired or expire soon, soonest first. */
export function ExpiringDocuments({ data }: { data: ExpiringList }) {
  return <div className="space-y-6">
    <PageHeader title="Expiring documents" description={`Verified licenses, medical cards and work authorizations that have expired or expire within ${data.warningDays} days. Open the driver to ask for a new scan.`} />
    <Card>
      <Table<ExpiringItem> caption="Documents that have expired or expire soon" rows={data.items} rowKey={item => item.documentId}
        empty={<EmptyState title="Nothing is expiring" description="No verified document has expired or expires soon." />}
        columns={[
          { key: 'driver', label: 'Driver', primary: true, cell: item => <Link className="font-medium underline" href={`/safety/drivers/${item.driverId}`}>{`${item.firstName} ${item.lastName}`.trim()}</Link> },
          { key: 'document', label: 'Document', cell: item => documentLabels[item.kind as DocumentKind] ?? 'Document' },
          { key: 'expires', label: 'Expires', cell: item => <>{day(item.expiresOn)} <Badge label={item.expired ? 'Expired' : 'Expiring'} tone={item.expired ? 'danger' : 'warning'} /></> },
          { key: 'owner', label: 'Owner', hideBelow: 'md', cell: item => item.owner?.name ?? '—' },
        ]} />
    </Card>
  </div>;
}
