'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/feedback';
import { Input, RadioGroup, Select } from '@/components/ui/field';
import { FilterBar } from '@/components/ui/filter-bar';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { TabLinks } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { PageHeader, StatCard } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { US_STATES } from './types';
import { daysLeft, inspectionDue, permitShort, unitKinds, unitStatus, type OwnerRow, type UnitKind, type UnitList, type UnitRow } from './units-types';

export type UnitsTab = 'trucks' | 'trailers' | 'owners';
import { UNIT_DEFAULTS } from '@/lib/navigation';
const states = US_STATES.map(state => ({ value: state, label: state }));
const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;

/** A date with its state: expired, due within 60 days, or nothing to say. */
export function DateCell({ value, today, missing = 'Not recorded' }: { value: string | null; today: string; missing?: string }) {
  if (!value) return <span className="text-muted-foreground">{missing}</span>;
  const left = daysLeft(value, today);
  return <span className="whitespace-nowrap">{day(value)}{left < 0 ? <> <Badge label="Expired" tone="danger" /></> : left <= 60 ? <> <Badge label="Due soon" tone="warning" /></> : null}</span>;
}
/** "5 · Dec 31, 2026", or which permit is missing. */
function permitsCell(row: UnitRow, data: UnitList) {
  const needed = data.permitsFor[row.kind] ?? [];
  if (!needed.length) return <span className="text-muted-foreground">None</span>;
  const missing = needed.filter(kind => !row.permits.some(permit => permit.kind === kind));
  const soonest = row.permits.map(permit => permit.expiresOn).sort()[0];
  return <span className="whitespace-nowrap">{needed.length - missing.length} of {needed.length}{soonest ? <> · {day(soonest)}</> : null}
    {missing.length > 0 && <> <Badge label={missing.length === 1 ? `${permitShort[missing[0]]} missing` : `${missing.length} missing`} tone="danger" /></>}</span>;
}

/**
 * Safety › Units (UnitsScreen, TruckOwnersScreen): trucks and trailers with their owner and the dates that matter, and the
 * truck owners. The papers live in DataTruck and the binder; the workspace keeps the dates for reminders.
 */
