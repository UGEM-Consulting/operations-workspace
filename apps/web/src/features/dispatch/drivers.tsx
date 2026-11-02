'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/feedback';
import { Input, Select, Textarea } from '@/components/ui/field';
import { FilterBar } from '@/components/ui/filter-bar';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { DISPATCH_DRIVER_DEFAULTS } from '@/lib/navigation';
import { useToday } from '@/features/safety/driver-documents';
import { driverTypes, licenseTypes, type DriverType, type LicenseType } from '@/features/safety/types';

export interface DispatchDriverRow { id: string; firstName: string; lastName: string; phone: string; driverType: DriverType; licenseType: LicenseType | null; version: number;
  clearedAt: string; clearedBy: string | null;
  assignment: { mcId: string; mc: string; memberId: string; dispatcher: string; teamId: string | null; team: string | null; truck: string | null; startedAt: string } | null }
export interface DispatchDriverOptions { mcs: { id: string; name: string; mcNumber: string | null; archived?: boolean; dispatchers: { id: string; name: string; teamId: string; team: string }[] }[] }

/**
 * Drivers Safety has cleared, for Dispatch: the ones waiting for an MC and a dispatcher and the ones already working with
 * one. Dispatcher managers and administrators assign anywhere (Dispatch › Drivers); a team lead assigns to dispatchers in
 * their own teams (`teamLead`, at /team/drivers). Dispatch sees the name, phone, driver type and license class, truck and
 * Cleared status only.
 */
