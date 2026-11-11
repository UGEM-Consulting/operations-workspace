'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { DescriptionList } from '@/components/ui/description-list';
import { Progress } from '@/components/ui/feedback';
import { Input, RadioGroup, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { Timeline } from '@/components/ui/timeline';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { middayIso } from '@/lib/navigation';
import { fullName, type LeaveIt, type MemberLeave, type MemberProfile } from './types';

/**
 * On leave (section 35, designed as PutOnLeaveScreen, OnLeaveProfileScreen, OnLeaveProfilePhoneScreen, OnLeaveUpdaterScreen,
 * RecordReturnScreen, ChangeReturnDateScreen and LeaveToLeavingScreen, approved 2026-11-11). A dispatcher, support or updater
 * away for a while keeps their job, their place and who they work with. IT suspends the accounts they have and restores
 * them on the return day. Reasons are staff text, never health, family or other private details.
 */
export type LeaveAction = 'putOnLeave' | 'return' | 'backOn' | 'leaveReason' | 'cancelLeave';
const today = (at = Date.now()) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const plusDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
const START_MAX_DAYS = 30, LEAVE_MAX_DAYS = 183;
const HINT = 'Staff only. Never health, family or other private details.';
export const Day = ({ day }: { day: string }) => <LocalTime iso={middayIso(day)} format="date" />;
export const shortDay = (day: string) => new Date(middayIso(day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const weeks = (from: string, to: string) => { const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000); return days >= 14 ? `${Math.round(days / 7)} weeks` : `${days} day${days === 1 ? '' : 's'}`; };

/** The badge: away until the return day, or starting soon. */
export function leaveBadge(leave: MemberLeave) {
 return leave.started ? { label: `On leave until ${shortDay(leave.backOn)}`, tone: 'info' as const } : { label: `Leave from ${shortDay(leave.firstDay)}`, tone: 'info' as const };
}
/** Someone can go on leave while they work here and aren't leaving or already away. */
// Leave waits for an IT setup still under way, as the API does.
export const canPutOnLeave = (member: MemberProfile) => member.status === 'ACTIVE' && !member.notice && !member.leave && !member.itSetup?.open;
/** Cancelling waits for nothing IT completed; after that, their return is recorded instead. */
export const canCancelLeave = (leave: MemberLeave) => !leave.suspend?.completedAt && !leave.suspend?.tasks.some(task => task.status === 'COMPLETED');

/** “updater”, “supports”, or “supports and updaters”, for the people assisting someone. */
export function helperWords(helpers: { supportType?: string | null }[]) {
 const updaters = helpers.filter(row => row.supportType === 'UPDATER').length, supports = helpers.length - updaters;
 const word = (count: number, name: string) => count === 1 ? name : `${name}s`;
 return supports && updaters ? 'supports and updaters' : updaters ? word(updaters, 'updater') : word(supports, 'support');
}
const listed = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '';

/** The alert at the top of the page while someone is on leave, or about to be (OnLeaveProfileScreen). */
export function LeaveAlert({ member, leave }: { member: MemberProfile; leave: MemberLeave }) {
 const drivers = member.driversToReassign?.length ?? 0, helpers = member.supports ?? [];
 // What stays put, named only when they have it: “Their MC, team, drivers and updater stay as they are.”
 const kept = member.position === 'SUPPORT' ? [] : [member.current?.mc ? 'MC' : '', member.current?.team ? 'team' : '', drivers ? (drivers === 1 ? 'driver' : 'drivers') : '', helpers.length ? helperWords(helpers) : ''].filter(Boolean);
 const stays = member.position === 'SUPPORT' && member.supportOf ? `They keep assisting ${member.supportOf.wholeTeam ? `the whole ${member.supportOf.wholeTeam} team` : member.supportOf.dispatcher ?? 'their dispatcher'}.` : kept.length ? `Their ${listed(kept)} ${kept.length === 1 && !kept[0].endsWith('s') ? 'stays as it is' : 'stay as they are'}.` : '';
 return leave.started
  ? <Alert tone="info" title={<>{member.firstName} is away until <Day day={leave.backOn}/></>}><p>{stays}{leave.suspend ? leave.suspend.completedAt ? <> IT has suspended their accounts and restores them on <Day day={leave.backOn}/>.</> : ' IT is suspending their accounts.' : ''}{member.leadOf ? ` They stay ${member.leadOf.name}’s lead, with their sign-in off while they’re away.` : ''}</p></Alert>
  : <Alert tone="info" title={<>On leave from <Day day={leave.firstDay}/></>}><p>{member.firstName} works as usual until then.{leave.suspend ? ' IT plans now and suspends their accounts from that day.' : ''}</p></Alert>;
}

/** The Leave card: dates, why, who recorded it, and each change. */
export function LeaveCard({ leave }: { leave: MemberLeave }) {
 return <Card><CardHeader title="Leave"/><CardBody><DescriptionList layout="rows" items={[
  { label: 'Away', value: <><Day day={leave.firstDay}/> to <Day day={leave.backOn}/> ({weeks(leave.firstDay, leave.backOn)})</> },
  { label: 'Why', value: <span className="whitespace-pre-wrap">{leave.reason}</span> },
  { label: 'Recorded by', value: <>{leave.recordedBy} on <LocalTime iso={leave.createdAt} format="date"/></> },
  ...(leave.changes.length ? [{ label: 'Changes', value: <ul className="space-y-1">{[...leave.changes].reverse().map((change, index) => <li key={index}>{change.kind === 'BACK_ON'
   ? <>Return moved from <Day day={change.from!}/> to <Day day={change.to!}/> by {change.byName}{change.reason ? `: ${change.reason}` : ''}</>
   : <>Reason edited by {change.byName}</>}</li>)}</ul> }] : [])]}/></CardBody></Card>;
}

/** A dispatcher's drivers, supports and team while they're away: nothing moves (OnLeaveProfileScreen). */
export function WorkingWithCard({ member }: { member: MemberProfile }) {
 const drivers = member.driversToReassign ?? [], helpers = member.supports ?? [], first = member.firstName;
 if (member.position !== 'DISPATCHER' || (!drivers.length && !helpers.length && !member.leadOf)) return null;
 const word = helperWords(helpers);
 return <Card><CardHeader title={`Working with ${first}`} description="Nothing moves while they’re away. Reassign someone only if they shouldn’t wait."/><CardBody><DescriptionList layout="rows" items={[
  ...(drivers.length ? [{ label: 'Drivers', value: `${drivers.length}, still assigned to ${first}` }] : []),
  ...(helpers.length ? [{ label: word.charAt(0).toUpperCase() + word.slice(1), value: `${listed(helpers.map(row => row.name))}, still assisting ${first}` }] : []),
  ...(member.leadOf ? [{ label: 'Team', value: `${member.leadOf.name}, ${first} stays lead` }] : [])]}/></CardBody></Card>;
}

/** IT's side in the rail: what is suspended (never IT notes), or that there is nothing to suspend; after a return, the restore. */
export function LeaveItCard({ member, leave, restore }: { member: MemberProfile; leave: MemberLeave | null; restore: LeaveIt | null }) {
 if (leave) {
  const suspend = leave.suspend ?? null;
  if (!suspend) return <Card><CardHeader title="IT access" actions={<Badge label="Nothing to suspend" tone="neutral"/>}/><CardBody><p className="text-[13px] leading-5 text-muted-foreground">{member.firstName} has no company email, number or business software of their own, so IT has no checklist.</p></CardBody></Card>;
  const done = (key: string) => suspend.tasks.find(task => task.key === key)?.status === 'COMPLETED';
  const has = (key: string) => suspend.tasks.some(task => task.key === key);
  return <Card><CardHeader title="IT access" actions={<Badge label={suspend.completedAt ? 'Suspended' : leave.started ? 'Suspending' : 'Suspend scheduled'} tone="info"/>}/>
   <CardBody className="space-y-4 text-sm">
    {!suspend.completedAt && <Progress label="Suspend" value={suspend.done} max={suspend.total}/>}
    <DescriptionList layout="rows" items={[
     ...(has('GOOGLE_WORKSPACE') ? [{ label: 'Company email', value: `${done('GOOGLE_WORKSPACE') ? 'Suspended' : 'To suspend'}, ${leave.emailWhileAway === 'AUTO_REPLY' ? 'auto-reply on' : `new email forwarded to ${leave.forwardTo ?? 'the manager'}`}` }] : []),
     ...(has('RINGCENTRAL') ? [{ label: 'RingCentral', value: leave.callsWhileAway === 'VOICEMAIL' ? 'Calls go to voicemail' : `Calls forwarded to ${leave.forwardTo ?? 'the manager'}` }] : []),
     ...(member.leadOf ? [{ label: 'Team lead sign-in', value: leave.started ? 'Off until they return' : 'Turns off on the first day away' }] : []),
     { label: 'Restore', value: <Day day={leave.backOn}/> }]}/>
   </CardBody></Card>;
 }
 if (restore && !restore.completedAt) return <Card><CardHeader title="IT access" actions={<Badge label="Restoring" tone="info"/>}/>
  <CardBody className="space-y-3 text-sm"><Progress label="Restore" value={restore.done} max={restore.total}/><p className="text-[13px] leading-5 text-muted-foreground">You get a notification here when IT finishes.</p></CardBody></Card>;
 return null;
}

/** Earlier leaves, for the History tab. */
export function LeaveHistory({ leaves }: { leaves: MemberLeave[] }) {
 if (!leaves.length) return null;
 const ended = { RETURNED: 'Back', CANCELLED: 'Cancelled', LEAVING: 'Ended: leaving' } as const;
 return <Card><CardHeader title="Leave" description="Earlier time away."/><CardBody><Timeline items={leaves.map(leave => ({ id: leave.id,
  title: <><Day day={leave.firstDay}/> to <Day day={leave.backOn}/></>,
  meta: <>{leave.endedHow ? ended[leave.endedHow] : 'Ended'}{leave.endedAt ? <> · <LocalTime iso={leave.endedAt} format="date"/></> : null} · recorded by {leave.recordedBy}</>, body: leave.reason }))}/></CardBody></Card>;
}

/** The leave dialogs. Each sends one request and reloads the page; entries are kept when it fails. */
export function LeaveDialog({ action, member, onClose }: { action: LeaveAction; member: MemberProfile; onClose: () => void }) {
 const router = useRouter(), toast = useToast(), name = fullName(member), leave = member.leave ?? null;
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 const [firstDay, setFirstDay] = useState(today()), [when, setWhen] = useState<'today' | 'later'>('today');
 const [emailWhileAway, setEmail] = useState<'FORWARD' | 'AUTO_REPLY'>('FORWARD'), [callsWhileAway, setCalls] = useState<'FORWARD' | 'VOICEMAIL'>('FORWARD');
 const companyEmail = member.accounts?.companyEmail ?? member.existing?.companyEmail ?? null, number = member.accounts?.workPhone ?? member.existing?.ringCentralNumber ?? null;
 const drivers = member.driversToReassign?.length ?? 0, helpers = member.supports?.length ?? 0;
 async function submit(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (busy) return;
  const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
  setBusy(true); setError('');
  const path = `dispatch/members/${member.id}/on-leave`;
  try {
   if (action === 'putOnLeave') await mutate(path, 'POST', { version: member.version, firstDay: form.firstDay, backOn: form.backOn, reason: form.reason, ...(companyEmail ? { emailWhileAway } : {}), ...(number ? { callsWhileAway } : {}) });
   else if (action === 'return' && when === 'today') await mutate(`${path}/return`, 'POST', { version: member.version });
   else if (action === 'return' || action === 'backOn') await mutate(`${path}/back-on`, 'POST', { version: member.version, backOn: form.backOn, reason: form.reason });
   else if (action === 'leaveReason') await mutate(`${path}/reason`, 'POST', { version: member.version, reason: form.reason });
   else await mutate(`${path}/cancel`, 'POST', { version: member.version });
   toast({ title: action === 'putOnLeave' ? `${name} is on leave${form.firstDay > today() ? ` from ${shortDay(form.firstDay)}` : ''}` : action === 'return' && when === 'today' ? `${name} is back` : action === 'leaveReason' ? 'Reason saved' : action === 'cancelLeave' ? 'Leave cancelled' : 'Return date changed' });
   onClose(); router.refresh();
  } catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
  finally { setBusy(false); }
 }
 const title = action === 'putOnLeave' ? `Put ${name} on leave` : action === 'return' ? `${name} is back` : action === 'backOn' ? `Change ${name}’s return date` : action === 'leaveReason' ? 'Edit leave reason' : `Cancel ${name}’s leave?`;
 const keeps = [member.current?.mc ? 'MC' : '', member.current?.team ? 'team' : '', drivers ? 'drivers' : '', helpers ? helperWords(member.supports ?? []) : ''].filter(Boolean);
 const description = action === 'putOnLeave' ? `For time away with a return date. ${member.firstName} keeps ${keeps.length ? `their ${listed(keeps)}` : 'their place'}. Nobody is messaged.`
  : action === 'return' && leave ? `${member.firstName} is due back on ${shortDay(leave.backOn)}.` : action === 'backOn' ? 'IT’s restore moves to the new date.'
  : action === 'cancelLeave' ? `${member.firstName} stays Active with no leave. IT’s suspend checklist stops, and the cancelled leave stays in their history.` : undefined;
 // After today and after their first day away, the API's rule, also for a leave that hasn't started.
 const minBack = action === 'putOnLeave' ? plusDays(firstDay, 1) : plusDays(leave && leave.firstDay > today() ? leave.firstDay : today(), 1), maxBack = plusDays(action === 'putOnLeave' ? firstDay : leave?.firstDay ?? today(), LEAVE_MAX_DAYS);
 return <Dialog open onClose={onClose} busy={busy} size={action === 'putOnLeave' ? 'lg' : undefined} title={title} description={description} closeLabel={action === 'cancelLeave' ? 'Keep leave' : undefined}
  actions={<Button type="submit" form="leave-action">{busy ? 'Saving…' : action === 'putOnLeave' ? 'Put on leave' : action === 'return' ? (when === 'today' ? 'Record return' : 'Change return date') : action === 'backOn' ? 'Change return date' : action === 'leaveReason' ? 'Save reason' : 'Cancel leave'}</Button>}>
  <form id="leave-action" onSubmit={submit} className="space-y-4">
   {action === 'putOnLeave' && <>
    <div className="grid gap-4 sm:grid-cols-2">
     <Input label="First day away" name="firstDay" type="date" required value={firstDay} onChange={event => setFirstDay(event.target.value)} min={today()} max={plusDays(today(), START_MAX_DAYS)} width="full" hint={`Today, or up to ${START_MAX_DAYS} days ahead.`}/>
     <Input label="Back on" name="backOn" type="date" required min={minBack} max={maxBack} width="full" hint="The day they work again. Up to 6 months away."/>
    </div>
    <Textarea label="Why" name="reason" required maxLength={1000} rows={2} hint={HINT}/>
    {companyEmail || number ? <Card><CardHeader title="IT suspends their access" description="IT gets a checklist and a Telegram alert now, and suspends on the first day away. On the return day IT gets an alert to restore it."/>
     <CardBody className="space-y-4">
      <DescriptionList layout="rows" items={[...(companyEmail ? [{ label: 'Company email', value: companyEmail }] : []), ...(number ? [{ label: 'RingCentral number', value: number, mono: true }] : []),
       ...(member.leadOf ? [{ label: 'Team lead sign-in', value: 'Turned off on the first day, back on when they return' }] : [])]}/>
      {companyEmail && <RadioGroup name="emailWhileAway" label="New email while they’re away" cards value={emailWhileAway} onChange={value => setEmail(value as 'FORWARD' | 'AUTO_REPLY')} options={[
       { value: 'FORWARD', label: 'Forward to me', description: 'IT forwards new email to you until they return.' },
       { value: 'AUTO_REPLY', label: 'Auto-reply', description: 'Senders are told they’re away until the return day. Nothing is forwarded.' }]}/>}
      {number && <RadioGroup name="callsWhileAway" label="Calls to their number" cards value={callsWhileAway} onChange={value => setCalls(value as 'FORWARD' | 'VOICEMAIL')} options={[
       { value: 'FORWARD', label: 'Forward to me', description: 'IT forwards calls and texts to your RingCentral number.' },
       { value: 'VOICEMAIL', label: 'Voicemail', description: 'Calls go to voicemail until they return.' }]}/>}
     </CardBody></Card>
     : <p className="text-[13px] leading-5 text-muted-foreground">{member.firstName} has no company email or number of their own recorded, so IT gets no checklist unless they use business software alone.</p>}
    {(drivers > 0 || helpers > 0) && <Alert tone="info" title={`Their ${[drivers ? `${drivers} driver${drivers === 1 ? '' : 's'}` : '', helpers ? helperWords(member.supports ?? []) : ''].filter(Boolean).join(' and ')} stay with ${member.firstName}`}><p>Reassign any of them from their own page if they shouldn’t wait.{member.leadOf ? ` ${member.firstName} stays ${member.leadOf.name}’s lead.` : ''}</p></Alert>}
   </>}
   {action === 'return' && <>
    <RadioGroup name="when" label="When" cards value={when} onChange={value => setWhen(value as 'today' | 'later')} options={[
     { value: 'today', label: 'Back today', description: `${member.firstName} is Active again now. IT gets an alert to restore their access today.` },
     { value: 'later', label: 'Back on another day', description: 'Moves the return date. IT’s restore moves with it.' }]}/>
    {when === 'later' && <><Input label="Back on" name="backOn" type="date" required min={minBack} max={maxBack} width="sm"/><Textarea label="Why it changed" name="reason" required maxLength={1000} rows={2} hint={HINT}/></>}
    {when === 'today' && <Alert tone="info"><p>{member.leadOf ? 'Their team lead sign-in comes back once IT turns it on again. ' : ''}Change return date in More actions does the same as Back on another day.</p></Alert>}
   </>}
   {action === 'backOn' && leave && <>
    <Input label="Back on" name="backOn" type="date" required min={minBack} max={maxBack} width="sm" hint={`Now ${shortDay(leave.backOn)}. Tomorrow, or up to 6 months from the first day away.`}/>
    <Textarea label="Why it changed" name="reason" required maxLength={1000} rows={2} hint={HINT}/>
   </>}
   {action === 'leaveReason' && leave && <Textarea label="Why" name="reason" required maxLength={1000} rows={3} defaultValue={leave.reason} hint={HINT}/>}
   <Notice message={error} error/>
  </form>
 </Dialog>;
}
