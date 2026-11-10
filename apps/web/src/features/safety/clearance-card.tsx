'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checklist } from '@/components/ui/checklist';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Checkbox, Input, RadioGroup, Textarea } from '@/components/ui/field';
import { EmptyState, Progress } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { useToday } from './driver-documents';
import { CLEARANCE_ITEMS, clearanceApplies, clearanceGapLabel, clearanceResults, type ClearanceItemRow, type ClearanceKey, type DriverProfile, type EmployerRow } from './types';

const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;
const month = (value: string) => new Date(`${value}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const done = (status: string | undefined) => status === 'COMPLETED' || status === 'NOT_NEEDED';
type Editing = { kind: 'item'; key: ClearanceKey } | { kind: 'add' } | { kind: 'employer'; employer: EmployerRow } | { kind: 'remove'; employer: EmployerRow };

/** What the checklist row says under the title: the result and its date, or who recorded what and when. */
function itemMeta(item: ClearanceItemRow | undefined, key: ClearanceKey, employers: EmployerRow[]) {
  const parts: React.ReactNode[] = [];
  if (key === 'PREVIOUS_EMPLOYERS' && employers.length) parts.push(`${employers.filter(row => row.answeredOn || row.goodFaithOn).length} of ${employers.length} answered or followed up`);
  if (item?.result) parts.push(clearanceResults[item.result] ?? item.result);
  if (item?.doneOn) parts.push(<>{item.result ? '' : 'Done '}{day(item.doneOn)}</>);
  if (item?.updatedBy) parts.push(`recorded by ${item.updatedBy}`);
  return parts.length ? parts.map((part, index) => <span key={index}>{index > 0 && ' · '}{part}</span>) : undefined;
}

/**
 * Clearance of an approved driver: the fixed checklist and the previous employers Safety asks about the driver's safety
 * record. Results only: the dialogs say to keep drug test, medical and immigration details out. E-Verify applies to
 * company drivers only and shows as not needed for an owner-operator. `canWork` is the driver's owner, the Safety manager
 * or an administrator while the driver is approved; everyone else in Safety reads it.
 */
export function ClearanceCard({ driver, canWork }: { driver: DriverProfile; canWork: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [result, setResult] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const clearance = driver.clearance!, items = new Map(clearance.items.map(item => [item.key, item]));
  const open = (next: Editing) => {
    setEditing(next); setError('');
    if (next.kind === 'item') { const item = items.get(next.key); setResult(item?.result ?? ''); setStatus(item?.status ?? ''); }
  };
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !editing) return;
    const form = new FormData(event.currentTarget), value = (name: string) => String(form.get(name) ?? '').trim();
    setPending(true); setError('');
    try {
      const base = `safety/drivers/${driver.id}`;
      if (editing.kind === 'item') {
        const rule = CLEARANCE_ITEMS.find(item => item.key === editing.key)!;
        // E-Verify: the I-9 confirmation is sent only when the person ticked it now, so a changed result is confirmed again.
        const body = rule.results ? (result ? { result, ...(editing.key === 'E_VERIFY' && form.get('i9Complete') === 'on' ? { i9Complete: true } : {}) } : { status: null }) : { status: status || null };
        await mutate(`${base}/clearance/${editing.key}`, 'POST', { version: driver.version, ...body, ...(value('doneOn') ? { doneOn: value('doneOn') } : {}), note: value('note') });
      } else if (editing.kind === 'add') await mutate(`${base}/employers`, 'POST', { version: driver.version, name: value('name'), fromMonth: value('fromMonth'), toMonth: value('toMonth'), ...(value('requestedOn') ? { requestedOn: value('requestedOn') } : {}) });
      else if (editing.kind === 'employer') await mutate(`${base}/employers/${editing.employer.id}`, 'POST', { version: driver.version, requestedOn: value('requestedOn') || null, answeredOn: value('answeredOn') || null,
        ...(editing.employer.requestedOn ? { goodFaithOn: value('goodFaithOn') || null, goodFaithNote: value('goodFaithNote') } : {}) });
      else if (editing.kind === 'remove') await mutate(`${base}/employers/${editing.employer.id}/remove`, 'POST', { version: driver.version });
      toast({ title: editing.kind === 'add' ? 'Employer added' : editing.kind === 'remove' ? 'Employer removed' : 'Saved' });
      setEditing(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  const rule = editing?.kind === 'item' ? CLEARANCE_ITEMS.find(item => item.key === editing.key)! : null, current = editing?.kind === 'item' ? items.get(editing.key) : undefined;
  const showDate = rule ? (rule.results ? !!result : status === 'COMPLETED') : false;
  return <>
    <Card>
      <CardHeader title="Clearance" description="What has to be on file before this driver can run loads. Results only: drug test, medical and immigration details stay out of the workspace." />
      <Checklist className="mt-3 border-t border-border" items={CLEARANCE_ITEMS.map(item => {
        const row = items.get(item.key);
        if (!clearanceApplies(item, driver)) return { id: item.key, title: item.label, description: 'Only for company drivers, who are UGEM employees.', status: 'NOT_NEEDED', meta: 'Not needed: owner-operator (not an employee)' };
        if (row?.hidden) return { id: item.key, title: item.label, description: item.hint, status: 'RESTRICTED', meta: 'The result is shown only to the Safety manager and the driver’s Safety contact.' };
        return { id: item.key, title: item.label, description: item.hint, status: row?.status ?? 'PENDING', note: row?.note ?? undefined, meta: itemMeta(row, item.key, clearance.employers),
          action: canWork ? <Button size="sm" variant="outline" onClick={() => open({ kind: 'item', key: item.key })}>{row ? 'Edit' : 'Record'}<span className="sr-only">: {item.label}</span></Button> : undefined };
      })} />
    </Card>
    <Card>
      <CardHeader title="Previous employers" description="DOT-regulated employers from the last 3 years, asked about the driver’s safety performance within 30 days of hire. Kept with the qualification file."
        actions={canWork ? <Button size="sm" variant="outline" onClick={() => open({ kind: 'add' })}><Plus aria-hidden="true" className="size-4" />Add employer</Button> : undefined} />
      {clearance.employers.length ? <Table className="mt-3" caption="Previous employers" rows={clearance.employers} rowKey={row => row.id} columns={[
        { key: 'name', label: 'Employer', primary: true, cell: row => <>{row.name}{(row.location || row.phone) && <span className="block text-[13px] text-muted-foreground">{[row.location, row.phone].filter(Boolean).join(' · ')}</span>}
          {row.source === 'APPLICATION' && <span className="mt-1 block"><Badge label="From application" tone="neutral" /></span>}</> },
        { key: 'dates', label: 'Dates', muted: true, nowrap: true, cell: row => `${month(row.fromMonth)} – ${month(row.toMonth)}` },
        { key: 'requested', label: 'Requested', muted: true, nowrap: true, cell: row => row.requestedOn ? day(row.requestedOn) : 'Not yet' },
        { key: 'status', label: 'Status', cell: row => <>
          <Badge label={row.answeredOn ? 'Answered' : row.goodFaithOn ? 'Good-faith effort' : row.requestedOn ? 'Waiting' : 'Not asked'} tone={row.answeredOn || row.goodFaithOn ? 'success' : row.requestedOn ? 'warning' : 'neutral'} />
          {row.goodFaithOn && !row.answeredOn && <span className="mt-1 block whitespace-pre-wrap text-[13px] text-muted-foreground">{day(row.goodFaithOn)}: {row.goodFaithNote}</span>}</> },
        ...(canWork ? [{ key: 'actions', label: 'Actions', srOnly: true, align: 'right' as const, action: true, cell: (row: EmployerRow) => <div className="flex justify-end gap-2">
          {!row.requestedOn && <Button size="sm" variant="ghost" onClick={() => open({ kind: 'remove', employer: row })}>Remove<span className="sr-only">: {row.name}</span></Button>}
          <Button size="sm" variant="outline" onClick={() => open({ kind: 'employer', employer: row })}>{row.requestedOn ? 'Record answer' : 'Record request'}<span className="sr-only">: {row.name}</span></Button></div> }] : []),
      ]} /> : <CardBody><EmptyState compact title="No employers yet" description={canWork ? 'Add each DOT-regulated employer the driver worked for in the last 3 years.' : 'The driver’s Safety contact adds them.'} /></CardBody>}
    </Card>
    {editing && <Dialog open onClose={() => setEditing(null)} busy={pending} tone={editing.kind === 'remove' ? 'danger' : undefined}
      title={editing.kind === 'item' ? rule!.label : editing.kind === 'add' ? 'Add a previous employer' : editing.kind === 'remove' ? `Remove ${editing.employer.name}?` : editing.employer.name}
      description={rule ? rule.dialog : editing.kind === 'remove' ? 'Only an employer you haven’t asked yet can be removed.' : editing.kind === 'employer' ? 'When you asked about the driver’s safety record, and when they answered. Keep their answer itself in the qualification file.' : undefined}
      actions={<Button type="submit" form="clearance-form" disabled={!!rule && !current && !(rule.results ? result : status)} variant={editing.kind === 'remove' ? 'destructive' : 'default'}>{pending ? 'Saving…' : editing.kind === 'add' ? 'Add employer' : editing.kind === 'remove' ? 'Remove' : 'Save'}</Button>}>
      <form id="clearance-form" onSubmit={submit} className="space-y-4">
        {rule?.results && <RadioGroup name="result" label="Result" value={result} onChange={setResult} options={[...Object.entries(rule.results).map(([value, option]) => ({ value, ...option })),
          ...(current ? [{ value: '', label: 'Not started', description: 'Clears the recorded result.' }] : [])]} />}
        {rule && !rule.results && <RadioGroup name="status" label="Status" value={status} onChange={setStatus} options={[
          ...(current ? [{ value: '', label: 'Not started' }] : []), { value: 'IN_PROGRESS', label: 'In progress' }, { value: 'BLOCKED', label: 'Blocked', description: 'Say what is in the way.' },
          { value: 'COMPLETED', label: 'Completed' }, ...(rule.optional ? [{ value: 'NOT_NEEDED', label: 'Not needed', description: rule.optional }] : [])]} />}
        {showDate && <Input label={rule?.key === 'E_VERIFY' ? 'Date the case was created' : rule?.results ? 'Date of the result' : 'Date completed'} name="doneOn" type="date" width="sm" required max={today ?? undefined} defaultValue={current?.doneOn ?? today ?? undefined}
          hint={rule?.key === 'E_VERIFY' ? 'Within 3 business days of their first day of work.' : undefined} />}
        {rule?.key === 'E_VERIFY' && !!result && <Checkbox name="i9Complete" required label={`${driver.firstName}’s Form I-9 is complete.`} />}
        {rule && <Textarea label="Note" name="note" rows={2} maxLength={1000} optional={(!(status === 'BLOCKED' || status === 'NOT_NEEDED') || !!rule.results) && result !== 'CASE_CLOSED'}
          required={(!rule.results && (status === 'BLOCKED' || status === 'NOT_NEEDED')) || result === 'CASE_CLOSED'} defaultValue={current?.note ?? ''}
          hint={rule.key === 'E_VERIFY' ? 'No case numbers, document numbers or immigration details.' : 'No medical details, substances, levels or violation details.'} />}
        {editing.kind === 'add' && <>
          <Input label="Employer" name="name" required maxLength={200} width="full" />
          <div className="flex flex-wrap gap-4">
            <Input label="From" name="fromMonth" type="month" required width="sm" max={today?.slice(0, 7)} />
            <Input label="To" name="toMonth" type="month" required width="sm" max={today?.slice(0, 7)} />
          </div>
          <Input label="Requested on" name="requestedOn" type="date" optional width="md" max={today ?? undefined} hint="When you asked them about the driver’s safety record, if you already did." />
        </>}
        {editing.kind === 'employer' && <>
          <Input label="Requested on" name="requestedOn" type="date" width="sm" required max={today ?? undefined} defaultValue={editing.employer.requestedOn ?? today ?? undefined} />
          <Input label="Answered on" name="answeredOn" type="date" width="sm" optional max={today ?? undefined} defaultValue={editing.employer.answeredOn ?? undefined} hint="Leave empty while you wait for their answer." />
          {editing.employer.requestedOn && <>
            <Input label="Good-faith effort on" name="goodFaithOn" type="date" width="sm" optional max={today ?? undefined} defaultValue={editing.employer.goodFaithOn ?? undefined} hint="If they don’t answer: when you last tried." />
            <Textarea label="What you did to reach them" name="goodFaithNote" rows={2} maxLength={500} optional defaultValue={editing.employer.goodFaithNote ?? ''} hint="For example: two calls and a letter. No violation details." />
          </>}
        </>}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </>;
}

/** The rail card: how far clearance is and the step to Cleared, which unlocks once every item is done or not needed. */
export function ClearanceProgress({ driver, canWork }: { driver: DriverProfile; canWork: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const clearance = driver.clearance!, name = `${driver.firstName} ${driver.lastName}`.trim();
  // An item that doesn't apply (E-Verify for an owner-operator) counts as done. Items whose result this person may not see
  // (hidden) count as neither, so the bar and the text never guess how they came out.
  const hidden = CLEARANCE_ITEMS.filter(item => clearance.items.find(row => row.key === item.key)?.hidden);
  const shown = CLEARANCE_ITEMS.length - hidden.length;
  const finished = CLEARANCE_ITEMS.filter(item => !hidden.includes(item) && (!clearanceApplies(item, driver) || (done(clearance.items.find(row => row.key === item.key)?.status) && !clearance.missing.includes(`expired:${item.key}`)))).length;
  async function clear() {
    if (pending) return;
    setPending(true); setError('');
    try {
      await mutate(`safety/drivers/${driver.id}/clear`, 'POST', { version: driver.version });
      toast({ title: `${name} cleared`, description: 'Dispatch can now assign an MC and a dispatcher.' });
      setConfirming(false); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to mark the driver as cleared.')); }
    finally { setPending(false); }
  }
  if (driver.status === 'CLEARED') return <Card>
    <CardHeader title="Cleared" />
    <CardBody className="space-y-2 text-sm">
      <p className="flex items-center gap-2"><ShieldCheck aria-hidden="true" className="size-4 text-success" />{driver.clearedAt ? <LocalTime iso={driver.clearedAt} format="date" /> : 'Cleared'}{driver.clearedBy ? ` by ${driver.clearedBy.name}` : ''}</p>
      <p className="text-[13px] text-muted-foreground">Dispatch assigns the MC and dispatcher.</p>
    </CardBody>
  </Card>;
  return <Card>
    <CardHeader title="Clearance progress" />
    <CardBody className="space-y-3">
      <Progress label="Items done" value={finished} max={shown} valueLabel={`${finished} of ${shown}`} />
      {clearance.missing.length > 0 ? <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">{clearance.missing.map(code => <li key={code}>{clearanceGapLabel(code)}</li>)}</ul>
        : hidden.length > 0 ? <p className="text-[13px] text-muted-foreground">Every item you can see is done. The drug test and Clearinghouse results are shown only to the Safety manager and the driver’s Safety contact.</p>
        : <p className="text-[13px] text-muted-foreground">Every item is done. Mark the driver as cleared so Dispatch can assign them.</p>}
      {canWork && <Button className="w-full" disabled={clearance.missing.length > 0} onClick={() => { setConfirming(true); setError(''); }}><ShieldCheck aria-hidden="true" className="size-4" />Mark as cleared</Button>}
    </CardBody>
    {confirming && <Dialog open onClose={() => setConfirming(false)} busy={pending} title={`Mark ${name} as cleared?`}
      description="Dispatch then sees the driver’s name, phone, driver type and Cleared status, and assigns an MC and a dispatcher. The clearance checklist can’t be changed after this."
      actions={<Button onClick={clear}>{pending ? 'Saving…' : 'Mark as cleared'}</Button>}>
      <Notice message={error} error />
    </Dialog>}
  </Card>;
}
