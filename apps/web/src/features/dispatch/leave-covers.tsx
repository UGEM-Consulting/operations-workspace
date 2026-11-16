'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { PendingHint } from '@/components/ui/pending-hint';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate, readApi } from '@/lib/client-api';
import { coverAll, coversFor, everyoneValue, startingChoices, type CoverOptions } from './cover-rules';
import type { MemberLeave, MemberProfile } from './types';

/**
 * Drivers while their dispatcher is away (section 34: PutOnLeaveCoverScreen, OnLeaveCoveredScreen, ReturnDriversBackScreen,
 * LeaveToLeavingCoveredScreen; approved 2026-11-16). Who covers each driver is chosen when they're put on leave; the drivers
 * move on the first day away and come back on the return day.
 */
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/** Their drivers and who may cover them. null while loading; an older API without the route gives an empty list. */
export function useCoverOptions(memberId: string, wanted: boolean) {
  const [options, setOptions] = useState<CoverOptions | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    readApi<CoverOptions>(`dispatch/members/${memberId}/cover-options`).then(found => { if (current) setOptions(found); }).catch(() => { if (current) { setFailed(true); setOptions({ drivers: [], dispatchers: [] }); } });
    return () => { current = false; };
  }, [memberId, wanted]);
  return { options, failed };
}

/** “Everyone covered by” and a choice per driver (PutOnLeaveCoverScreen), used by Put on leave and Change who covers. */
export function CoverChoices({ firstName, options, choices, onChange, backOn, mcName }: { firstName: string; options: CoverOptions; choices: Record<string, string>; onChange: (next: Record<string, string>) => void; backOn?: string; mcName?: string | null }) {
  const all = coverAll(options), everyone = everyoneValue(choices);
  const label = (item: { name: string; team: string | null }) => item.team ? `${item.name} · ${item.team}` : item.name;
  if (!options.dispatchers.length) return <Alert tone="warning" title="Nobody can cover them"><p>There’s no other active dispatcher under their MC who isn’t away or leaving. Their drivers stay with {firstName}; reassign any of them from Dispatch › Drivers if they shouldn’t wait.</p></Alert>;
  return <Card><CardHeader title={`Their ${plural(options.drivers.length, 'driver')} while they’re away`} description={`Covered from the first day away and back to ${firstName} on ${backOn ? shortDay(backOn) : 'the return day'}. Dispatchers under ${mcName ?? 'the driver’s MC'} who aren’t away or leaving.`} />
    <ul className="mt-3 divide-y divide-border border-t border-border">
      {all.length > 0 && <li className="px-4 py-3 sm:px-5"><Select label="Everyone covered by" value={everyone} width="full" onChange={event => { const value = event.target.value; if (value !== 'MIXED') onChange(Object.fromEntries(options.drivers.map(driver => [driver.id, value]))); }}
        options={[...all.map(item => ({ value: item.id, label: label(item) })), { value: 'MIXED', label: 'Different people (below)' }]} /></li>}
      {options.drivers.map(driver => <li key={driver.id} className="flex flex-wrap items-end justify-between gap-3 px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-[1_1_200px]"><Person name={driver.name} secondary={driver.truck ? `Truck ${driver.truck}` : driver.mc} /></div>
        <Select label={<span className="sr-only">Covered by, for {driver.name}</span>} required value={choices[driver.id] ?? ''} placeholder="Choose" width="sm" onChange={event => onChange({ ...choices, [driver.id]: event.target.value })}
          options={coversFor(options, driver).map(item => ({ value: item.id, label: item.name }))} />
      </li>)}
    </ul></Card>;
}
/** Every driver has someone, for submitting. */
export const coversChosen = (options: CoverOptions, choices: Record<string, string>) => options.drivers.every(driver => !!choices[driver.id]);
export const coverList = (choices: Record<string, string>) => Object.entries(choices).map(([driverId, memberId]) => ({ driverId, memberId }));