export function Units({ tab, data, owners, filters, currentUserId }: { tab: UnitsTab; data: UnitList; owners: OwnerRow[]; filters: Record<string, string>; currentUserId: string }) {
  const [adding, setAdding] = useState<'unit' | 'owner' | null>(null);
  const query = filters.search.toLowerCase();
  const inTab = data.items.filter(row => tab === 'trailers' ? row.kind === 'TRAILER' : row.kind !== 'TRAILER');
  const searched = inTab.filter(row => `${row.number} ${row.vin} ${row.plate ?? ''} ${row.owner ?? ''} ${row.driverNow ?? ''}`.toLowerCase().includes(query));
  const current = searched.filter(row => !row.archivedAt);
  const visible = filters.status === 'ARCHIVED' ? searched.filter(row => row.archivedAt) : current.filter(row => filters.status === 'ALL' || (filters.status === 'MINE' ? row.responsibleId === currentUserId
    : filters.status === 'SEMI' || filters.status === 'PICKUP' ? row.kind === filters.status : true));
  const due = (row: UnitRow) => [row.registrationExpiresOn, inspectionDue(row.inspectedOn), ...row.permits.map(permit => permit.expiresOn)].some(date => date && daysLeft(date, data.today) <= 60);
  const tabs = [{ key: 'trucks', label: 'Trucks', count: data.items.filter(row => row.kind !== 'TRAILER' && !row.archivedAt).length, href: '/safety/units' },
    { key: 'trailers', label: 'Trailers', count: data.items.filter(row => row.kind === 'TRAILER' && !row.archivedAt).length, href: '/safety/units?tab=trailers' },
    { key: 'owners', label: 'Owners', count: owners.filter(row => !row.archivedAt).length, href: '/safety/units?tab=owners' }];
  return <div className="space-y-6">
    <PageHeader title="Units" description={<>Trucks and trailers with their registration, yearly inspection and permits. Dispatch picks a driver’s truck from this list. Next free number: {data.next.truck}{tab === 'trailers' ? <> (trailers {data.next.trailer})</> : null}.</>}
      action={tab === 'owners' ? <Button onClick={() => setAdding('owner')}><Plus aria-hidden="true" className="size-4" />Add owner</Button> : <div className="flex flex-wrap gap-2"><Button variant="outline" asChild><Link href="/safety/units/import"><Upload aria-hidden="true" className="size-4" />Add from a file</Link></Button><Button onClick={() => setAdding('unit')}><Plus aria-hidden="true" className="size-4" />Add unit</Button></div>} />
    <TabLinks label="Units" value={tab} items={tabs} />
    {tab === 'owners' ? <OwnersTable owners={owners} /> : <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="In service" value={current.filter(row => !row.outOfServiceAt).length} detail="Dispatch can pick these" href="/safety/units" />
        <StatCard label="Out of service" value={current.filter(row => row.outOfServiceAt).length} detail="In the shop or waiting for a part" href="/safety/units" tone="warning" />
        <StatCard label="Need attention" value={current.filter(due).length} detail="Expired or due within 60 days" href="/safety/expiring" tone="danger" />
        <StatCard label="Without a driver" value={current.filter(row => !row.driverNow).length} detail="Nobody has it now" href="/safety/units" />
      </div>
      <Card>
        <FilterBar path="/safety/units" filters={filters} defaults={UNIT_DEFAULTS} searchLabel="Search unit, VIN, plate, owner or driver" statuses={[
          { key: 'ALL', label: 'All', count: current.length },
          ...(tab === 'trucks' ? [{ key: 'SEMI', label: 'Semi trucks', count: current.filter(row => row.kind === 'SEMI').length }, { key: 'PICKUP', label: 'Pickups', count: current.filter(row => row.kind === 'PICKUP').length }] : []),
          { key: 'MINE', label: 'Mine', count: current.filter(row => row.responsibleId === currentUserId).length },
          { key: 'ARCHIVED', label: 'Archived', count: searched.filter(row => row.archivedAt).length }]} />
        <Table caption={tab === 'trailers' ? 'Trailers' : 'Trucks'} className="border-t border-border" rows={visible} rowKey={row => row.id} columns={[
          { key: 'unit', label: 'Unit', primary: true, cell: row => <Link href={`/safety/units/${row.id}`} className="block rounded-sm hover:underline focus-visible:outline-2">
            <Person name={row.number} secondary={`${row.kind === 'TRAILER' ? row.trailerType ?? 'Trailer' : unitKinds[row.kind]} · ${row.ownerKind === 'COMPANY' ? 'company trailer' : row.ownerKind === 'DRIVER' ? 'owner-operator' : row.owner ?? ''}`} /></Link> },
          { key: 'driver', label: tab === 'trailers' ? 'With' : 'Driver now', cell: row => row.driverNow ?? <span className="text-muted-foreground">{tab === 'trailers' ? 'Free' : 'No driver'}</span> },
          { key: 'registration', label: 'Registration', hideBelow: 'lg', cell: row => <DateCell value={row.registrationExpiresOn} today={data.today} /> },
          { key: 'inspection', label: 'Yearly inspection', hideBelow: 'lg', cell: row => <DateCell value={inspectionDue(row.inspectedOn)} today={data.today} /> },
          ...(tab === 'trucks' ? [{ key: 'permits', label: 'Permits', hideBelow: 'lg' as const, cell: (row: UnitRow) => permitsCell(row, data) }] : []),
          { key: 'status', label: 'Status', cell: row => <Badge {...unitStatus(row)} /> },
        ]} empty={<EmptyState compact title={filters.search || filters.status !== 'ALL' ? 'Nothing matches these filters' : tab === 'trailers' ? 'No trailers yet' : 'No units yet'}
          description={filters.search || filters.status !== 'ALL' ? 'Try another filter or search.' : 'Add a unit with Add unit.'} />}
          footer={<p className="text-[13px] text-muted-foreground">{visible.length} of {inTab.length} {tab === 'trailers' ? 'trailers' : 'trucks'}.</p>} />
      </Card></>}
    {adding === 'unit' && <UnitDialog data={data} kind={tab === 'trailers' ? 'TRAILER' : 'SEMI'} onClose={() => setAdding(null)} />}
    {adding === 'owner' && <OwnerDialog onClose={() => setAdding(null)} />}
  </div>;
}

