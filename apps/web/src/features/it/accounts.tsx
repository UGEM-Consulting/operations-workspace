'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PageCrumb } from '@/components/shell-context';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checklist, type ChecklistItem } from '@/components/ui/checklist';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Progress } from '@/components/ui/feedback';
import { DescriptionList } from '@/components/ui/description-list';
import { Timeline } from '@/components/ui/timeline';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { LocalTime } from '@/components/ui/local-time';
import { useToast } from '@/components/ui/toast';
import { Badge, StatusBadge, statusLabel } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { readApi } from '@/features/onboarding/types';

// IT requests about company accounts (Design System section 33: ItCloseAccountTaskScreen, and a move's new accounts).
export interface AccountRequestDetail {
  request: { id: string; memberId: string; kind: 'CLOSE' | 'MOVE'; version: number; status: string; note: string | null; emailAfter: 'FORWARD' | 'SUSPEND'; forwardToName: string | null; managerName: string | null;
    newCompanyEmail: string | null; newRingCentralNumber: string | null; newRingCentralExtension: string | null; createdAt: string; completedAt: string | null; cancelledAt: string | null;
    profile: { displayName: string; fromMc: string | null; toMc: string | null; close: { label: string; value: string }[]; keep: { value: string; reason: string }[]; create: string[] } };
  tasks: { id: string; key: string; label: string; description: string; status: string; notes: string; updatedAt: string }[];
  activity: { id: string; event: string; createdAt: string; metadata: Record<string, unknown> }[];
}
const OUTCOMES = ['PENDING', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED'] as const;

/**
 * One account request: what to close, keep and create, the checklist, and (for a move) the new accounts IT records. Finishing
 * the last task updates the record and tells whoever asked; nobody else is messaged.
 */
export function ItAccountRequestView({ initial }: { initial: AccountRequestDetail }) {
  const toast = useToast(), router = useRouter();
  const [data, setData] = useState(initial), [pending, setPending] = useState<'refresh' | 'task' | 'contact' | null>(null);
  const [editing, setEditing] = useState<AccountRequestDetail['tasks'][number] | null>(null), [status, setStatus] = useState('PENDING'), [error, setError] = useState(''), [contactError, setContactError] = useState('');
  const { request, tasks } = data, profile = request.profile, closed = !!request.completedAt || !!request.cancelledAt, busy = !!pending, move = request.kind === 'MOVE';
  const completed = tasks.filter(task => task.status === 'COMPLETED').length;
  async function refresh() { setPending('refresh'); try { setData(await readApi<AccountRequestDetail>(`it/accounts/${request.id}`)); } catch (failure) { toast({ tone: 'danger', title: 'Not refreshed', description: errorMessage(failure, 'Unable to refresh.') }); } finally { setPending(null); } }
  async function update(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing || busy) return;
    const notes = String(new FormData(event.currentTarget).get('notes') ?? '');
    if (status === 'BLOCKED' && !notes.trim()) { setError('Describe what is blocking this task.'); return; }
    setPending('task'); setError('');
    try {
      const updated = await mutate<AccountRequestDetail>(`it/accounts/${request.id}/tasks/${editing.key}`, 'PATCH', { version: request.version, status, notes });
      setData(updated); setEditing(null); if (updated.request.completedAt) router.refresh();
      toast(updated.request.completedAt ? { title: 'Finished', description: `${request.managerName ?? 'The manager'} has been notified.` } : { title: 'Checklist task updated' });
    } catch (failure) { setError(errorMessage(failure, 'Unable to update. Your entries have been kept.')); } finally { setPending(null); }
  }
  async function record(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPending('contact'); setContactError('');
    try { setData(await mutate<AccountRequestDetail>(`it/accounts/${request.id}/contact`, 'PATCH', { version: request.version, ...form })); toast({ title: 'New accounts saved' }); }
    catch (failure) { setContactError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); } finally { setPending(null); }
  }
  const items = tasks.map((task): ChecklistItem => ({ id: task.key, title: task.label, status: task.status as ChecklistItem['status'], note: task.notes || undefined,
    description: task.key === 'CLOSE_EMAIL' && request.emailAfter === 'FORWARD' ? `${task.description} Forward new email to ${request.forwardToName ?? 'the manager'} for 30 days.` : task.description,
    meta: task.status !== 'PENDING' && <>Updated <LocalTime iso={task.updatedAt} /></>,
    action: !closed && <Button variant="outline" size="sm" disabled={busy} onClick={() => { setEditing(task); setStatus(task.status); setError(''); }}>Update<span className="sr-only">: {task.label}</span></Button> }));
  const title = move ? `New accounts for ${profile.displayName}` : `Close ${profile.displayName}’s ${profile.fromMc ?? ''} account`.replace('  ', ' ');
  return <div className="space-y-6">
    <PageCrumb label={profile.displayName} />
    <PageHeader title={title} badge={request.cancelledAt ? <Badge label="Cancelled" tone="neutral" /> : <StatusBadge status={request.completedAt ? 'COMPLETED' : request.status} />}
      meta={[<>Asked by {request.managerName ?? 'a manager'} on <LocalTime iso={request.createdAt} format="date" /></>, move ? `${profile.fromMc ?? 'No MC'} to ${profile.toMc}` : null].filter(Boolean)}
      action={!closed && <Button variant="outline" disabled={busy} onClick={() => void refresh()}><RefreshCw aria-hidden="true" className="size-4" />{pending === 'refresh' ? 'Refreshing…' : 'Refresh'}</Button>} />
    {request.cancelledAt && <Alert tone="info" title="Cancelled"><p>They’re leaving, so their removal checklist lists what to close now.</p></Alert>}
    {request.completedAt && <Alert tone="success" title="Finished"><p>Finished <LocalTime iso={request.completedAt} />. {request.managerName ?? 'The manager'} was notified and this checklist is read-only.</p></Alert>}
    {request.note && !closed && <Alert tone="info" title={`Note from ${request.managerName ?? 'the manager'}`}><p className="whitespace-pre-wrap">{request.note}</p></Alert>}
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <div className="min-w-0 space-y-6">
        <Card><CardHeader title="Checklist" description={closed ? 'Every task is finished.' : 'Finishing the last task updates their record and lets the manager know.'} actions={<Progress className="w-44" label="Progress" value={completed} max={tasks.length} />} />
          <div className="mt-3 border-t border-border"><Checklist titleAs="h3" items={items} /></div></Card>
        <Card><CardHeader title="Activity" /><CardBody><Timeline items={[...data.activity].reverse().map(event => ({ id: event.id, title: event.event === 'TASK_UPDATED' ? `Task updated · ${tasks.find(task => task.key === event.metadata.key)?.label ?? String(event.metadata.key)} · ${statusLabel(String(event.metadata.newStatus))}`
          : event.event === 'ACCOUNTS_RECORDED' ? 'New accounts recorded' : event.event === 'IT_ACCOUNT_COMPLETED' ? 'Finished' : event.event === 'MANAGER_HANDED_OVER' ? 'Handed over to another manager' : 'Request created', meta: <LocalTime iso={event.createdAt} /> }))} /></CardBody></Card>
      </div>
      <div className="min-w-0 space-y-6 xl:sticky xl:top-20">
        {profile.close.length > 0 && <Card><CardHeader title="Close" /><CardBody><DescriptionList layout="rows" items={profile.close.map(item => ({ label: item.label, value: <span className="break-all">{item.value}</span> }))} /></CardBody></Card>}
        {profile.keep.length > 0 && <Card><CardHeader title="Keep" description="Still signs in to a load board, so it stays open." /><CardBody><DescriptionList layout="rows" items={profile.keep.map(item => ({ label: item.reason, value: <span className="break-all">{item.value}</span> }))} /></CardBody></Card>}
        {move && <Card><CardHeader title={`New at ${profile.toMc}`} description="Record them here before completing their tasks." />
          <CardBody><form onSubmit={record} className="space-y-4"><fieldset disabled={busy || closed} className="min-w-0 space-y-4">
            <Input label="Company email" name="companyEmail" type="email" optional maxLength={254} defaultValue={request.newCompanyEmail ?? ''} width="full" />
            <Input label="RingCentral number" name="ringCentralNumber" type="tel" optional maxLength={40} defaultValue={request.newRingCentralNumber ?? ''} width="full" />
            <Input label="Extension" name="ringCentralExtension" optional inputMode="numeric" maxLength={6} defaultValue={request.newRingCentralExtension ?? ''} width="sm" />
            <Notice message={contactError} error />
            {!closed && <Button type="submit" variant="outline">{pending === 'contact' ? 'Saving…' : 'Save new accounts'}</Button>}
          </fieldset></form></CardBody></Card>}
        <p className="text-xs leading-5 text-muted-foreground">Checklist updates are manual records; they don’t change accounts for you. Don’t put passwords in notes.</p>
      </div>
    </div>
    {editing && <Dialog open onClose={() => setEditing(null)} title={`Update ${editing.label}`} description="Record the outcome of your manual work." busy={pending === 'task'} actions={<Button form="it-account-editor" type="submit">{pending === 'task' ? 'Saving…' : 'Save task'}</Button>}>
      <form id="it-account-editor" onSubmit={update} className="space-y-4">
        <Select label="Status" name="status" value={status} onChange={event => setStatus(event.target.value)} width="sm" options={OUTCOMES.map(value => ({ value, label: statusLabel(value) }))} />
        <Textarea label="Notes" name="notes" optional defaultValue={editing.notes} rows={3} hint="Never passwords." />
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
