'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { useToday } from './driver-documents';
import type { DriverProfile, IncidentRow } from './types';

const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;
const kinds = { ACCIDENT: 'Accident', VIOLATION: 'Violation', INSPECTION: 'Inspection' } as const;
type Action = { kind: 'record' } | { kind: 'settle'; row: IncidentRow } | { kind: 'void'; row: IncidentRow };

/** Accidents, violations and roadside inspections of a cleared driver: a short factual record. No names of other people, no medical details. */
export function IncidentsCard({ driver, canRecord, canVoid }: { driver: DriverProfile; canRecord: boolean; canVoid: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [action, setAction] = useState<Action | null>(null);
  const [kind, setKind] = useState<IncidentRow['kind']>('ACCIDENT');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!driver.incidents) return null;
  const start = (next: Action) => { setAction(next); setError(''); };
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !action) return;
    const form = new FormData(event.currentTarget), text = (name: string) => String(form.get(name) ?? '').trim(), flag = (name: string) => form.get(name) === 'on';
    setPending(true); setError('');
    try {
      const base = `safety/drivers/${driver.id}/incidents`;
      if (action.kind === 'record') {
        await mutate(base, 'POST', { version: driver.version, kind, occurredOn: text('occurredOn'), summary: text('summary'), ...(text('state') ? { state: text('state') } : {}), ...(text('note') ? { note: text('note') } : {}),
          ...(kind === 'ACCIDENT' ? { preventable: text('preventable'), injuries: flag('injuries'), fatalities: flag('fatalities'), towAway: flag('towAway') } : {}),
          ...(kind === 'VIOLATION' ? { disposition: text('disposition') } : {}),
          ...(kind === 'INSPECTION' ? { outOfService: flag('outOfService'), violationCount: Number(text('violationCount') || 0) } : {}) });
        toast({ title: 'Recorded' });
      } else if (action.kind === 'settle') {
        await mutate(`${base}/${action.row.id}/settle`, 'POST', { version: driver.version, ...(action.row.kind === 'ACCIDENT' ? { preventable: text('answer') } : { disposition: text('answer') }) });
        toast({ title: 'Updated' });
      } else {
        await mutate(`${base}/${action.row.id}/void`, 'POST', { version: driver.version, reason: text('reason') });
        toast({ title: 'Entry voided' });
      }
      setAction(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  const open = (row: IncidentRow) => !row.voidedAt && (row.preventable === 'UNDETERMINED' || row.disposition === 'PENDING');
  return <Card>
    <CardHeader title="Accidents, violations and inspections" description="A short factual record. Don’t enter other people’s names, medical details or police report numbers."
      actions={canRecord && <Button size="sm" onClick={() => start({ kind: 'record' })}><TriangleAlert aria-hidden="true" className="size-4" />Record incident</Button>} />
    <CardBody>
      {driver.incidents.items.length === 0 ? <EmptyState compact title="Nothing recorded" /> : <ul className="divide-y divide-border">
        {driver.incidents.items.map(row => <li key={row.id} className={`flex flex-wrap items-start justify-between gap-2 py-3 ${row.voidedAt ? 'opacity-60' : ''}`}>
          <div className="min-w-0">
            <p className="text-sm font-medium">{kinds[row.kind]} · {day(row.occurredOn)}{row.state ? ` · ${row.state}` : ''}{' '}
              {row.kind === 'ACCIDENT' && <Badge label={row.preventable === 'UNDETERMINED' ? 'Preventability open' : row.preventable === 'YES' ? 'Preventable' : 'Not preventable'} tone={row.preventable === 'UNDETERMINED' ? 'warning' : row.preventable === 'YES' ? 'danger' : 'neutral'} />}
              {row.kind === 'VIOLATION' && <Badge label={row.disposition === 'PENDING' ? 'Pending' : row.disposition === 'CONVICTED' ? 'Convicted' : 'Dismissed'} tone={row.disposition === 'PENDING' ? 'warning' : row.disposition === 'CONVICTED' ? 'danger' : 'neutral'} />}
              {row.kind === 'INSPECTION' && <Badge label={row.outOfService ? 'Out of service' : `${row.violationCount} violation${row.violationCount === 1 ? '' : 's'}`} tone={row.outOfService ? 'danger' : 'neutral'} />}</p>
            <p className="text-sm">{row.summary}</p>
            {row.kind === 'ACCIDENT' && <p className="text-[13px] text-muted-foreground">{[row.injuries && 'Injuries', row.fatalities && 'Fatalities', row.towAway && 'Tow-away'].filter(Boolean).join(' · ') || 'No injuries, fatalities or tow-away'}</p>}
            {row.note && <p className="mt-1 whitespace-pre-wrap text-sm">{row.note}</p>}
            <p className="text-[13px] text-muted-foreground">{row.recordedBy ? `Recorded by ${row.recordedBy}` : 'Recorder account removed'}{row.voidedAt ? ` · Voided: ${row.voidReason}` : ''}</p></div>
          <span className="flex gap-1">
            {canRecord && open(row) && <Button size="sm" variant="outline" onClick={() => start({ kind: 'settle', row })}>{row.kind === 'ACCIDENT' ? 'Decide' : 'Record outcome'}</Button>}
            {canVoid && !row.voidedAt && <Button size="sm" variant="outline" onClick={() => start({ kind: 'void', row })}>Void<span className="sr-only"> this entry</span></Button>}</span>
        </li>)}</ul>}
    </CardBody>
    {action && <Dialog open onClose={() => setAction(null)} busy={pending} title={action.kind === 'record' ? 'Record an incident' : action.kind === 'settle' ? (action.row.kind === 'ACCIDENT' ? 'Was the accident preventable?' : 'Outcome of the violation') : 'Void this entry?'}
      description={action.kind === 'settle' ? 'This can only be set once.' : action.kind === 'void' ? 'The entry stays in the record, marked as voided with your reason.' : undefined}
      actions={<Button type="submit" form="incident-action" variant={action.kind === 'void' ? 'destructive' : 'default'}>{pending ? 'Saving…' : action.kind === 'void' ? 'Void entry' : 'Save'}</Button>}>
      <form id="incident-action" onSubmit={submit} className="space-y-4">
        {action.kind === 'record' && <>
          <Select label="What happened" name="kind" required width="full" value={kind} onChange={event => setKind(event.target.value as IncidentRow['kind'])} options={Object.entries(kinds).map(([value, label]) => ({ value, label }))} />
          <Input label="Date" name="occurredOn" type="date" required defaultValue={today ?? ''} max={today ?? undefined} width="md" />
          <Input label="State" name="state" optional maxLength={2} width="sm" hint="Two letters, for example TX." />
          <Input label="In a line" name="summary" required maxLength={200} width="full" />
          {kind === 'ACCIDENT' && <>
            <Select label="Preventable" name="preventable" required width="full" options={[{ value: 'UNDETERMINED', label: 'Not decided yet' }, { value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes' }]} />
            <Checkbox name="injuries" label="Injuries" /><Checkbox name="fatalities" label="Fatalities" /><Checkbox name="towAway" label="A vehicle was towed away" />
          </>}
          {kind === 'VIOLATION' && <Select label="Outcome" name="disposition" required width="full" options={[{ value: 'PENDING', label: 'Pending' }, { value: 'CONVICTED', label: 'Convicted' }, { value: 'DISMISSED', label: 'Dismissed' }]} />}
          {kind === 'INSPECTION' && <>
            <Input label="Violations found" name="violationCount" type="number" required min={0} max={50} defaultValue="0" width="sm" />
            <Checkbox name="outOfService" label="The driver or vehicle was placed out of service" />
          </>}
          <Textarea label="Note" name="note" optional maxLength={1000} rows={3} />
        </>}
        {action.kind === 'settle' && <Select label={action.row.kind === 'ACCIDENT' ? 'Preventable' : 'Outcome'} name="answer" required width="full"
          options={action.row.kind === 'ACCIDENT' ? [{ value: 'NO', label: 'Not preventable' }, { value: 'YES', label: 'Preventable' }] : [{ value: 'CONVICTED', label: 'Convicted' }, { value: 'DISMISSED', label: 'Dismissed' }]} />}
        {action.kind === 'void' && <Textarea label="Why" name="reason" required maxLength={500} rows={3} hint="For example: recorded against the wrong driver." />}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </Card>;
}
