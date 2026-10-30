'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Person } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/feedback';
import { FilterBar } from '@/components/ui/filter-bar';
import { LocalTime } from '@/components/ui/local-time';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { DRIVER_DEFAULTS } from '@/lib/navigation';
import { DriverForm, driverBody } from './driver-form';
import { CLOSED, driverStatus, driverTypes, license, type DriverRow, type SafetyPeople } from './types';

const name = (driver: { firstName: string; lastName: string }) => `${driver.firstName} ${driver.lastName}`.trim();

/**
 * Safety › Drivers: every driver Safety is onboarding or has onboarded, newest first. Safety leads, managers and
 * administrators add leads here; the status shows how far each driver is.
 */
export function Drivers({ items, filters, people, canAdd, currentUserId }: { items: DriverRow[]; filters: Record<string, string>; people: SafetyPeople; canAdd: boolean; currentUserId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const query = filters.search.toLowerCase();
  const searched = items.filter(row => `${name(row)} ${row.phone} ${row.email ?? ''} ${row.safetyLead?.name ?? ''} ${row.owner?.name ?? ''}`.toLowerCase().includes(query));
  const open = (row: DriverRow) => !CLOSED.includes(row.status);
  const visible = searched.filter(row => filters.status === 'ALL' || (filters.status === 'OPEN' ? open(row) : filters.status === 'CLOSED' ? !open(row) : row.status === filters.status));
  const filtered = filters.search !== '' || filters.status !== DRIVER_DEFAULTS.status;
  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError('');
    try {
      const created = await mutate<{ id: string }>('safety/drivers', 'POST', driverBody(new FormData(event.currentTarget)));
      toast({ title: 'Driver lead added' });
      setAdding(false); router.push(`/safety/drivers/${created.id}`);
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <div className="space-y-6">
    <PageHeader title="Drivers" description="Drivers Safety is onboarding or has onboarded. A driver starts as a lead; only cleared drivers can be assigned to a dispatcher."
      action={canAdd && <Button onClick={() => { setAdding(true); setError(''); }}><Plus aria-hidden="true" className="size-4" />Add driver lead</Button>} />
    <Card>
      <FilterBar path="/safety/drivers" filters={filters} defaults={DRIVER_DEFAULTS} searchLabel="Search name, phone, email or Safety person" statuses={[
        { key: 'OPEN', label: 'Open', count: searched.filter(open).length },
        { key: 'LEAD', label: 'Leads', count: searched.filter(row => row.status === 'LEAD').length },
        { key: 'CLOSED', label: 'Closed', count: searched.filter(row => !open(row)).length },
        { key: 'ALL', label: 'All', count: searched.length }]} />
      <Table caption="Drivers" className="border-t border-border" rows={visible} rowKey={row => row.id} columns={[
        { key: 'name', label: 'Driver', primary: true, cell: row => <Link href={`/safety/drivers/${row.id}`} className="block rounded-sm hover:underline focus-visible:outline-2"><Person name={name(row)} secondary={row.phone} /></Link> },
        { key: 'type', label: 'Type', hideBelow: 'md', cell: row => <>{driverTypes[row.driverType]}{license(row) && <span className="block text-[13px] text-muted-foreground">{license(row)}</span>}</> },
        { key: 'lead', label: 'Safety lead', hideBelow: 'lg', cell: row => row.safetyLead ? <>{row.safetyLead.name}{row.safetyLead.id === currentUserId && <span className="text-muted-foreground"> (you)</span>}</> : <span className="text-muted-foreground">Not set</span> },
        { key: 'owner', label: 'Owner', hideBelow: 'xl', cell: row => row.owner?.name ?? <span className="text-muted-foreground">None yet</span> },
        { key: 'added', label: 'Added', nowrap: true, muted: true, hideBelow: 'md', cell: row => <LocalTime iso={row.createdAt} format="date" /> },
        { key: 'status', label: 'Status', cell: row => <Badge label={driverStatus[row.status].label} tone={driverStatus[row.status].tone} /> },
      ]} empty={filtered ? <EmptyState compact title="Nothing matches these filters" description="Try another status or search." />
        : <EmptyState compact title="No drivers yet" description={canAdd ? 'Add a lead when a driver gets in touch.' : 'Safety leads add drivers when they get in touch.'} />}
        footer={<p className="text-[13px] text-muted-foreground">{visible.length} of {items.length} driver records.</p>} />
    </Card>
    {adding && <Dialog open onClose={() => setAdding(false)} busy={pending} title="Add driver lead" description="Add what you know so far; you can fill in the rest later."
      actions={<Button type="submit" form="driver-lead">{pending ? 'Saving…' : 'Add lead'}</Button>}>
      <DriverForm id="driver-lead" leads={people.leads} defaultLeadId={people.leads.some(lead => lead.id === currentUserId) ? currentUserId : ''} onSubmit={add} error={error} />
    </Dialog>}
  </div>;
}
