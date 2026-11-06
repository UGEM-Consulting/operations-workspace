import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';

export interface TruckListRow { id: string; driverId: string; firstName: string; lastName: string; unit: string; vin: string; year: number; make: string; plate: string | null; plateState: string | null;
  archivedAt: string | null; insuranceExpiresOn: string | null; registrationExpiresOn: string | null; hasLease: boolean }
export interface TruckList { today: string; items: TruckListRow[] }

// An archived truck's dates no longer count, so it never shows as expired.
const dateCell = (value: string | null, today: string, archived: boolean) => value ? <><LocalTime iso={`${value}T12:00:00Z`} format="date" />{!archived && value < today &&<> <Badge label="Expired" tone="danger" /></>}</> : <span className="text-muted-foreground">Missing</span>;

/** Safety › Trucks: every owner-operator truck with the dates from its insurance and registration. Open the driver to change a truck or upload a document. */
export function Trucks({ data }: { data: TruckList }) {
  return <div className="space-y-6">
    <PageHeader title="Trucks" description="Owner-operators’ trucks and the dates on their insurance and registration. Open the driver to add a truck or upload a document." />
    <Card>
      <Table<TruckListRow> caption="Owner-operator trucks" rows={data.items} rowKey={row => row.id}
        empty={<EmptyState title="No trucks yet" description="Add a truck from an approved owner-operator’s page." />}
        columns={[
          { key: 'truck', label: 'Truck', primary: true, cell: row => <><span className="font-medium">Unit {row.unit}</span> · {row.year} {row.make}{row.archivedAt && <> <Badge label="Archived" /></>}</> },
          { key: 'driver', label: 'Driver', cell: row => <Link className="underline" href={`/safety/drivers/${row.driverId}`}>{`${row.firstName} ${row.lastName}`.trim()}</Link> },
          { key: 'insurance', label: 'Insurance', cell: row => dateCell(row.insuranceExpiresOn, data.today, !!row.archivedAt) },
          { key: 'registration', label: 'Registration', hideBelow: 'md', cell: row => dateCell(row.registrationExpiresOn, data.today, !!row.archivedAt) },
          { key: 'lease', label: 'Lease', hideBelow: 'lg', cell: row => row.hasLease ? 'On file' : <span className="text-muted-foreground">Missing</span> },
        ]} />
    </Card>
  </div>;
}
