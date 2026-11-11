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
import { type ItTask, type NumberOutcome, type RemovalDetail, taskDone, taskOutcomes, type TaskOutcome } from './types';

const NUMBER_OUTCOMES:{value:NumberOutcome;label:string}[]=[{value:'KEPT',label:'Kept for the next dispatcher'},{value:'FORWARDED',label:'Forwarded to the team'},{value:'RELEASED',label:'Released'}];
const outcomeLabel=(value:NumberOutcome|null)=>NUMBER_OUTCOMES.find(option=>option.value===value)?.label;
// Task names in the activity list, written as on the checklist.
const TASK_NAMES:Record<string,string>={GOOGLE_WORKSPACE:'Google Workspace',DISPATCH_GROUP:'Dispatch group',RINGCENTRAL:'RingCentral',BUSINESS_SOFTWARE:'Business software',SHARED_PASSWORDS:'Shared passwords',EQUIPMENT:'Equipment'};
const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
// Only what a scheduled removal can record: nothing is removed yet.
const PLANNING:readonly TaskOutcome[]=['PENDING','IN_PROGRESS','BLOCKED'];

/**
 * An IT removal request (designed as ItRemovalScreen and ItRemovalScheduledScreen): the reverse of setup, opened when a
 * dispatcher's last day is recorded. Before that day IT can plan (notes, in progress) but not complete tasks, unless a
 * manager asked to remove access now. The RingCentral task records what happens to the number; finishing the last task
 * tells the manager who recorded it.
 */
