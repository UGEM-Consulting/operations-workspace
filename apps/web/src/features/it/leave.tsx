'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PageCrumb } from '@/components/shell-context';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checklist, type ChecklistItem } from '@/components/ui/checklist';
import { CopyButton } from '@/components/ui/copy-button';
import { Avatar } from '@/components/ui/avatar';
import { Checkbox, Select, Textarea } from '@/components/ui/field';
import { Progress } from '@/components/ui/feedback';
import { DescriptionList } from '@/components/ui/description-list';
import { Timeline } from '@/components/ui/timeline';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { Badge, StatusBadge, statusLabel } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { SignIn } from '@/features/dispatch/sign-in';
import { readApi } from '@/features/onboarding/types';
import { type ItTask, type LeaveDetail, taskDone, taskOutcomes, type TaskOutcome } from './types';

const TASK_NAMES: Record<string, string> = { GOOGLE_WORKSPACE: 'Google Workspace', RINGCENTRAL: 'RingCentral', BUSINESS_SOFTWARE: 'Business software' };
const PLANNING: readonly TaskOutcome[] = ['PENDING', 'IN_PROGRESS', 'BLOCKED'];
const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date"/>;
const monthDay = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
/** A copyable value in the rail: the address or number, then its Copy button. */
const copyable = (text: string, label: string, mono = false) => <><span className={mono ? 'block break-all font-mono' : 'block break-all'}>{text}</span><span className="-ml-2.5 mt-1 block"><CopyButton text={text} label={label} size="sm" variant="ghost"/></span></>;

/**
 * Leave (section 35, designed as ItSuspendScreen and ItRestoreScreen, approved 2026-11-11): suspending someone's accounts while
 * they're away, and restoring them when they're back. Suspending can be completed from the first day away. Finishing the
 * last task tells the manager who recorded the leave; the person on leave is never messaged.
 */
