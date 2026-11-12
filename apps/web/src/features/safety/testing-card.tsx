'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Input, Select, Textarea } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { useToday } from './driver-documents';
import { testReasons, testResults, type DriverProfile, type TestRow } from './types';

const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;

/**
 * Ongoing drug and alcohol testing of a cleared driver: results only. The owner and the Safety manager record them;
 * only the Safety manager voids a mistaken entry. Never enter substances, levels or medical details.
 */
export function TestingCard({ driver, canRecord, canVoid }: { driver: DriverProfile; canRecord: boolean; canVoid: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [action, setAction] = useState<{ kind: 'record' } | { kind: 'void'; row: TestRow } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!driver.testing) return null;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !action) return;
    const form = new FormData(event.currentTarget), text = (name: string) => String(form.get(name) ?? '').trim();
    setPending(true); setError('');
    try {
      if (action.kind === 'record') {
        await mutate(`safety/drivers/${driver.id}/tests`, 'POST', { version: driver.version, kind: form.get('kind'), reason: form.get('reason'), testedOn: form.get('testedOn'), result: form.get('result'), ...(text('note') ? { note: text('note') } : {}) });
        toast({ title: 'Test result recorded' });
      } else {
        await mutate(`safety/drivers/${driver.id}/tests/${action.row.id}/void`, 'POST', { version: driver.version, reason: text('reason') });
        toast({ title: 'Entry voided' });
      }
      setAction(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <Card>
    <CardHeader title="Drug and alcohol testing" description="Results only. Never enter substances, levels or medical details."
      actions={canRecord && <Button size="sm" onClick={() => { setAction({ kind: 'record' }); setError(''); }}><FlaskConical aria-hidden="true" className="size-4" />Record result</Button>} />
    <CardBody>
      {/* Results are for the Safety Director and the driver’s owner only (49 CFR 40.321). */}
      {driver.testing?.hidden ? <p className="text-[13px] text-muted-foreground">Test results are shown only to the Safety Director and the driver’s Safety Manager.</p>
      : !driver.testing?.items?.length ? <EmptyState compact title="No test results yet" /> : <ul className="divide-y divide-border">
        {driver.testing.items.map(row => <li key={row.id} className={`flex flex-wrap items-start justify-between gap-2 py-3 ${row.voidedAt ? 'opacity-60' : ''}`}>
          <div className="min-w-0">
            <p className="text-sm font-medium">{row.kind === 'DRUG' ? 'Drug test' : 'Alcohol test'} · {testReasons[row.reason] ?? row.reason} · {day(row.testedOn)} <Badge label={testResults[row.result]?.label ?? row.result} tone={testResults[row.result]?.tone ?? 'neutral'} /></p>
            <p className="text-[13px] text-muted-foreground">{row.recordedBy ? `Recorded by ${row.recordedBy}` : 'Recorder account removed'}{row.voidedAt ? ` · Voided: ${row.voidReason}` : ''}</p>
            {row.note && <p className="mt-1 whitespace-pre-wrap text-sm">{row.note}</p>}</div>
          {canVoid && !row.voidedAt && <Button size="sm" variant="outline" onClick={() => { setAction({ kind: 'void', row }); setError(''); }}>Void<span className="sr-only"> this entry</span></Button>}
        </li>)}</ul>}
    </CardBody>
    {action && <Dialog open onClose={() => setAction(null)} busy={pending} title={action.kind === 'record' ? 'Record a test result' : 'Void this entry?'}
      description={action.kind === 'record' ? 'The result only, as reported to you.' : 'The entry stays in the record, marked as voided with your reason.'}
      actions={<Button type="submit" form="test-action" variant={action.kind === 'void' ? 'destructive' : 'default'}>{pending ? 'Saving…' : action.kind === 'record' ? 'Record' : 'Void entry'}</Button>}>
      <form id="test-action" onSubmit={submit} className="space-y-4">
        {action.kind === 'record' ? <>
          <Select label="Test" name="kind" required width="full" options={[{ value: 'DRUG', label: 'Drug test' }, { value: 'ALCOHOL', label: 'Alcohol test' }]} />
          <Select label="Reason" name="reason" required width="full" options={Object.entries(testReasons).map(([value, label]) => ({ value, label }))} />
          <Input label="Date of the test" name="testedOn" type="date" required defaultValue={today ?? ''} max={today ?? undefined} width="md" />
          <Select label="Result" name="result" required width="full" options={Object.entries(testResults).map(([value, { label }]) => ({ value, label }))} />
          <Textarea label="Note" name="note" optional maxLength={500} rows={2} hint="For example, the collection site. No medical details." />
        </> : <Textarea label="Why" name="reason" required maxLength={500} rows={3} hint="For example: entered against the wrong driver." />}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </Card>;
}
