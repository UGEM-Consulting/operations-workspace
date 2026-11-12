'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, Upload } from 'lucide-react';
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
import { CLOSED, DECIDING, driverBadge, driverTypes, existingMissing, license, type DriverRow, type SafetyPeople } from './types';

const name = (driver: { firstName: string; lastName: string }) => `${driver.firstName} ${driver.lastName}`.trim();
const readyWords: Record<string, string> = { UNIT: 'Unit', ACKNOWLEDGEMENT: 'Driver and Contractor Acknowledgement', BINDER: 'Truck binder and accident kit', PERMITS: 'Permits in the truck',
  SAMSARA: 'Samsara camera and ELD', DECALS: 'Decals and signs', ORIENTATION: 'Orientation', TELEGRAM_GROUP: 'Telegram group' };

/**
 * Safety › Drivers: every driver Safety is onboarding or has onboarded, newest first. Safety leads, managers and
 * administrators add leads here; the status shows how far each driver is.
 */
export function Drivers({ items, filters, people, canAdd, canAddExisting, currentUserId }: { items: DriverRow[]; filters: Record<string, string>; people: SafetyPeople; canAdd: boolean; canAddExisting: boolean; currentUserId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const query = filters.search.toLowerCase();
  const searched = items.filter(row => `${name(row)} ${row.phone} ${row.email ?? ''} ${row.safetyLead?.name ?? ''} ${row.owner?.name ?? ''}`.toLowerCase().includes(query));
  const open = (row: DriverRow) => !CLOSED.includes(row.status);
  // DECISION: waiting for the Safety manager (a decision, or a pre-adverse notice's waiting period).
  const deciding = (row: DriverRow) => DECIDING.includes(row.status);
  // MISSING: drivers added from a paper file whose record still needs something (open ones only).
  const missing = (row: DriverRow) => open(row) && !!row.existing && !!existingMissing(row.existing);
  // READY: cleared drivers with Ready for the road steps left (RoadReadyListScreen).
  const gettingReady = (row: DriverRow) => row.status === 'CLEARED' && !!row.readySummary && row.readySummary.done < row.readySummary.total;
  const visible = searched.filter(row => filters.status === 'ALL' || (filters.status === 'OPEN' ? open(row) : filters.status === 'CLOSED' ? !open(row)
    : filters.status === 'DECISION' ? deciding(row) : filters.status === 'MISSING' ? missing(row) : filters.status === 'READY' ? gettingReady(row) : row.status === filters.status));
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
      action={(canAdd || canAddExisting) && <div className="flex flex-wrap gap-2">{canAddExisting && <Button variant="outline" asChild><Link href="/safety/drivers/existing"><Upload aria-hidden="true" className="size-4" />Add existing drivers</Link></Button>}
        {canAdd && <Button onClick={() => { setAdding(true); setError(''); }}><Plus aria-hidden="true" className="size-4" />Add driver lead</Button>}</div>} />
    <Card>
      <FilterBar path="/safety/drivers" filters={filters} defaults={DRIVER_DEFAULTS} searchLabel="Search name, phone, email or Safety person" statuses={[
        { key: 'OPEN', label: 'Open', count: searched.filter(open).length },
        { key: 'LEAD', label: 'Leads', count: searched.filter(row => row.status === 'LEAD').length },
        { key: 'SCREENING', label: 'Screening', count: searched.filter(row => row.status === 'SCREENING').length },
        { key: 'DECISION', label: 'Awaiting decision', count: searched.filter(deciding).length },
        ...(items.some(row => row.readySummary) ? [{ key: 'READY', label: 'Getting ready', count: searched.filter(gettingReady).length }] : []),
        ...(items.some(row => row.existing) ? [{ key: 'MISSING', label: 'Missing details', count: searched.filter(missing).length }] : []),
        { key: 'CLOSED', label: 'Closed', count: searched.filter(row => !open(row)).length },
        { key: 'ALL', label: 'All', count: searched.length }]} />
      {filters.status === 'READY' ? <Table caption="Drivers getting ready for the road" className="border-t border-border" rows={visible} rowKey={row => row.id} columns={[
        { key: 'name', label: 'Driver', primary: true, cell: row => <Link href={`/safety/drivers/${row.id}`} className="block rounded-sm hover:underline focus-visible:outline-2"><Person name={name(row)} secondary={driverTypes[row.driverType]} /></Link> },
        { key: 'unit', label: 'Unit', hideBelow: 'md', cell: row => row.readySummary!.unit ?? <span className="text-muted-foreground">None yet</span> },
        { key: 'done', label: 'Done', nowrap: true, cell: row => `${row.readySummary!.done} of ${row.readySummary!.total}` },
        { key: 'next', label: 'Next step', cell: row => readyWords[row.readySummary!.next ?? ''] ?? '—' },
        { key: 'owner', label: 'Safety Manager', hideBelow: 'lg', cell: row => row.owner?.name ?? '—' },
        { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: row => <Button size="sm" variant="outline" asChild><Link href={`/safety/drivers/${row.id}#road-ready`}>Open<span className="sr-only"> {name(row)}</span></Link></Button> },
      ]} empty={<EmptyState compact title="Nobody getting ready" description="Drivers show here once cleared, until every Ready for the road step is done." />} />
      : filters.status === 'MISSING' ? <Table caption="Existing drivers with missing details" className="border-t border-border" rows={visible} rowKey={row => row.id} columns={[
        { key: 'name', label: 'Driver', primary: true, cell: row => <Link href={`/safety/drivers/${row.id}`} className="block rounded-sm hover:underline focus-visible:outline-2"><Person name={name(row)} secondary={driverTypes[row.driverType]} /></Link> },
        { key: 'missing', label: 'Missing', cell: row => existingMissing(row.existing!)?.text },
        { key: 'link', label: 'Catch-up link', hideBelow: 'lg', cell: row => row.existing!.catchUpSentAt ? <Badge label="Done" tone="success" /> : row.existing!.linkSentAt ? <Badge label="Sent" tone="info" /> : <span className="text-muted-foreground">Not sent</span> },
        { key: 'owner', label: 'Safety Manager', hideBelow: 'lg', cell: row => row.owner?.name ?? '—' },
        { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: row => { const next = existingMissing(row.existing!)?.next ?? 'Open';
          return <Button size="sm" variant={next === 'Open' || next === 'Record review' ? 'outline' : 'default'} asChild><Link href={`/safety/drivers/${row.id}`}>{next}<span className="sr-only"> for {name(row)}</span></Link></Button>; } },
      ]} empty={<EmptyState compact title="Nothing missing" description="Every driver added from a paper file has what their record needs." />} />
      : <Table caption="Drivers" className="border-t border-border" rows={visible} rowKey={row => row.id} columns={[
        { key: 'name', label: 'Driver', primary: true, cell: row => <Link href={`/safety/drivers/${row.id}`} className="block rounded-sm hover:underline focus-visible:outline-2"><Person name={name(row)} secondary={row.phone} /></Link> },
        { key: 'type', label: 'Type', hideBelow: 'md', cell: row => <>{driverTypes[row.driverType]}{license(row) && <span className="block text-[13px] text-muted-foreground">{license(row)}</span>}</> },
        { key: 'lead', label: 'Safety lead', hideBelow: 'lg', cell: row => row.safetyLead ? <>{row.safetyLead.name}{row.safetyLead.id === currentUserId && <span className="text-muted-foreground"> (you)</span>}</> : <span className="text-muted-foreground">Not set</span> },
        { key: 'owner', label: 'Safety Manager', hideBelow: 'xl', cell: row => row.owner?.name ?? <span className="text-muted-foreground">None yet</span> },
        { key: 'added', label: 'Added', nowrap: true, muted: true, hideBelow: 'md', cell: row => <LocalTime iso={row.createdAt} format="date" /> },
        { key: 'status', label: 'Status', cell: row => <Badge {...driverBadge(row.status)} /> },
      ]} empty={filtered ? <EmptyState compact title="Nothing matches these filters" description="Try another status or search." />
        : <EmptyState compact title="No drivers yet" description={canAdd ? 'Add a lead when a driver gets in touch.' : 'Safety leads add drivers when they get in touch.'} />}
        footer={<p className="text-[13px] text-muted-foreground">{visible.length} of {items.length} driver records.</p>} />}
    </Card>
    {adding && <Dialog open onClose={() => setAdding(false)} busy={pending} title="Add driver lead" description="Add what you know so far; you can fill in the rest later."
      actions={<Button type="submit" form="driver-lead">{pending ? 'Saving…' : 'Add lead'}</Button>}>
      <DriverForm id="driver-lead" leads={people.leads} defaultLeadId={people.leads.some(lead => lead.id === currentUserId) ? currentUserId : ''} onSubmit={add} error={error} />
    </Dialog>}
  </div>;
}