function OwnersTable({ owners }: { owners: OwnerRow[] }) {
  return <Card>
    <Table caption="Truck owners" rows={owners} rowKey={row => `${row.kind}-${row.id}`} columns={[
      { key: 'owner', label: 'Owner', primary: true, cell: row => row.kind === 'DRIVER' ? <Link href={`/safety/drivers/${row.id}`} className="block rounded-sm hover:underline"><Person name={row.name} secondary="Owner-operator" /></Link>
        : <Link href={`/safety/owners/${row.id}`} className="block rounded-sm hover:underline"><Person name={row.name} secondary={[row.signerName, 'truck owner'].filter(Boolean).join(' · ')} /></Link> },
      { key: 'trucks', label: 'Trucks', nowrap: true, cell: row => row.trucks },
      { key: 'drivers', label: 'Drivers', nowrap: true, cell: row => row.drivers },
      { key: 'status', label: 'Status', cell: row => row.archivedAt ? <Badge label="Archived" /> : <Badge label="Active" tone="success" /> },
    ]} empty={<EmptyState compact title="No truck owners yet" description="Add the companies whose trucks run under the carrier." />} />
  </Card>;
}

/** Adding or changing a unit (UnitAddScreen): the next free number is filled in; dates now, files later if wanted. */
export function UnitDialog({ data, kind: initialKind, unit, onClose }: { data: Pick<UnitList, 'next' | 'choices'>; kind: UnitKind; unit?: UnitRow | null; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [kind, setKind] = useState<UnitKind>(unit?.kind ?? initialKind);
  const [owner, setOwner] = useState<'OWNER' | 'DRIVER' | 'COMPANY'>(unit?.ownerKind ?? (initialKind === 'TRAILER' ? 'COMPANY' : 'OWNER'));
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget), value = (key: string) => String(form.get(key) ?? '').trim();
    setPending(true); setError('');
    try {
      const body = { number: value('number'), kind, vin: value('vin'), year: Number(value('year')), make: value('make'), plate: value('plate'), plateState: value('plateState'),
        ...(kind === 'TRAILER' ? { trailerType: value('trailerType') } : {}),
        ...(owner === 'OWNER' ? { ownerId: value('ownerId') } : owner === 'DRIVER' ? { driverId: value('driverId') } : { company: true }),
        ...(unit ? { version: unit.version } : { registrationExpiresOn: value('registrationExpiresOn'), inspectedOn: value('inspectedOn'), ...(value('responsibleId') ? { responsibleId: value('responsibleId') } : {}) }) };
      const saved = await mutate<{ id: string }>(unit ? `safety/units/${unit.id}` : 'safety/units', unit ? 'PATCH' : 'POST', body);
      toast({ title: unit ? 'Unit saved' : `Unit ${body.number} added` });
      onClose();
      if (unit) router.refresh(); else router.push(`/safety/units/${saved.id}`);
    } catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  const next = kind === 'TRAILER' ? data.next.trailer : data.next.truck;
  return <Dialog open onClose={onClose} busy={pending} size="lg" title={unit ? `Edit unit ${unit.number}` : 'Add unit'} description={unit ? undefined : 'Its papers stay in DataTruck and the binder. Type the dates here so reminders work.'}
    actions={<Button type="submit" form="unit-form" disabled={pending}>{pending ? 'Saving…' : unit ? 'Save unit' : <><Plus aria-hidden="true" className="size-4" />Add unit</>}</Button>}>
    <form id="unit-form" onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Kind" name="kind" value={kind} width="full" onChange={event => { const next = event.target.value as UnitKind; setKind(next); if (next !== 'TRAILER' && owner === 'COMPANY') setOwner('OWNER'); }}
          options={(['SEMI', 'PICKUP', 'TRAILER'] as UnitKind[]).map(value => ({ value, label: unitKinds[value] }))} />
        <Input key={kind} label="Unit number" name="number" required maxLength={20} width="full" defaultValue={unit?.number ?? next} hint={unit ? undefined : 'The next free number. Change it only if the unit already carries another.'} />
      </div>
      {kind === 'TRAILER' && <Input label="Trailer type" name="trailerType" optional maxLength={60} width="full" defaultValue={unit?.trailerType ?? ''} hint="For example: 53 ft dry van." />}
      <RadioGroup name="owner" label="Owner" value={owner} onChange={value => setOwner(value as typeof owner)} cards options={[
        { value: 'OWNER', label: 'A truck owner', description: 'A company that leases its trucks to the carrier and hires their drivers.' },
        { value: 'DRIVER', label: 'An owner-operator', description: 'The driver owns it and drives it.' },
        ...(kind === 'TRAILER' ? [{ value: 'COMPANY', label: 'The company', description: 'A company trailer, which can move between drivers.' }] : [])]} />
      {owner === 'OWNER' && <Select label="Truck owner" name="ownerId" required width="full" placeholder="Choose an owner" defaultValue={unit?.ownerId ?? ''} options={data.choices.owners.map(item => ({ value: item.id, label: item.name }))}
        hint={data.choices.owners.length ? 'Not on the list? Add them on the Owners tab first.' : 'Add the truck owner on the Owners tab first.'} />}
      {owner === 'DRIVER' && <Select label="Owner-operator" name="driverId" required width="full" placeholder="Choose a driver" defaultValue={unit?.driverId ?? ''} options={data.choices.operators.map(item => ({ value: item.id, label: item.name }))}
        hint="Approved and cleared owner-operators." />}
      <Input label="VIN" name="vin" required maxLength={17} width="full" defaultValue={unit?.vin ?? ''} hint="17 characters, no I, O or Q." autoCapitalize="characters" spellCheck={false} />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Input label="Year" name="year" type="number" required min={1980} max={2100} width="full" defaultValue={unit?.year ?? ''} />
        <Input label="Make and model" name="make" required maxLength={40} width="full" defaultValue={unit?.make ?? ''} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Plate" name="plate" optional maxLength={12} width="full" defaultValue={unit?.plate ?? ''} autoCapitalize="characters" />
        <Select label="Plate state" name="plateState" optional width="full" placeholder="–" defaultValue={unit?.plateState ?? ''} options={states} />
      </div>
      {!unit && <>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Registration expires" name="registrationExpiresOn" type="date" optional width="full" />
          <Input label="Last yearly inspection" name="inspectedOn" type="date" optional width="full" hint="Due again 12 months later." />
        </div>
        <Select label="Responsible" name="responsibleId" optional width="full" placeholder="Choose a Safety Manager" options={data.choices.staff.map(item => ({ value: item.id, label: item.name }))} hint="They get this unit’s reminders." />
      </>}
      <Notice message={error} error /><PendingHint pending={pending} />
    </form>
  </Dialog>;
}

