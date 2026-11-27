'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shield } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Pagination } from '@/components/ui/pagination';
import { PendingHint } from '@/components/ui/pending-hint';
import { Badge } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import { Table } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate, readApi } from '@/lib/client-api';
import { middayIso } from '@/lib/navigation';

/**
 * Admin › Keeping records (section 34: RetentionScheduleScreen, RetentionDueScreen, RetentionHoldScreen, RetentionLogScreen;
 * approved 2026-11-16). How long records are kept, what is due, holds, and what the weekly runs deleted (counts only).
 */
type Subject = 'APPLICATION' | 'INVITATION' | 'DRIVER' | 'MEMBER';
export interface RetentionOverview { deleting: boolean; changedAt: string | null; changedBy: string | null; firstDeletion: string | null; today: string; noticeDays: number;
  kinds: { kind: string; label: string; period: string; why: string; pastIt: number }[]; dueSoon: number; held: number; lastRun: { day: string; finishedAt: string | null } | null; nextRun: string }
export interface DueRecord { kind: string; subject: Subject; id: string; name: string; detail: string; what: string; basis: string; basisOn: string; dueOn: string; holdId: string | null; heldUntil: string | null; holdReason: string | null }
export interface DueList { items: DueRecord[]; total: number; page: number; pageSize: number; deletesOn: string | null }
export interface RetentionRun { day: string; startedAt: string; finishedAt: string | null; deleted: Record<string, { records: number; files: number }>; held: number; failed: number }
const Day = ({ day }: { day: string }) => <LocalTime iso={middayIso(day)} format="date" />;
const plusDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
const KIND_NAMES: Record<string, string> = { APPLICATIONS: 'Dispatcher applications', DRIVER_APPLICATIONS: 'Driver applications', DRIVER_FILES: 'Driver qualification files', MEMBERS: 'Staff records' };
const HINT = 'Staff only. Never health or other private details.';

