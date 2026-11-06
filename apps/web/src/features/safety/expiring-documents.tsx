import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { documentLabels, ownerDocumentLabels, type DocumentKind } from './types';

export interface ExpiringItem { documentId: string; driverId: string; kind: string; expiresOn: string; firstName: string; lastName: string; status: string; truck?: string | null; owner: { name: string } | null; expired: boolean }
export interface DueReview { driverId: string; firstName: string; lastName: string; owner: string | null; lastReviewedOn: string | null; dueOn: string; notQualified: boolean; overdue: boolean }
export interface DueTest { driverId: string; firstName: string; lastName: string; kind: 'DRUG' | 'ALCOHOL'; result: string; testedOn: string; owner: string | null }
export interface DueIncident { incidentId: string; driverId: string; firstName: string; lastName: string; kind: 'ACCIDENT' | 'VIOLATION' | 'INSPECTION'; occurredOn: string; owner: string | null }
export interface DueList { today: string; warningDays: number; items: DueReview[]; tests?: DueTest[]; incidents?: DueIncident[] }
export interface ExpiringList { today: string; warningDays: number; items: ExpiringItem[] }

const day = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

/** Safety › Expiring documents: verified scans that have expired or expire soon, soonest first. */
export function ExpiringDocuments({ data, reviews }: { data: ExpiringList; reviews: DueList }) {
  return <div className="space-y-6">
    <PageHeader title="Expiring documents" description={`Verified licenses, medical cards and work authorizations that have expired or expire within ${data.warningDays} days, and yearly driver reviews that are due. Open the driver to act.`} />
    <Card>
      <Table<ExpiringItem> caption="Documents that have expired or expire soon" rows={data.items} rowKey={item => item.documentId}
        empty={<EmptyState title="Nothing is expiring" description="No verified document has expired or expires soon." />}
        columns={[
          { key: 'driver', label: 'Driver', primary: true, cell: item => <Link className="font-medium underline" href={`/safety/drivers/${item.driverId}`}>{`${item.firstName} ${item.lastName}`.trim()}</Link> },
          { key: 'document', label: 'Document', cell: item => (documentLabels[item.kind as DocumentKind] ?? ownerDocumentLabels[item.kind as keyof typeof ownerDocumentLabels] ?? 'Document') + (item.truck ? ` · unit ${item.truck}` : '') },
          { key: 'expires', label: 'Expires', cell: item => <>{day(item.expiresOn)} <Badge label={item.expired ? 'Expired' : 'Expiring'} tone={item.expired ? 'danger' : 'warning'} /></> },
          { key: 'owner', label: 'Owner', hideBelow: 'md', cell: item => item.owner?.name ?? '—' },
        ]} />
    </Card>
    <Card>
      <Table<DueReview> caption="Yearly reviews that are due" rows={reviews.items} rowKey={item => item.driverId}
        empty={<EmptyState title="No yearly review is due" description={`No cleared driver is due for a yearly review within ${reviews.warningDays} days.`} />}
        columns={[
          { key: 'driver', label: 'Yearly review', primary: true, cell: item => <Link className="font-medium underline" href={`/safety/drivers/${item.driverId}`}>{`${item.firstName} ${item.lastName}`.trim()}</Link> },
          { key: 'due', label: 'Due', cell: item => <>{day(item.dueOn)} <Badge label={item.notQualified ? 'Not qualified' : item.overdue ? 'Overdue' : 'Due soon'} tone={item.notQualified || item.overdue ? 'danger' : 'warning'} /></> },
          { key: 'last', label: 'Last review', hideBelow: 'md', cell: item => item.lastReviewedOn ? day(item.lastReviewedOn) : 'None yet' },
          { key: 'owner', label: 'Owner', hideBelow: 'md', cell: item => item.owner ?? '—' },
        ]} />
    </Card>
    {reviews.tests && reviews.tests.length > 0 && <Card>
      <Table<DueTest> caption="Test results that need follow-up" rows={reviews.tests} rowKey={item => `${item.driverId}-${item.kind}`}
        columns={[
          { key: 'driver', label: 'Test follow-up', primary: true, cell: item => <Link className="font-medium underline" href={`/safety/drivers/${item.driverId}`}>{`${item.firstName} ${item.lastName}`.trim()}</Link> },
          { key: 'test', label: 'Latest result', cell: item => <>{item.kind === 'DRUG' ? 'Drug' : 'Alcohol'} · {day(item.testedOn)} <Badge label={item.result === 'REFUSED' ? 'Refused' : 'Not negative'} tone="danger" /></> },
          { key: 'owner', label: 'Owner', hideBelow: 'md', cell: item => item.owner ?? '—' },
        ]} />
    </Card>}
    {reviews.incidents && reviews.incidents.length > 0 && <Card>
      <Table<DueIncident> caption="Incidents that need a decision" rows={reviews.incidents} rowKey={item => item.incidentId}
        columns={[
          { key: 'driver', label: 'Open incidents', primary: true, cell: item => <Link className="font-medium underline" href={`/safety/drivers/${item.driverId}`}>{`${item.firstName} ${item.lastName}`.trim()}</Link> },
          { key: 'what', label: 'What', cell: item => <>{item.kind === 'ACCIDENT' ? 'Accident' : 'Violation'} · {day(item.occurredOn)} <Badge label={item.kind === 'ACCIDENT' ? 'Preventability open' : 'Pending'} tone="warning" /></> },
          { key: 'owner', label: 'Owner', hideBelow: 'md', cell: item => item.owner ?? '—' },
        ]} />
    </Card>}
  </div>;
}