export function ItRemoval({initial}:{initial:RemovalDetail}){
 const toast=useToast();
 const router=useRouter();
 const [data,setData]=useState(initial),[pending,setPending]=useState<'refresh'|'task'|null>(null);
 const [editing,setEditing]=useState<ItTask|null>(null),[taskStatus,setTaskStatus]=useState<TaskOutcome>('PENDING'),[outcome,setOutcome]=useState<NumberOutcome|''>(''),[taskError,setTaskError]=useState('');
 const {request,tasks}=data,profile=request.profile,cancelled=!!request.cancelledAt,closed=!!request.completedAt||cancelled,scheduled=request.scheduled&&!cancelled,busy=!!pending;
 const shared=data.sharedSignIns??{dat:[],truckstop:[]},sharedPeople=[...new Set([...shared.dat,...shared.truckstop].map(person=>person.name))],sharedBoards=[...(shared.dat.length?['DAT']:[]),...(shared.truckstop.length?['Truckstop']:[])].join(' and ');
 const completed=tasks.filter(taskDone).length;
 const completing=!!editing&&taskDone({status:taskStatus})&&tasks.filter(task=>task.id!==editing.id).every(taskDone);
 const needsOutcome=editing?.key==='RINGCENTRAL'&&!!profile.ringCentralNumber;
 const due=!closed&&!scheduled&&request.dueOn<=today();
 async function refresh(){setPending('refresh');try{setData(await readApi<RemovalDetail>(`it/removals/${request.id}`));toast({title:'Request refreshed'});}catch(error){toast({tone:'danger',title:'Request not refreshed',description:errorMessage(error,'Unable to refresh.')});}finally{setPending(null);}}
 function open(task:ItTask){setEditing(task);setTaskStatus(task.status);setOutcome(request.numberOutcome??'');setTaskError('');}
 async function update(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(!editing||busy)return;
  const notes=String(new FormData(event.currentTarget).get('notes')??'');
  if(taskStatus==='BLOCKED'&&!notes.trim()){setTaskError('Describe what is blocking this task.');return;}
  if(needsOutcome&&taskStatus==='COMPLETED'&&!outcome){setTaskError('Choose what happens to the RingCentral number.');return;}
  setPending('task');setTaskError('');
  try{
   const updated=await mutate<RemovalDetail>(`it/removals/${request.id}/tasks/${editing.key}`,'PATCH',{version:request.version,status:taskStatus,notes,...(needsOutcome&&outcome?{numberOutcome:outcome}:{})});
   setData(updated);setEditing(null);
   if(updated.request.completedAt)router.refresh();
   toast(updated.request.completedAt?{title:'Access removed',description:'The manager who marked them as left has been notified.'}:{title:'Checklist task updated'});
  }catch(error){setTaskError(errorMessage(error,'Unable to update. Your entries have been kept.'));}finally{setPending(null);}
 }
 const blocked=tasks.filter(task=>task.status==='BLOCKED');
 const toChecklist=(task:ItTask):ChecklistItem=>({id:task.key,title:task.label,optional:task.optional,status:task.status,note:task.notes||undefined,
  description:task.key==='GOOGLE_WORKSPACE'&&request.emailAfter==='FORWARD'?`${task.description} Forward new email to ${request.forwardToName??'the manager'} for 30 days.`:task.description,
  meta:task.status!=='PENDING'&&<>Updated <LocalTime iso={task.updatedAt}/></>,
  action:!closed&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>open(task)}>{scheduled?'Add note':'Update'}<span className="sr-only">: {task.label}</span></Button>});
 const ringCentral=tasks.filter(task=>task.key==='RINGCENTRAL'),before=tasks.filter(task=>['GOOGLE_WORKSPACE','DISPATCH_GROUP'].includes(task.key)),after=tasks.filter(task=>!['GOOGLE_WORKSPACE','DISPATCH_GROUP','RINGCENTRAL'].includes(task.key));
 // Who marked them as left stays the same when the manager's records are handed over; an older API sends only the manager.
 const recordedBy=request.recordedByName??request.managerName;
 // The forwarding target changed after IT started on the email task, so what they set up may point at the wrong person.
 const forwardingMoved=!closed&&!cancelled&&request.emailAfter==='FORWARD'&&data.activity.some(event=>event.event==='MANAGER_HANDED_OVER'&&event.metadata.forwardingStarted===true);
 const activityTitle=(event:RemovalDetail['activity'][number])=>event.event==='REMOVAL_REQUEST_CREATED'?`Removal request created${recordedBy?` · recorded by ${recordedBy}`:''}`
  :event.event==='MANAGER_HANDED_OVER'?'Handed over to another manager':event.event==='IT_REMOVAL_COMPLETED'?'Access removed':event.event==='LAST_DAY_CHANGED'?'Last day changed':event.event==='ACCOUNTS_CORRECTED'?'Manager corrected the recorded accounts':event.event==='REMOVAL_CANCELLED'?'Notice cancelled: the dispatcher is staying':event.event==='ACCESS_REMOVAL_REQUESTED'?'Manager asked to remove access now':`Task updated · ${TASK_NAMES[String(event.metadata.key)]??statusLabel(String(event.metadata.key))}`;
 const activityTone=(event:RemovalDetail['activity'][number])=>event.event==='IT_REMOVAL_COMPLETED'||event.metadata.newStatus==='COMPLETED'?'success' as const:event.metadata.newStatus==='BLOCKED'?'warning' as const:'neutral' as const;
 return <div className="space-y-6">
 <PageCrumb label={profile.displayName}/>
 <PageHeader title={profile.displayName} badge={cancelled?<Badge label="Cancelled" tone="neutral"/>:closed?<StatusBadge status="COMPLETED"/>:scheduled?<Badge label="Scheduled" tone="info"/>:<Badge label="Remove access" tone="danger"/>}
  meta={[request.leftAt&&<>Left <LocalTime iso={request.leftAt} format="date"/></>,scheduled?<>Last day <LocalTime iso={`${request.dueOn}T12:00:00Z`} format="date"/></>:null,scheduled?'Remove at the end of that day':<>Remove by end of <LocalTime iso={`${request.dueOn}T12:00:00Z`} format="date"/></>,recordedBy&&`Recorded by ${recordedBy}`].filter(Boolean)}
  action={!closed&&<Button variant="outline" disabled={busy} onClick={()=>void refresh()}><RefreshCw aria-hidden="true" className="size-4"/>{pending==='refresh'?'Refreshing…':'Refresh'}</Button>}/>
 <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
  <div className="min-w-0 space-y-6">
   {forwardingMoved&&<Alert tone="warning" title="Email forwarding changed"><p>The manager’s records were handed over, so new email now goes to {request.forwardToName??'the new manager'}. If you’ve already set up forwarding, change it.</p></Alert>}
   {!closed&&!cancelled&&data.activity.some(event=>event.event==='ACCOUNTS_CORRECTED'&&event.metadata.reopened===true)&&<Alert tone="warning" title="A manager corrected the accounts"><p>A step you finished opened again because a company email, RingCentral number or load board sign-in changed. Check the accounts below.</p></Alert>}
   {!closed&&!cancelled&&sharedPeople.length>0&&<Alert tone="warning" title="Someone else still uses a sign-in"><p>{sharedPeople.join(' and ')} also {sharedPeople.length===1?'uses':'use'} {profile.displayName}’s {sharedBoards} sign-in and {sharedPeople.length===1?'is':'are'} staying. Change its password and tell their manager, rather than closing it.</p></Alert>}
   {profile.suspendedOnLeave&&!closed&&!cancelled&&<Alert tone="info" title="Suspended during leave"><p>{profile.displayName} was on leave, so some accounts may already be suspended. Check them, then remove them.</p></Alert>}
   {profile.noSetupRecord&&!closed&&!cancelled&&<Alert tone="warning" title="No IT setup on record"><p>{profile.displayName} started before the workspace, so these accounts come from their manager and may be incomplete. Check the admin consoles as well.</p></Alert>}
   {cancelled?<Alert tone="info" title="Removal cancelled"><p>The manager cancelled the notice: this dispatcher is staying, and nothing needs removing.</p></Alert>
    :scheduled?<Alert tone="info" title="Don’t remove anything yet"><p>{profile.displayName} keeps working until the end of <LocalTime iso={`${request.dueOn}T12:00:00Z`} format="date"/>. You can add notes and plan now; tasks can be marked completed from that day. If the manager asks to remove access now, this page says so and you get an alert.</p></Alert>
    :request.removeNowAt&&!closed?<Alert tone="danger" title="Remove access now"><p>A manager asked for this <LocalTime iso={request.removeNowAt}/>, before the dispatcher’s last day. Remove sign-in first: email, then RingCentral.</p></Alert>
    :closed?<Alert tone="success" title="Access removed"><p>Finished <LocalTime iso={request.completedAt}/>. The manager was notified and this checklist is read-only.</p></Alert>
    :blocked.length>0?<Alert tone="warning" title={blocked.length===1?'1 task is blocked':`${blocked.length} tasks are blocked`}><ul className="space-y-1">{blocked.map(task=><li key={task.key}><span className="font-medium">{task.label}:</span> {task.notes}</li>)}</ul></Alert>
    :due&&<Alert tone="warning" title={request.dueOn<today()?'Overdue':'Due today'}><p>Their last day has come. Remove sign-in first: email, then RingCentral.</p></Alert>}
   <Card>
    <CardHeader title="Removal checklist" description={closed?'Every task is finished.':'Finishing the last task closes the request and lets the manager know.'}
     actions={<Progress className="w-44" label="Progress" value={completed} max={tasks.length}/>}/>
    <div className="mt-3 border-t border-border">
     <Checklist titleAs="h3" items={before.map(toChecklist)}/>
     {ringCentral.length>0&&<Checklist className="border-t border-border" heading="RingCentral" titleAs="h4" items={ringCentral.map(toChecklist)}/>}
     <Checklist className="border-t border-border" titleAs="h3" items={after.map(toChecklist)}/>
    </div>
   </Card>
   <Card><CardHeader title="Activity"/><CardBody><Timeline items={[...data.activity].reverse().map(event=>({id:event.id,tone:activityTone(event),title:activityTitle(event),meta:<LocalTime iso={event.createdAt}/>}))}/></CardBody></Card>
  </div>
  <div className="min-w-0 space-y-6 xl:sticky xl:top-20">
   <Card><CardHeader title="Accounts to remove"/><CardBody className="space-y-4">
    <div className="flex items-center gap-3"><Avatar name={profile.displayName} size="lg"/>
     <div className="min-w-0"><p className="truncate font-medium">{profile.displayName}</p><p className="text-[13px] text-muted-foreground">{profile.position??'Dispatcher'}{profile.mcName?` · ${profile.mcName}`:''}{profile.teamName?` · ${profile.teamName}`:''}</p></div></div>
    <DescriptionList layout="rows" items={[
     {label:'Company email',value:profile.companyEmail&&<><span className="block break-all">{profile.companyEmail}</span><span className="-ml-2.5 mt-1 block"><CopyButton text={profile.companyEmail} label="Copy email" size="sm" variant="ghost"/></span></>,emptyLabel:profile.noSetupRecord?'Not recorded':'None recorded'},
     {label:'Email afterwards',value:request.emailAfter==='FORWARD'?`Forward to ${request.forwardToName??'the manager'}, 30 days`:'Suspend only'},
     {label:'RingCentral number',value:profile.ringCentralNumber,mono:true,emptyLabel:profile.noSetupRecord?'Not recorded':'None recorded'},
     ...(profile.ringCentralExtension?[{label:'Extension',value:profile.ringCentralExtension,mono:true}]:[]),
     ...(profile.datEmail?[{label:'DAT sign-in',value:<SignIn email={profile.datEmail} others={shared.dat}/>}]:[]),...(profile.truckstopEmail?[{label:'Truckstop sign-in',value:<SignIn email={profile.truckstopEmail} others={shared.truckstop}/>}]:[]),
     ...(profile.ringCentralNumber?[{label:'The number',value:outcomeLabel(request.numberOutcome),emptyLabel:'Chosen in the RingCentral task'}]:[]),
     {label:'Set up',value:profile.setUpAt&&<LocalTime iso={profile.setUpAt} format="date"/>,emptyLabel:profile.noSetupRecord?'Before the workspace':'Setup wasn’t finished'}]}/>
   </CardBody></Card>
   <p className="text-xs leading-5 text-muted-foreground">Checklist updates are manual records; they don’t remove accounts for you. Don’t put passwords in notes.</p>
  </div>
 </div>
 {editing&&<Dialog open onClose={()=>setEditing(null)} title={`Update ${editing.label}`} description={scheduled?'Plan ahead. This can be marked completed from their last day.':'Record the outcome of your manual removal work.'} busy={pending==='task'} actions={<Button form="it-removal-editor" type="submit">{pending==='task'?'Saving…':completing?'Finish removal':'Save task'}</Button>}>
 <form id="it-removal-editor" onSubmit={update} className="space-y-4">
  <Select id="removal-status" label="Status" name="status" value={taskStatus} onChange={event=>setTaskStatus(event.target.value as TaskOutcome)} width="sm"
   options={taskOutcomes.filter(status=>(status!=='NOT_NEEDED'||editing.optional)&&(!scheduled||PLANNING.includes(status))).map(status=>({value:status,label:statusLabel(status)}))}/>
  {needsOutcome&&<Select id="removal-number" label="What happens to the number" name="numberOutcome" value={outcome} placeholder="Choose what happens" optional={taskStatus!=='COMPLETED'}
   onChange={event=>setOutcome(event.target.value as NumberOutcome)} width="md" options={NUMBER_OUTCOMES} hint={`${profile.ringCentralNumber}. Needed to mark the task completed.`}/>}
  <Textarea id="removal-notes" label={taskStatus==='BLOCKED'?'Blocked reason':'Notes'} optional={taskStatus!=='BLOCKED'} name="notes" defaultValue={editing.notes} required={taskStatus==='BLOCKED'} maxLength={1000} hint="Visible to IT only. Don’t put passwords in notes."/>
  {completing&&<div className="space-y-3 rounded-md bg-warning-background p-4 text-sm text-warning"><p className="font-semibold">This finishes the removal.</p><p>Every task will be completed or marked not needed. The checklist becomes read-only and the manager who marked them as left receives a portal notification.</p><Checkbox name="confirmCompletion" required label="I confirm their access is removed." className="text-foreground"/></div>}
  <Notice message={taskError} error/><PendingHint pending={pending==='task'}/>
 </form>
 </Dialog>}
 </div>;
}