/** Adding or changing a truck owner: the company and who signs for it. Never pay terms, tax IDs or bank details. */
export function OwnerDialog({ owner, onClose }: { owner?: { id: string; name: string; signerName: string | null; signerTitle: string | null; email: string | null; phone: string | null; version: number }; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget), value = (key: string) => String(form.get(key) ?? '').trim();
    setPending(true); setError('');
    try {
      const body = { name: value('name'), signerName: value('signerName'), signerTitle: value('signerTitle'), email: value('email'), phone: value('phone'), ...(owner ? { version: owner.version } : {}) };
      const saved = await mutate<{ id: string }>(owner ? `safety/owners/${owner.id}` : 'safety/owners', owner ? 'PATCH' : 'POST', body);
      toast({ title: owner ? 'Owner saved' : `${body.name} added` });
      onClose();
      if (owner) router.refresh(); else router.push(`/safety/owners/${saved.id}`);
    } catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <Dialog open onClose={onClose} busy={pending} title={owner ? `Edit ${owner.name}` : 'Add truck owner'} description="The company that leases its trucks to the carrier. Its contracts stay on paper; upload the signed copies on its page."
    actions={<Button type="submit" form="owner-form" disabled={pending}>{pending ? 'Saving…' : owner ? 'Save owner' : 'Add owner'}</Button>}>
    <form id="owner-form" onSubmit={submit} className="space-y-4">
      <Input label="Company" name="name" required maxLength={200} width="full" defaultValue={owner?.name ?? ''} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Who signs for it" name="signerName" optional maxLength={100} width="full" defaultValue={owner?.signerName ?? ''} />
        <Input label="Their title" name="signerTitle" optional maxLength={60} width="full" defaultValue={owner?.signerTitle ?? ''} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Email" name="email" type="email" optional maxLength={254} width="full" defaultValue={owner?.email ?? ''} hint="The truck owner’s signing link goes here." />
        <Input label="Phone" name="phone" type="tel" optional maxLength={40} width="full" defaultValue={owner?.phone ?? ''} />
      </div>
      <p className="text-[13px] leading-5 text-muted-foreground">Never pay terms, tax IDs or bank details.</p>
      <Notice message={error} error /><PendingHint pending={pending} />
    </form>
  </Dialog>;
}