export function DispatchDrivers({ items, filters, options, teamLead }: { items: DispatchDriverRow[]; filters: Record<string, string>; options: DispatchDriverOptions; teamLead: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [assigning, setAssigning] = useState<DispatchDriverRow | null>(null);
  const [mcId, setMcId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const path = teamLead ? '/team/drivers' : '/dispatch/drivers', name = (row: DispatchDriverRow) => `${row.firstName} ${row.lastName}`.trim();
  const query = filters.search.toLowerCase();
  const searched = items.filter(row => `${name(row)} ${row.phone} ${row.assignment?.truck ?? ''} ${row.assignment?.mc ?? ''} ${row.assignment?.dispatcher ?? ''}`.toLowerCase().includes(query));
  const visible = searched.filter(row => filters.status === 'ALL' || (filters.status === 'READY') === !row.assignment);
  const dispatchers = options.mcs.find(mc => mc.id === mcId)?.dispatchers ?? [];
  // An archived MC is a choice only for a driver already on it.
  const choices = (row: DispatchDriverRow | null) => options.mcs.filter(mc => !mc.archived || mc.id === row?.assignment?.mcId);
  function open(row: DispatchDriverRow) { const mcs = choices(row); setAssigning(row); setMcId(row.assignment?.mcId ?? (mcs.length === 1 ? mcs[0].id : '')); setError(''); }
  async function assign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assigning || pending) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPending(true); setError('');
    try {
      await mutate(`${teamLead ? 'team' : 'dispatch'}/drivers/${assigning.id}/assign`, 'POST', { version: assigning.version, mcId: form.mcId, memberId: form.memberId, startsOn: form.startsOn,
        ...(form.truck?.trim() ? { truck: form.truck } : {}), ...(form.reason?.trim() ? { reason: form.reason } : {}) });
      toast({ title: assigning.assignment ? 'Assignment changed' : `${name(assigning)} assigned` });
      setAssigning(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <div className="space-y-6">
    <PageHeader title="Drivers" description={teamLead ? 'Drivers Safety has cleared. Assign the ones waiting to a dispatcher in your team; changes are kept as history.'
      : 'Drivers Safety has cleared. Assign each one to an MC and a dispatcher; changes later are kept as history.'} />
    <Card>
      <FilterBar path={path} filters={filters} defaults={DISPATCH_DRIVER_DEFAULTS} searchLabel="Search name, phone, truck, MC or dispatcher" statuses={[
        { key: 'READY', label: 'Ready to assign', count: searched.filter(row => !row.assignment).length },
        { key: 'ASSIGNED', label: teamLead ? 'In your team' : 'Assigned', count: searched.filter(row => row.assignment).length },
        { key: 'ALL', label: 'All', count: searched.length }]} />
      <Table caption={filters.status === 'READY' ? 'Drivers ready to assign' : 'Drivers'} className="border-t border-border" rows={visible} rowKey={row => row.id} columns={[
        { key: 'driver', label: 'Driver', primary: true, cell: row => <Person name={name(row)} secondary={row.phone} /> },
        { key: 'type', label: 'Type', hideBelow: 'lg', cell: row => `${driverTypes[row.driverType] ?? row.driverType}${row.licenseType ? ` · ${licenseTypes[row.licenseType] ?? row.licenseType}` : ''}` },
        { key: 'work', label: 'MC and dispatcher', hideBelow: 'md', cell: row => row.assignment ? <>{row.assignment.dispatcher}<span className="block text-[13px] text-muted-foreground">{row.assignment.mc}{row.assignment.team ? ` · ${row.assignment.team}` : ''}</span></>
          : <span className="text-muted-foreground">Not assigned</span> },
        { key: 'truck', label: 'Truck', hideBelow: 'xl', muted: true, cell: row => row.assignment?.truck ?? '—' },
        { key: 'cleared', label: 'Cleared', muted: true, nowrap: true, hideBelow: 'lg', cell: row => <><LocalTime iso={row.clearedAt} format="date" />{row.clearedBy ? ` by ${row.clearedBy}` : ''}</> },
        { key: 'status', label: 'Status', cell: () => <Badge label="Cleared" tone="success" /> },
        { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: row => <Button size="sm" variant={row.assignment ? 'outline' : 'default'} disabled={!choices(row).length} onClick={() => open(row)}>
          {row.assignment ? 'Change' : 'Assign'}<span className="sr-only"> {name(row)}</span></Button> },
      ]} empty={<EmptyState compact title={filters.status === 'READY' && !filters.search ? 'No drivers waiting' : 'Nothing matches these filters'} description="Drivers appear here once Safety marks them as cleared." />} />
    </Card>
    {assigning && <Dialog open onClose={() => setAssigning(null)} busy={pending} title={`${assigning.assignment ? 'Change' : 'Assign'} ${name(assigning)}`}
      description={assigning.assignment ? 'The current MC and dispatcher end on the start date and stay in the history.' : 'Their first MC and dispatcher. Both are kept as history when they change.'}
      actions={<Button type="submit" form="assign-driver">{pending ? 'Saving…' : <><UserCheck aria-hidden="true" className="size-4" />{assigning.assignment ? 'Save change' : 'Assign driver'}</>}</Button>}>
      <form id="assign-driver" onSubmit={assign} className="space-y-4">
        <Select label="MC" name="mcId" required value={mcId} onChange={event => setMcId(event.target.value)} placeholder="Choose an MC" width="full"
          options={choices(assigning).map(mc => ({ value: mc.id, label: `${mc.mcNumber ? `${mc.name} · MC ${mc.mcNumber}` : mc.name}${mc.archived ? ' (archived)' : ''}` }))} />
        <Select key={mcId} label="Dispatcher" name="memberId" required disabled={!mcId} placeholder="Choose a dispatcher" width="full" defaultValue={assigning.assignment?.mcId === mcId ? assigning.assignment.memberId : undefined}
          options={dispatchers.map(person => ({ value: person.id, label: `${person.name} · ${person.team}` }))} hint={teamLead ? 'Active dispatchers in your team.' : 'Active dispatchers in teams under this MC.'} />
        <Input label="Starts on" name="startsOn" type="date" required width="sm" max={today ?? undefined} defaultValue={today ?? undefined} />
        <Input label="Truck" name="truck" optional maxLength={40} width="md" defaultValue={assigning.assignment?.truck ?? ''} hint="Unit number, for example 233." />
        {assigning.assignment && <Textarea label="Why it’s changing" name="reason" required maxLength={500} rows={2} />}
        <p className="text-[13px] text-muted-foreground">Safety keeps the qualification file and owns renewals. Dispatch sees the name, phone, truck and Cleared status only.</p>
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
