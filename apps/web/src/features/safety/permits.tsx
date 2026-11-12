'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check } from 'lucide-react';
import { Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/feedback';
import { Checkbox, Input } from '@/components/ui/field';
import { FilterBar } from '@/components/ui/filter-bar';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { PageCrumb } from '@/components/shell-context';
import { PageHeader, StatCard } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { daysLeft, permitShort, unitKinds, type PermitsYear } from './units-types';

import { PERMIT_DEFAULTS } from '@/lib/navigation';

/**
 * Year-end permits (PermitsYearEndScreen): most permits end Dec 31, so they're gathered by unit instead of a row each. Safety
 * selects units and marks their permits renewed together with the new date; a unit missing a permit says which.
 */
export function Permits({ data, filters, currentUserId }: { data: PermitsYear; filters: Record<string, string>; currentUserId: string }) {
  const router = useRouter(), toast = useToast();
  const [chosen, setChosen] = useState<Set<string>>(new Set()), [renewing, setRenewing] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const nextYear = String(Number(data.yearEnd.slice(0, 4)) + 1);
  const rows = data.items.map(unit => {
    const needed = data.permitsFor[unit.kind] ?? [], done = needed.filter(kind => (unit.permits.find(permit => permit.kind === kind)?.expiresOn ?? '') > data.yearEnd);
    return { ...unit, needed, done, missing: needed.filter(kind => !unit.permits.some(permit => permit.kind === kind)) };
  });
  const searched = rows.filter(row => `${row.number} ${row.owner ?? ''}`.toLowerCase().includes(filters.search.toLowerCase()));
  const open = (row: (typeof rows)[number]) => row.done.length < row.needed.length;
  const visible = searched.filter(row => filters.status === 'DONE' ? !open(row) : open(row) && (filters.status !== 'MINE' || row.responsibleId === currentUserId));
  async function renew(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError('');
    try {
      const result = await mutate<{ renewed: number }>('safety/units/permits/renew', 'POST', { unitIds: [...chosen], expiresOn: String(new FormData(event.currentTarget).get('expiresOn') ?? '') });
      toast({ title: `${result.renewed} ${result.renewed === 1 ? 'permit' : 'permits'} marked renewed` });
      setRenewing(false); setChosen(new Set()); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to save.')); }
    finally { setPending(false); }
  }
  const toggle = (id: string, on: boolean) => setChosen(current => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  return <div className="space-y-6">
    <PageCrumb label="Permits" />
    <PageHeader title={`Permits for ${nextYear}`} description={`Every permit that ends Dec 31, ${data.yearEnd.slice(0, 4)}, by unit. Semi trucks need NY HUT, KYU, New Mexico, Oregon and IFTA decals; pickups need New Mexico.`}
      action={<Button disabled={!chosen.size} onClick={() => { setRenewing(true); setError(''); }}><Check aria-hidden="true" className="size-4" />Mark selected renewed</Button>} />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Units" value={rows.length} detail="Trucks and pickups in use" href="/safety/units" />
      <StatCard label="Permits to renew" value={rows.reduce((sum, row) => sum + row.needed.length - row.done.length, 0)} detail={`By Dec 31, ${data.yearEnd.slice(0, 4)}`} href="/safety/expiring/permits" tone="warning" />
      <StatCard label="Renewed" value={rows.reduce((sum, row) => sum + row.done.length, 0)} detail={`Good into ${nextYear}`} href="/safety/expiring/permits?status=DONE" tone="success" />
      <StatCard label="Days left" value={Math.max(0, daysLeft(data.yearEnd, data.today))} detail="Until Dec 31" href="/safety/expiring/permits" />
    </div>
    <Card>
      <FilterBar path="/safety/expiring/permits" filters={filters} defaults={PERMIT_DEFAULTS} searchLabel="Search unit or owner" statuses={[
        { key: 'MINE', label: 'My units', count: searched.filter(row => open(row) && row.responsibleId === currentUserId).length },
        { key: 'ALL', label: 'All', count: searched.filter(open).length }, { key: 'DONE', label: 'Done', count: searched.filter(row => !open(row)).length }]} />
      <Table caption="Permits by unit" className="border-t border-border" rows={visible} rowKey={row => row.id} columns={[
        { key: 'pick', label: 'Select', srOnly: true, cell: row => <Checkbox label={<span className="sr-only">Select {row.number}</span>} checked={chosen.has(row.id)} onChange={event => toggle(row.id, event.target.checked)} /> },
        { key: 'unit', label: 'Unit', primary: true, cell: row => <Person name={row.number} secondary={`${unitKinds[row.kind]} · ${row.owner ?? ''}`} /> },
        { key: 'permits', label: 'Permits', cell: row => <>{row.needed.map(kind => permitShort[kind]).join(', ')}{row.missing.length > 0 && <> <Badge label={`${row.missing.map(kind => permitShort[kind]).join(', ')} missing`} tone="danger" /></>}</> },
        { key: 'renewed', label: 'Renewed', nowrap: true, cell: row => row.done.length === row.needed.length ? <Badge label={`${row.done.length} of ${row.needed.length}`} tone="success" /> : `${row.done.length} of ${row.needed.length}` }]}
        empty={<EmptyState compact title={filters.status === 'DONE' ? 'Nothing renewed yet' : 'Nothing left to renew'} description={filters.status === 'MINE' ? 'Try All for every unit.' : undefined} />} />
    </Card>
    {renewing && <Dialog open onClose={() => setRenewing(false)} busy={pending} title={`Mark ${chosen.size} ${chosen.size === 1 ? 'unit' : 'units'} renewed`} description="Every permit each unit’s type carries gets the new expiration."
      actions={<Button type="submit" form="renew-permits" disabled={pending}>{pending ? 'Saving…' : 'Mark renewed'}</Button>}>
      <form id="renew-permits" onSubmit={renew} className="space-y-4">
        <Input label="New expiration" name="expiresOn" type="date" required width="sm" defaultValue={`${nextYear}-12-31`} />
        <p className="text-[13px] leading-5 text-muted-foreground">Mark them once the new permits are in each truck.</p>
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