export function ItLeave({ initial }: { initial: LeaveDetail }) {
 const toast = useToast(), router = useRouter();
 const [data, setData] = useState(initial), [pending, setPending] = useState<'refresh' | 'task' | null>(null);
 const [editing, setEditing] = useState<ItTask | null>(null), [taskStatus, setTaskStatus] = useState<TaskOutcome>('PENDING'), [taskError, setTaskError] = useState('');
 const { request, tasks } = data, profile = request.profile, suspend = request.kind === 'SUSPEND', cancelled = !!request.cancelledAt, closed = !!request.completedAt || cancelled, scheduled = request.scheduled && !cancelled, busy = !!pending;
 const shared = data.sharedSignIns ?? { dat: [], truckstop: [] }, completed = tasks.filter(taskDone).length;
 const completing = !!editing && taskDone({ status: taskStatus }) && tasks.filter(task => task.id !== editing.id).every(taskDone);
 const forward = profile.forwardToName ?? 'the manager';
 async function refresh() { setPending('refresh'); try { setData(await readApi<LeaveDetail>(`it/leave/${request.id}`)); toast({ title: 'Request refreshed' }); } catch (error) { toast({ tone: 'danger', title: 'Request not refreshed', description: errorMessage(error, 'Unable to refresh.') }); } finally { setPending(null); } }
 function open(task: ItTask) { setEditing(task); setTaskStatus(task.status); setTaskError(''); }
 async function update(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (!editing || busy) return;
  const notes = String(new FormData(event.currentTarget).get('notes') ?? '');
  if (taskStatus === 'BLOCKED' && !notes.trim()) { setTaskError('Describe what is blocking this task.'); return; }
  setPending('task'); setTaskError('');
  try {
   const updated = await mutate<LeaveDetail>(`it/leave/${request.id}/tasks/${editing.key}`, 'PATCH', { version: request.version, status: taskStatus, notes });
   setData(updated); setEditing(null);
   if (updated.request.completedAt) router.refresh();
   toast(updated.request.completedAt ? { title: suspend ? 'Access suspended' : 'Access restored', description: 'The manager who recorded the leave has been notified.' } : { title: 'Checklist task updated' });
  } catch (error) { setTaskError(errorMessage(error, 'Unable to update. Your entries have been kept.')); } finally { setPending(null); }
 }
 // What the manager chose for email and calls, said in the task itself.
 const describe = (task: ItTask) => suspend && task.key === 'GOOGLE_WORKSPACE' ? `Suspend the account and sign it out everywhere. ${profile.emailWhileAway === 'AUTO_REPLY' ? 'Turn on an auto-reply that they’re away until they return.' : `Forward new email to ${forward} until they return.`} Keep the mailbox.`
  : suspend && task.key === 'RINGCENTRAL' ? `${profile.callsWhileAway === 'VOICEMAIL' ? 'Send calls and texts to voicemail.' : `Forward calls and texts to ${forward}’s number.`} Keep the user and the number.`
  : !suspend && task.key === 'GOOGLE_WORKSPACE' ? `Restore the account and remove the ${profile.emailWhileAway === 'AUTO_REPLY' ? 'auto-reply' : `forwarding to ${forward}`}.` : task.description;
 const toChecklist = (task: ItTask): ChecklistItem => ({ id: task.key, title: task.label, optional: task.optional, status: task.status, note: task.notes || undefined, description: describe(task),
  meta: task.status !== 'PENDING' && <>Updated <LocalTime iso={task.updatedAt}/></>,
  action: !closed && <Button variant="outline" size="sm" disabled={busy} onClick={() => open(task)}>{scheduled ? 'Add note' : 'Update'}<span className="sr-only">: {task.label}</span></Button> });
 const blocked = tasks.filter(task => task.status === 'BLOCKED');
 const activityTitle = (event: LeaveDetail['activity'][number]) => event.event === 'SUSPEND_REQUEST_CREATED' ? `Leave recorded${request.managerName ? ` by ${request.managerName}` : ''}` : event.event === 'RESTORE_REQUEST_CREATED' ? why ?? 'Back from leave'
  : event.event === 'MANAGER_HANDED_OVER' ? (event.metadata.forwardingStarted ? 'Handed over to another manager: change the forwarding' : 'Handed over to another manager') : event.event === 'IT_SUSPEND_COMPLETED' ? 'Access suspended' : event.event === 'IT_RESTORE_COMPLETED' ? 'Access restored' : event.event === 'BACK_ON_CHANGED' ? 'Return date changed' : event.event === 'DETAILS_CORRECTED' ? 'Name corrected' : event.event === 'CANCELLED' ? 'Stopped: the leave ended'
  : `Task updated · ${TASK_NAMES[String(event.metadata.key)] ?? statusLabel(String(event.metadata.key))}`;
 const title = suspend ? 'Suspend checklist' : 'Restore checklist';
 // A restore also follows a cancelled leave or a cancelled notice, when they may never have been away: say which.
 const why = suspend ? null : request.leaveEnded === 'CANCELLED' ? 'Leave cancelled' : request.leaveEnded === 'LEAVING' ? 'Notice cancelled: they’re staying' : null;
 return <div className="space-y-6">
  <PageCrumb label={profile.displayName}/>
  <PageHeader title={profile.displayName} badge={cancelled ? <Badge label="Stopped" tone="neutral"/> : closed ? <StatusBadge status="COMPLETED"/> : suspend ? <Badge label={scheduled ? `Suspend ${new Date(`${request.dueOn}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : 'Suspend'} tone="warning"/> : <Badge label={request.dueOn <= easternToday() ? 'Restore today' : `Restore ${monthDay(request.dueOn)}`} tone="warning"/>}
   meta={suspend ? [<>On leave {day(profile.firstDay)} to {day(profile.backOn)}</>, request.managerName && `Recorded by ${request.managerName}`].filter(Boolean)
    : [why ? <>{why} · restore from {day(request.dueOn)}</> : <>Back on {day(profile.backOn)}</>, request.suspended && `Suspended ${new Date(request.suspended.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}`].filter(Boolean)}
   action={!closed && <Button variant="outline" disabled={busy} onClick={() => void refresh()}><RefreshCw aria-hidden="true" className="size-4"/>{pending === 'refresh' ? 'Refreshing…' : 'Refresh'}</Button>}/>
  <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
   <div className="min-w-0 space-y-6">
    {cancelled ? <Alert tone="info" title="Checklist stopped"><p>Their leave ended before this was finished: they came back early, the leave was cancelled, or they’re leaving. {suspend ? 'Anything you completed is on a restore or removal checklist.' : ''}</p></Alert>
     : closed ? <Alert tone="success" title={suspend ? 'Access suspended' : 'Access restored'}><p>Finished <LocalTime iso={request.completedAt}/>. The manager was notified and this checklist is read-only.</p></Alert>
     : suspend && scheduled ? <Alert tone="info" title="Suspend, don’t remove"><p>{profile.displayName} works until {day(profile.firstDay)}. Plan now; tasks can be marked completed from that day. Keep the mailbox, number and licences: you’ll get an alert to restore them on {day(profile.backOn)}.</p></Alert>
     : suspend ? <Alert tone="info" title="Suspend, don’t remove"><p>{profile.displayName} is coming back. Keep the mailbox, number and licences; you’ll get an alert to restore them on {day(profile.backOn)}.</p></Alert>
     : blocked.length > 0 ? <Alert tone="warning" title={blocked.length === 1 ? '1 task is blocked' : `${blocked.length} tasks are blocked`}><ul className="space-y-1">{blocked.map(task => <li key={task.key}><span className="font-medium">{task.label}:</span> {task.notes}</li>)}</ul></Alert>
     : null}
    <Card>
     <CardHeader title={title} description={closed ? 'Every task is finished.' : `Finishing the last task lets ${request.managerName ?? 'the manager'} know.`} actions={<Progress className="w-44" label="Progress" value={completed} max={tasks.length}/>}/>
     <div className="mt-3 border-t border-border"><Checklist titleAs="h3" items={tasks.map(toChecklist)}/></div>
     {profile.teamLead && suspend && <p className="border-t border-border px-4 py-3 text-[13px] leading-5 text-muted-foreground sm:px-5">Their team lead sign-in is turned off by the workspace on the first day away. Nothing to do here.</p>}
    </Card>
    {profile.teamLead && !suspend && <Card><CardHeader title="Team lead sign-in" description={`${profile.displayName} still leads ${profile.teamName ?? 'a team'}, so a Turn sign-in back on request waits in IT tasks, with a new password to give them.`}/>
     <CardBody><Badge label={request.signInWaiting === false ? 'Done in Sign-ins' : 'Waiting in Sign-ins'} tone={request.signInWaiting === false ? 'success' : 'info'}/></CardBody></Card>}
    <Card><CardHeader title="Activity"/><CardBody><Timeline items={[...data.activity].reverse().map(event => ({ id: event.id, tone: event.event.startsWith('IT_') || event.metadata.newStatus === 'COMPLETED' ? 'success' as const : event.metadata.newStatus === 'BLOCKED' ? 'warning' as const : 'neutral' as const, title: activityTitle(event), meta: <LocalTime iso={event.createdAt}/> }))}/></CardBody></Card>
   </div>
   <div className="min-w-0 space-y-6 xl:sticky xl:top-20">
    {!suspend ? <Card><CardHeader title="Accounts"/><CardBody><DescriptionList layout="rows" items={[
     ...(profile.companyEmail ? [{ label: 'Company email', value: copyable(profile.companyEmail, 'Copy email') }] : []),
     ...(profile.ringCentralNumber ? [{ label: 'RingCentral number', value: copyable(profile.ringCentralNumber, 'Copy number', true) }] : []),
     ...(profile.datEmail ? [{ label: 'DAT sign-in', value: <SignIn email={profile.datEmail} others={shared.dat}/> }] : []), ...(profile.truckstopEmail ? [{ label: 'Truckstop sign-in', value: <SignIn email={profile.truckstopEmail} others={shared.truckstop}/> }] : []),
     ...(request.suspended ? [{ label: 'Suspended by', value: <>{request.suspended.by ?? 'IT'}, {new Date(request.suspended.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}</> }] : [])]}/></CardBody></Card>
    : <Card><CardHeader title="Accounts"/><CardBody className="space-y-4">
     <div className="flex items-center gap-3"><Avatar name={profile.displayName} size="lg"/>
      <div className="min-w-0"><p className="truncate font-medium">{profile.displayName}</p><p className="text-[13px] text-muted-foreground">{profile.position}{profile.mcName ? ` · ${profile.mcName}` : ''}{profile.teamName ? ` · ${profile.teamName}` : ''}</p></div></div>
     <DescriptionList layout="rows" items={[
      ...(profile.companyEmail ? [{ label: 'Company email', value: copyable(profile.companyEmail, 'Copy email') },
       { label: 'Email while away', value: profile.emailWhileAway === 'AUTO_REPLY' ? 'Auto-reply' : `Forward to ${forward}` }] : []),
      ...(profile.ringCentralNumber ? [{ label: 'RingCentral number', value: copyable(profile.ringCentralNumber, 'Copy number', true) }, { label: 'Calls while away', value: profile.callsWhileAway === 'VOICEMAIL' ? 'Voicemail' : `Forward to ${forward}` }] : []),
      ...(profile.datEmail ? [{ label: 'DAT sign-in', value: <SignIn email={profile.datEmail} others={shared.dat}/> }] : []), ...(profile.truckstopEmail ? [{ label: 'Truckstop sign-in', value: <SignIn email={profile.truckstopEmail} others={shared.truckstop}/> }] : []),
      { label: 'Back on', value: day(profile.backOn) }]}/>
    </CardBody></Card>}
    <p className="text-xs leading-5 text-muted-foreground">Checklist updates are manual records; they don’t change accounts for you. Don’t put passwords in notes.</p>
   </div>
  </div>
  {editing && <Dialog open onClose={() => setEditing(null)} title={`Update ${editing.label}`} description={scheduled ? 'Plan ahead. This can be marked completed from their first day away.' : 'Record the outcome of your manual work.'} busy={pending === 'task'}
   actions={<Button form="it-leave-editor" type="submit">{pending === 'task' ? 'Saving…' : completing ? (suspend ? 'Finish suspending' : 'Finish restoring') : 'Save task'}</Button>}>
   <form id="it-leave-editor" onSubmit={update} className="space-y-4">
    <Select id="leave-status" label="Status" name="status" value={taskStatus} onChange={event => setTaskStatus(event.target.value as TaskOutcome)} width="sm"
     options={taskOutcomes.filter(status => (status !== 'NOT_NEEDED' || editing.optional) && (!scheduled || PLANNING.includes(status))).map(status => ({ value: status, label: statusLabel(status) }))}/>
    <Textarea id="leave-notes" label={taskStatus === 'BLOCKED' ? 'Blocked reason' : 'Notes'} optional={taskStatus !== 'BLOCKED'} name="notes" defaultValue={editing.notes} required={taskStatus === 'BLOCKED'} maxLength={1000} hint="Visible to IT only. Don’t put passwords in notes."/>
    {completing && <div className="space-y-3 rounded-md bg-warning-background p-4 text-sm text-warning"><p className="font-semibold">This finishes the checklist.</p><p>It becomes read-only and the manager who recorded the leave receives a portal notification.</p><Checkbox name="confirmCompletion" required label={suspend ? 'I confirm their access is suspended.' : 'I confirm their access is restored.'} className="text-foreground"/></div>}
    <Notice message={taskError} error/><PendingHint pending={pending === 'task'}/>
   </form>
  </Dialog>}
 </div>;
}