/** The page of someone on leave: who covers each driver and when they come back (OnLeaveCoveredScreen). */
export function CoveredDriversCard({ member, leave }: { member: MemberProfile; leave: MemberLeave }) {
  const covers = leave.covers ?? [], uncovered = leave.uncovered ?? [];
  if (!covers.length && !uncovered.length) return null;
  const rows = [...covers.map(item => ({ id: item.driverId, driver: item.driver, truck: item.truck, by: item.stays ? `${item.with ?? 'Another dispatcher'}, reassigned for good` : [item.cover, item.coverTeam].filter(Boolean).join(' · '), back: item.stays ? 'Stays' : shortDay(leave.backOn) })),
    ...uncovered.map(item => ({ id: item.driverId, driver: item.driver, truck: item.truck, by: `Nobody: still with ${member.firstName}`, back: '—' }))];
  return <Card><CardHeader title="Their drivers while they’re away" description={leave.started ? `Back to ${member.firstName} on ${shortDay(leave.backOn)}. A driver reassigned for good meanwhile stays where they are.` : `Covered from ${shortDay(leave.firstDay)} and back to ${member.firstName} on ${shortDay(leave.backOn)}.`} />
    <Table className="mt-3 border-t border-border" caption="Covered drivers" rows={rows} rowKey={row => row.id} columns={[
      { key: 'driver', label: 'Driver', primary: true, cell: row => <Person name={row.driver} secondary={row.truck ? `Truck ${row.truck}` : undefined} /> },
      { key: 'by', label: 'Covered by', cell: row => row.by },
      { key: 'back', label: 'Back', nowrap: true, cell: row => row.back }]} /></Card>;
}

/** Change who covers, from More actions: the plan, or the drivers themselves once the leave started. */
export function ChangeCoversDialog({ member, leave, onClose }: { member: MemberProfile; leave: MemberLeave; onClose: () => void }) {
  const router = useRouter(), toast = useToast(), { options } = useCoverOptions(member.id, true);
  const [picked, setChoices] = useState<Record<string, string> | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const choices = picked ?? (options ? startingChoices(options) : null);
  async function save() {
    if (!options || !choices) return;
    const changed = coverList(choices).filter(choice => choice.memberId && options.drivers.find(driver => driver.id === choice.driverId)?.coverId !== choice.memberId);
    if (!changed.length) { onClose(); return; }
    setBusy(true); setError('');
    try { await mutate(`dispatch/members/${member.id}/on-leave/covers`, 'POST', { version: member.version, covers: changed }); toast({ title: 'Who covers saved' }); onClose(); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to save. Your choices have been kept.')); }
    finally { setBusy(false); }
  }
  return <Dialog open onClose={onClose} busy={busy} size="lg" title={`Change who covers ${member.firstName}’s drivers`} description={leave.started ? 'A driver moves to the new dispatcher today, and still comes back on the return day.' : 'The plan for the first day away.'}
    actions={<Button disabled={busy || !options || !choices || !coversChosen(options, choices)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>}>
    <div className="space-y-4">
      {!options || !choices ? <PendingHint pending /> : options.drivers.length ? <CoverChoices firstName={member.firstName} options={options} choices={choices} onChange={setChoices} backOn={leave.backOn} mcName={member.current?.mc} /> : <p className="text-sm text-muted-foreground">They have no drivers to cover.</p>}
      <Notice message={error} error />
    </div>
  </Dialog>;
}

/** Recording the return: who comes back and who stays (ReturnDriversBackScreen). */
export function ReturningDrivers({ member, leave }: { member: MemberProfile; leave: MemberLeave }) {
  const covers = (leave.covers ?? []).filter(item => item.started);
  if (!covers.length) return null;
  return <Card><CardHeader title="Their drivers come back" /><ul className="mt-3 divide-y divide-border border-t border-border">{covers.map(item => <li key={item.driverId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
    <Person name={item.driver} secondary={item.stays ? `Reassigned to ${item.with ?? 'another dispatcher'} for good` : `From ${item.cover}`} />
    {item.stays ? <Badge label="Stays" tone="neutral" /> : <Badge label={`Back to ${member.firstName}`} tone="success" />}</li>)}</ul></Card>;
}
/** Marking someone on leave as leaving: their covered drivers stay with who covers them (LeaveToLeavingCoveredScreen). */
export function LeavingCoveredAlert({ leave }: { leave: MemberLeave }) {
  const covers = (leave.covers ?? []).filter(item => item.started && !item.stays);
  if (!covers.length) return null;
  const byCover = new Map<string, string[]>();
  for (const item of covers) byCover.set(item.cover, [...(byCover.get(item.cover) ?? []), item.driver]);
  const listed = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0];
  return <Alert tone="warning" title={`Their ${plural(covers.length, 'driver')} stay with who covers them`}><p>{[...byCover.entries()].map(([cover, drivers]) => `${cover} keeps ${listed(drivers)}`).join(', and ')}, for good. Each move is in the driver’s history; reassign any of them as usual.</p></Alert>;
}