export function RetentionSchedule({ data }: { data: RetentionOverview }) {
  const router = useRouter(), toast = useToast();
  const [confirming, setConfirming] = useState(false), [holding, setHolding] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function setDeleting(deleting: boolean) {
    setBusy(true); setError('');
    try { await mutate('retention/settings', 'POST', { deleting }); toast({ title: deleting ? 'Deleting is on' : 'Deleting is off' }); setConfirming(false); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to change it. Try again.')); }
    finally { setBusy(false); }
  }
  return <div className="space-y-6">
    <PageHeader title="Keeping records" description="Records are kept for the time the law asks, then deleted for good, files included." action={<Button variant="outline" onClick={() => setHolding(true)}><Shield aria-hidden="true" className="size-4" />Hold a person’s records</Button>} />
    {data.deleting ? <Alert tone="info" title={data.firstDeletion && data.firstDeletion > data.today ? <>Deleting starts on <Day day={data.firstDeletion} /></> : 'Deleting is on'}><p>What is due is listed {data.noticeDays} days before it’s deleted, and deleted on Mondays. Deleted records can’t be brought back.</p></Alert>
      : <Alert tone="warning" title="Deleting is off"><p>Have your adviser check these periods first. Once it’s on, the workspace lists what is due {data.noticeDays} days before deleting it, and deletes once a week. Deleted records can’t be brought back.</p></Alert>}
    <Notice message={error} error />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
      <div className="space-y-6">
        <Card><CardHeader title="How long records are kept" />
          <Table className="mt-3 border-t border-border" caption="Retention periods" rows={data.kinds} rowKey={row => row.kind} columns={[
            { key: 'kind', label: 'Records', primary: true, cell: row => row.label },
            { key: 'period', label: 'Kept for', cell: row => row.period },
            { key: 'why', label: 'Why', hideBelow: 'xl', muted: true, cell: row => row.why },
            { key: 'past', label: 'Past it', align: 'right', cell: row => row.pastIt }]} /></Card>
        <Card><CardHeader title="What is never deleted here" /><CardBody><ul className="list-disc space-y-2 pl-5 text-sm">
          <li>Records of anyone still working here, on leave or leaving, and every driver still on the road.</li>
          <li>Anyone whose records are held, until the hold ends.</li>
          <li>Audit history: it keeps what happened and when, never the values.</li></ul></CardBody></Card>
      </div>
      <div className="space-y-6">
        <Card><CardHeader title="Deleting" /><CardBody className="space-y-3">
          <Switch id="retention-deleting" label="Delete records past their period" checked={data.deleting} disabled={busy} onCheckedChange={() => setConfirming(true)} />
          <p className="text-[13px] leading-5 text-muted-foreground">Only administrators turn this on or off. Each change is recorded.{data.changedBy && data.changedAt ? <> Last changed by {data.changedBy}, <LocalTime iso={data.changedAt} format="date" />.</> : null}</p>
        </CardBody></Card>
        <Card><CardHeader title="Next" /><CardBody><DescriptionList layout="rows" items={[
          { label: `Due in ${data.noticeDays} days`, value: <Link className="underline underline-offset-2" href="/retention/due">{data.dueSoon} {data.dueSoon === 1 ? 'record' : 'records'}</Link> },
          { label: 'Held', value: `${data.held} ${data.held === 1 ? 'person' : 'people'}` },
          { label: 'Last deleted', value: data.lastRun ? <Link className="underline underline-offset-2" href="/retention/deleted"><Day day={data.lastRun.day} /></Link> : null, emptyLabel: 'Never' }]} /></CardBody></Card>
      </div>
    </div>
    {confirming && <Dialog open tone={data.deleting ? undefined : 'danger'} onClose={() => setConfirming(false)} busy={busy} title={data.deleting ? 'Turn deleting off?' : 'Turn deleting on?'}
      description={data.deleting ? 'Nothing more is deleted until it’s turned on again. Holds stay as they are.' : `Records past their period start being deleted ${data.noticeDays} days from today, on a Monday, and every week after. They can’t be brought back.`}
      actions={<Button variant={data.deleting ? 'default' : 'destructive'} disabled={busy} onClick={() => void setDeleting(!data.deleting)}>{busy ? 'Saving…' : data.deleting ? 'Turn off' : 'Turn on'}</Button>}>
      {!data.deleting && <Alert tone="warning"><p>Turn this on only after your adviser has checked the periods above.</p></Alert>}
    </Dialog>}
    {holding && <HoldDialog onClose={() => setHolding(false)} />}
  </div>;
}

export function DueRecords({ data }: { data: DueList }) {
  const [holding, setHolding] = useState<DueRecord | null>(null), [ending, setEnding] = useState<DueRecord | null>(null);
  return <div className="space-y-6">
    <PageHeader title="Due to be deleted" description={data.deletesOn ? <>Deleted on <Day day={data.deletesOn} /> unless held.</> : 'Deleting is off, so nothing is deleted yet. This is what would be.'} />
    <Card>{data.items.length ? <Table caption="Records due" rows={data.items} rowKey={row => `${row.subject}-${row.id}`} columns={[
      { key: 'record', label: 'Record', primary: true, cell: row => <div className="min-w-0"><p className="font-medium">{row.name}</p><p className="text-[13px] text-muted-foreground">{row.detail}</p></div> },
      { key: 'kind', label: 'Kind', cell: row => row.what },
      { key: 'why', label: 'Why now', cell: row => <>{row.basis} <Day day={row.basisOn} /></> },
      { key: 'actions', label: 'Actions', srOnly: true, align: 'right', action: true, cell: row => row.holdId
        ? <div className="flex items-center justify-end gap-2"><Badge label={`Held until ${new Date(middayIso(row.heldUntil!)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`} tone="warning" /><Button size="sm" variant="ghost" onClick={() => setEnding(row)}>End hold</Button></div>
        : <Button size="sm" variant="outline" onClick={() => setHolding(row)}><Shield aria-hidden="true" className="size-4" />Hold</Button> }]}
      footer={data.total > 0 && <Pagination label="Due record pages" page={data.page} pageCount={Math.ceil(data.total / data.pageSize)} pageSize={data.pageSize} total={data.total} href={page => `/retention/due?page=${page}`} />} />
      : <CardBody><p className="text-sm text-muted-foreground">Nothing is due in the next 14 days.</p></CardBody>}</Card>
    {holding && <HoldDialog record={holding} onClose={() => setHolding(null)} />}
    {ending && <EndHoldDialog record={ending} onClose={() => setEnding(null)} />}
  </div>;
}

/** Hold one person's records (RetentionHoldScreen): a reason and an end date, up to 2 years. Found by name when opened from the top of the page. */
function HoldDialog({ record, onClose }: { record?: DueRecord; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [chosen, setChosen] = useState<DueRecord | null>(record ?? null), [query, setQuery] = useState(''), [found, setFound] = useState<DueRecord[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (chosen || query.trim().length < 2) return;
    let current = true;
    const timer = setTimeout(() => void readApi<{ items: DueRecord[] }>(`retention/people?q=${encodeURIComponent(query.trim())}`).then(result => { if (current) setFound(result.items); }).catch(() => undefined), 300);
    return () => { current = false; clearTimeout(timer); };
  }, [query, chosen]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !chosen) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setBusy(true); setError('');
    try { await mutate('retention/holds', 'POST', { subjectKind: chosen.subject, subjectId: chosen.id, until: form.until, reason: form.reason }); toast({ title: `${chosen.name}’s records are held` }); onClose(); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to hold them. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return <Dialog open onClose={onClose} busy={busy} title={chosen ? `Hold ${chosen.name}’s records` : 'Hold a person’s records'} description={chosen ? `Nothing of ${chosen.name.split(' ')[0]}’s is deleted while the hold lasts.` : 'For a dispute or an audit. Find them by name.'}
    actions={chosen ? <Button type="submit" form="retention-hold" disabled={busy}><Shield aria-hidden="true" className="size-4" />{busy ? 'Holding…' : 'Hold records'}</Button> : undefined}>
    {!chosen ? <div className="space-y-3">
      <Input label="Name" value={query} onChange={event => setQuery(event.target.value)} width="full" hint="People whose records some rule will delete one day." />
      {query.trim().length >= 2 && (found.length ? <ul className="divide-y divide-border rounded-md border">{found.map(item => <li key={`${item.subject}-${item.id}`}><button type="button" className="w-full px-3 py-2 text-left hover:bg-accent" onClick={() => setChosen(item)}>
        <span className="block text-sm font-medium">{item.name}</span><span className="block text-[13px] text-muted-foreground">{item.what} · due <Day day={item.dueOn} />{item.holdId ? ' · already held' : ''}</span></button></li>)}</ul>
        : <p className="text-sm text-muted-foreground">Nobody by that name has records due under any rule.</p>)}
    </div> : <form id="retention-hold" onSubmit={submit} className="space-y-4">
      <Input label="Hold until" name="until" type="date" required min={today} max={plusDays(today, 730)} width="sm" hint="Up to 2 years. You can extend it." />
      <Textarea label="Why" name="reason" required maxLength={500} rows={2} hint={HINT} />
      <Notice message={error} error /><PendingHint pending={busy} />
    </form>}
  </Dialog>;
}
function EndHoldDialog({ record, onClose }: { record: DueRecord; onClose: () => void }) {
  const router = useRouter(), toast = useToast(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function end() {
    setBusy(true); setError('');
    try { await mutate(`retention/holds/${record.holdId}/end`, 'POST'); toast({ title: 'Hold ended' }); onClose(); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to end the hold. Try again.')); }
    finally { setBusy(false); }
  }
  return <Dialog open onClose={onClose} busy={busy} title={`End the hold on ${record.name}’s records?`} description={`They follow the schedule again${record.dueOn <= new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) ? ' and are deleted on the next run' : ''}.`}
    actions={<Button disabled={busy} onClick={() => void end()}>{busy ? 'Ending…' : 'End hold'}</Button>}>{record.holdReason && <p className="text-sm">Held because: {record.holdReason}</p>}<Notice message={error} error /></Dialog>;
}

/** What the weekly runs deleted (RetentionLogScreen): kinds and counts, never names. */
export function DeletedLog({ runs }: { runs: RetentionRun[] }) {
  return <div className="space-y-6">
    <PageHeader title="Deleted" description="What the weekly runs deleted." />
    {runs.length ? runs.map(run => <Card key={run.day}><CardHeader title={<Day day={run.day} />} /><CardBody>{run.failed < 0
      ? <Alert tone="warning"><p>Nothing was deleted: the workspace has a new kind of record this job doesn’t know yet.</p></Alert>
      : <DescriptionList layout="rows" items={[...Object.entries(run.deleted).map(([kind, count]) => ({ label: KIND_NAMES[kind] ?? kind, value: `${count.records}, with ${count.files} ${count.files === 1 ? 'file' : 'files'}` })),
        ...(Object.keys(run.deleted).length ? [] : [{ label: 'Deleted', value: 'Nothing was due' }]), { label: 'Held, not deleted', value: String(run.held) }, ...(run.failed ? [{ label: 'Couldn’t be deleted', value: `${run.failed}, tried again next week` }] : [])]} />}</CardBody></Card>)
      : <Card><CardBody><p className="text-sm text-muted-foreground">Nothing has been deleted yet.</p></CardBody></Card>}
  </div>;
}
