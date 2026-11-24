'use client';
import { useRouter } from 'next/navigation';
import { WhoThisIs } from './who';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PageCrumb } from '@/components/shell-context';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checklist, type ChecklistItem } from '@/components/ui/checklist';
import { CopyButton } from '@/components/ui/copy-button';
import { Avatar } from '@/components/ui/avatar';
import { Checkbox, RadioGroup, Select, Textarea } from '@/components/ui/field';
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
import { type ItTask, type NumberOutcome, RINGCENTRAL_OFF, type RemovalDetail, type RingCentralOff, taskDone, taskOutcomes, type TaskOutcome } from './types';
import { actionWord, doneFor, doneWord, EMAIL_DONE_OPTIONS, emailAfterText, emailStepText, type EmailDone } from './email-words';

// Before section 40 IT recorded what happened to the number; an older API still asks for it, and finished removals show it.
const NUMBER_OUTCOMES:{value:NumberOutcome;label:string}[]=[{value:'KEPT',label:'Kept for the next dispatcher'},{value:'FORWARDED',label:'Forwarded to the team'},{value:'RELEASED',label:'Released'}];
// What IT turns off when it disables a RingCentral user (ItRingCentralTaskScreen); completing needs all four.
const outcomeLabel=(value:NumberOutcome|null)=>NUMBER_OUTCOMES.find(option=>option.value===value)?.label;
// Task names in the activity list, written as on the checklist.
const TASK_NAMES:Record<string,string>={GOOGLE_WORKSPACE:'Google Workspace',DISPATCH_GROUP:'Dispatch group',RINGCENTRAL:'RingCentral',BUSINESS_SOFTWARE:'Business software',SHARED_PASSWORDS:'Shared passwords',EQUIPMENT:'Equipment'};
const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
// Only what a scheduled removal can record: nothing is removed yet.
const PLANNING:readonly TaskOutcome[]=['PENDING','IN_PROGRESS','BLOCKED'];

/**
 * An IT removal request (designed as ItRemovalScreen and ItRemovalScheduledScreen): the reverse of setup, opened when a
 * dispatcher's last day is recorded. Before that day IT can plan (notes, in progress) but not complete tasks, unless a
 * manager asked to remove access now. The Google Workspace task records what IT did with the email (the manager chose
 * archive, suspend or delete) and the RingCentral task what was turned off (section 40); finishing the last task tells the
 * manager who recorded it.
 */
export function ItRemoval({initial}:{initial:RemovalDetail}){
 const toast=useToast();
 const router=useRouter();
 const [data,setData]=useState(initial),[pending,setPending]=useState<'refresh'|'task'|null>(null);
 const [editing,setEditing]=useState<ItTask|null>(null),[taskStatus,setTaskStatus]=useState<TaskOutcome>('PENDING'),[outcome,setOutcome]=useState<NumberOutcome|''>(''),[taskError,setTaskError]=useState('');
 const [emailDone,setEmailDone]=useState<EmailDone|''>(''),[turnedOff,setTurnedOff]=useState<RingCentralOff[]>([]);
 const {request,tasks}=data,profile=request.profile,cancelled=!!request.cancelledAt,closed=!!request.completedAt||cancelled,scheduled=request.scheduled&&!cancelled,busy=!!pending;
 const shared=data.sharedSignIns??{dat:[],truckstop:[]},seats=data.seats;
 // With seats, who shares a sign-in comes from them, by account (ItRemovalSeveralAccountsScreen).
 const sharedPeople=seats?[...new Set(seats.flatMap(seat=>seat.sharedWith))]:[...new Set([...shared.dat,...shared.truckstop].map(person=>person.name))];
 const sharedBoards=seats?[...new Set(seats.filter(seat=>seat.sharedWith.length).map(seat=>seat.account))].join(' and '):[...(shared.dat.length?['DAT']:[]),...(shared.truckstop.length?['Truckstop']:[])].join(' and ');
 const completed=tasks.filter(taskDone).length;
 const completing=!!editing&&taskDone({status:taskStatus})&&tasks.filter(task=>task.id!==editing.id).every(taskDone);
 // Section 40: what IT did with the email and what it turned off, unless that account goes to someone staying. An older API
 // sends no emailAction and still asks what happens to the number. Nothing is recorded as done before their last day.
 const current=request.emailAction!==undefined,emailHanded=!!request.handedOver?.email,numberHanded=!!request.handedOver?.number;
 const needsOutcome=!current&&editing?.key==='RINGCENTRAL'&&!!profile.ringCentralNumber;
 const needsEmailDone=current&&!scheduled&&editing?.key==='GOOGLE_WORKSPACE'&&!!profile.companyEmail&&!emailHanded;
 const needsTicks=current&&!scheduled&&editing?.key==='RINGCENTRAL'&&!!profile.ringCentralNumber&&!numberHanded;
 const due=!closed&&!scheduled&&request.dueOn<=today();
 async function refresh(){setPending('refresh');try{setData(await readApi<RemovalDetail>(`it/removals/${request.id}`));toast({title:'Request refreshed'});}catch(error){toast({tone:'danger',title:'Request not refreshed',description:errorMessage(error,'Unable to refresh.')});}finally{setPending(null);}}
 function open(task:ItTask){setEditing(task);setTaskStatus(task.status);setOutcome(request.numberOutcome??'');setEmailDone(request.emailDone??(request.emailAction?doneFor(request.emailAction):''));setTurnedOff(request.ringCentralOff??[]);setTaskError('');}
 async function update(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(!editing||busy)return;
  const notes=String(new FormData(event.currentTarget).get('notes')??'');
  if(taskStatus==='BLOCKED'&&!notes.trim()){setTaskError('Describe what is blocking this task.');return;}
  if(needsOutcome&&taskStatus==='COMPLETED'&&!outcome){setTaskError('Choose what happens to the RingCentral number.');return;}
  if(needsEmailDone&&taskStatus==='COMPLETED'&&!emailDone){setTaskError('Choose what you did with the account.');return;}
  if(needsTicks&&taskStatus==='COMPLETED'&&turnedOff.length<RINGCENTRAL_OFF.length){setTaskError('Tick each one turned off: the user, SMS, and inbound and outbound call recording.');return;}
  setPending('task');setTaskError('');
  try{
   const updated=await mutate<RemovalDetail>(`it/removals/${request.id}/tasks/${editing.key}`,'PATCH',{version:request.version,status:taskStatus,notes,...(needsOutcome&&outcome?{numberOutcome:outcome}:{}),...(needsEmailDone&&emailDone?{emailDone}:{}),...(needsTicks?{ringCentralOff:turnedOff}:{})});
   setData(updated);setEditing(null);
   if(updated.request.completedAt)router.refresh();
   toast(updated.request.completedAt?{title:'Access removed',description:'The manager who marked them as left has been notified.'}:{title:'Checklist task updated'});
  }catch(error){setTaskError(errorMessage(error,'Unable to update. Your entries have been kept.'));}finally{setPending(null);}
 }
 const blocked=tasks.filter(task=>task.status==='BLOCKED');
 // Shared email and number (SharedItRemovalScreen): handed over, keep and change the password; used by others staying, say so.
 const sharing=profile.shared,handOver=sharing?.handOverTo??null,sharedOf=(kind:'EMAIL'|'RINGCENTRAL')=>sharing?.usedBy.find(item=>item.kind===kind);
 const borrowed=(kind:'EMAIL'|'RINGCENTRAL')=>sharing?.uses.find(item=>item.kind===kind&&!item.handedOver);
 const taskText=(task:ItTask)=>{
  const email=sharedOf('EMAIL'),number=sharedOf('RINGCENTRAL'),usedEmail=borrowed('EMAIL'),usedNumber=borrowed('RINGCENTRAL');
  if(task.key==='GOOGLE_WORKSPACE'&&handOver&&email)return `Keep ${email.value} for ${handOver}: change its password, sign it out everywhere and give the new one to ${handOver}. Don’t suspend it.${usedEmail?` ${profile.displayName} also used ${usedEmail.owner??'someone else'}’s email ${usedEmail.value}: change its password.`:''}`;
  if(task.key==='RINGCENTRAL'&&handOver&&number)return `Keep ${number.value} for ${handOver}: remove ${profile.displayName}’s user and give the number to ${handOver}’s.${current?'':' Record the number as Kept.'}`;
  if(task.key==='GOOGLE_WORKSPACE'&&usedEmail&&!profile.companyEmail)return `${profile.displayName} used ${usedEmail.owner??'someone else'}’s email ${usedEmail.value}. Don’t close it: change its password and give the new one to ${usedEmail.owner??'its owner'}.`;
  if(task.key==='RINGCENTRAL'&&usedNumber&&!profile.ringCentralNumber)return `${profile.displayName} used ${usedNumber.owner??'someone else'}’s number ${usedNumber.value}. Remove their access to it; don’t release the number.`;
  if(task.key==='GOOGLE_WORKSPACE'&&request.emailAction&&profile.companyEmail)return emailStepText(profile.companyEmail,request.emailAction,request.emailAfter==='FORWARD',request.forwardToName);
  return task.key==='GOOGLE_WORKSPACE'&&request.emailAfter==='FORWARD'?`${task.description} Forward new email to ${request.forwardToName??'the manager'} for 30 days.`:task.description;
 };
 const toChecklist=(task:ItTask):ChecklistItem=>({id:task.key,title:task.label,optional:task.optional,status:task.status,note:task.notes||undefined,
  description:taskText(task),
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
   {!closed&&!cancelled&&sharedPeople.length>0&&<Alert tone="warning" title="Someone else still uses a sign-in"><p>{sharedPeople.join(' and ')} also {sharedPeople.length===1?'uses':'use'} {profile.displayName}’s {sharedBoards} sign-in{seats&&seats.filter(seat=>seat.sharedWith.length).length>1?'s':''} and {sharedPeople.length===1?'is':'are'} staying. Change its password and tell their manager, rather than closing it.</p></Alert>}
   {sharing&&!closed&&!cancelled&&sharing.usedBy.length>0&&(handOver?<Alert tone="info" title={`Handed over to ${handOver}`}><p>{profile.displayName}’s {sharing.usedBy.map(item=>item.kind==='EMAIL'?'company email':'RingCentral number').join(' and ')} stay open for {handOver}, who uses them now.{sharing.usedBy.some(item=>item.users.some(user=>user!==handOver))?` ${[...new Set(sharing.usedBy.flatMap(item=>item.users).filter(user=>user!==handOver))].join(' and ')} keep using them too.`:''}</p></Alert>
    :<Alert tone="warning" title="Someone else still uses their email or number"><p>{[...new Set(sharing.usedBy.flatMap(item=>item.users))].join(' and ')} also {new Set(sharing.usedBy.flatMap(item=>item.users)).size===1?'uses':'use'} them and {new Set(sharing.usedBy.flatMap(item=>item.users)).size===1?'is':'are'} staying. The manager chose to close them, so they stop working for them too.</p></Alert>)}
   {sharing&&!closed&&!cancelled&&sharing.uses.some(item=>!item.handedOver)&&<Alert tone="warning" title="They used someone else’s email or number"><p>{sharing.uses.filter(item=>!item.handedOver).map(item=>`${item.owner??'Someone else'}’s ${item.kind==='EMAIL'?'company email':'RingCentral number'}`).join(' and ')}. Remove {profile.displayName}’s access and change the password; don’t close {sharing.uses.filter(item=>!item.handedOver).length>1?'them':'it'}.</p></Alert>}
   {profile.suspendedOnLeave&&!closed&&!cancelled&&<Alert tone="info" title="Suspended during leave"><p>{profile.displayName} was on leave, so some accounts may already be suspended. Check them, then remove them.</p></Alert>}
   {request.note&&!closed&&!cancelled&&<Alert tone="info" title={`Note from ${request.managerName??'the manager'}`}><p className="whitespace-pre-wrap">{request.note}</p></Alert>}
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
   <WhoThisIs memberId={request.memberId} name={profile.displayName} photos={data.photos}/>
   <Card><CardHeader title="Accounts to remove"/><CardBody className="space-y-4">
    <div className="flex items-center gap-3"><Avatar name={profile.displayName} size="lg"/>
     <div className="min-w-0"><p className="truncate font-medium">{profile.displayName}</p><p className="text-[13px] text-muted-foreground">{profile.position??'Dispatcher'}{profile.mcName?` · ${profile.mcName}`:''}{profile.teamName?` · ${profile.teamName}`:''}</p></div></div>
    <DescriptionList layout="rows" items={[
     {label:'Company email',value:profile.companyEmail&&<><span className="block break-all">{profile.companyEmail}</span><span className="-ml-2.5 mt-1 block"><CopyButton text={profile.companyEmail} label="Copy email" size="sm" variant="ghost"/></span></>,emptyLabel:profile.noSetupRecord?'Not recorded':'None recorded'},
     ...(profile.companyEmail&&!emailHanded?[{label:request.emailDone?'Email':'Email afterwards',value:current?emailAfterText(request.emailAction,request.emailAfter==='FORWARD',request.forwardToName,request.emailDone):request.emailAfter==='FORWARD'?`Forward to ${request.forwardToName??'the manager'}, 30 days`:'Suspend only'}]:[]),
     {label:'RingCentral number',value:profile.ringCentralNumber,mono:true,emptyLabel:profile.noSetupRecord?'Not recorded':'None recorded'},
     ...(sharing?.uses??[]).map(item=>({label:item.kind==='EMAIL'?'Uses company email':'Uses RingCentral number',value:<><span className="block break-all">{item.value}</span><span className="block text-[13px] text-muted-foreground">{item.handedOver?'Handed over to them':`${item.owner??'Someone else'}’s, shared`}</span></>})),
     ...(sharing?.usedBy??[]).map(item=>({label:item.kind==='EMAIL'?'Email also used by':'Number also used by',value:`${item.users.join(', ')}${handOver?` · handed over to ${handOver}`:''}`})),
     ...(profile.ringCentralExtension?[{label:'Extension',value:profile.ringCentralExtension,mono:true}]:[]),
     ...(!seats&&profile.datEmail?[{label:'DAT sign-in',value:<SignIn email={profile.datEmail} others={shared.dat}/>}]:[]),...(!seats&&profile.truckstopEmail?[{label:'Truckstop sign-in',value:<SignIn email={profile.truckstopEmail} others={shared.truckstop}/>}]:[]),
     ...(profile.ringCentralNumber&&!current?[{label:'The number',value:outcomeLabel(request.numberOutcome),emptyLabel:'Chosen in the RingCentral task'}]:[]),
     ...(profile.ringCentralNumber&&current&&request.numberOutcome?[{label:'The number',value:outcomeLabel(request.numberOutcome)}]:[]),
     ...(profile.ringCentralNumber&&current&&!numberHanded&&!request.numberOutcome?[{label:'RingCentral afterwards',value:(request.ringCentralOff?.length??0)>=RINGCENTRAL_OFF.length?'User disabled · SMS and call recording off':'Disable the user · SMS and call recording off'}]:[]),
     {label:'Set up',value:profile.setUpAt&&<LocalTime iso={profile.setUpAt} format="date"/>,emptyLabel:profile.noSetupRecord?'Before the workspace':'Setup wasn’t finished'}]}/>
   </CardBody></Card>
   {!!profile.companyAccounts?.length&&<Card><CardHeader title="Accounts at other companies" description="Remove each as well. A kept email still signs in to a load board seat below."/><CardBody>
    <ul className="divide-y divide-border">{profile.companyAccounts.map(account=><li key={account.id} className="grid gap-1 py-3 first:pt-0 last:pb-0">
     <span className="font-medium">{account.company}{account.nameUsed?<span className="font-normal text-muted-foreground"> · as {account.nameUsed}</span>:null}</span>
     <DescriptionList layout="rows" stacked items={[...(account.companyEmail?[{label:'Company email',value:<span className="break-all">{account.companyEmail}</span>}]:[]),...(account.ringCentralNumber?[{label:'RingCentral number',value:account.ringCentralNumber,mono:true}]:[]),...(account.ringCentralExtension?[{label:'Extension',value:account.ringCentralExtension,mono:true}]:[])]}/>
     {account.keptFor.length>0&&<span className="text-[13px] text-muted-foreground">Signs in to {account.keptFor.join(' and ')}</span>}</li>)}</ul>
   </CardBody></Card>}
   {seats&&seats.length>0&&<Card><CardHeader title="Load board seats" description="End each, or change its password when someone else shares the sign-in."/><CardBody>
    <DescriptionList layout="rows" items={seats.map(seat=>({label:seat.account,value:<><span className="block break-all">{seat.signInEmail}</span>{seat.sharedWith.length>0&&<span className="block text-[13px] text-muted-foreground">Also used by {seat.sharedWith.join(', ')}</span>}{seat.status==='SUSPENDED'&&<span className="block text-[13px] text-muted-foreground">Suspended</span>}</>}))}/>
   </CardBody></Card>}
   <p className="text-xs leading-5 text-muted-foreground">Checklist updates are manual records; they don’t remove accounts for you. Don’t put passwords in notes.</p>
  </div>
 </div>
 {editing&&<Dialog open onClose={()=>setEditing(null)} title={`Update ${editing.label}`} description={scheduled?'Plan ahead. This can be marked completed from their last day.':'Record the outcome of your manual removal work.'} busy={pending==='task'} actions={<Button form="it-removal-editor" type="submit">{pending==='task'?'Saving…':completing?'Finish removal':'Save task'}</Button>}>
 <form id="it-removal-editor" onSubmit={update} className="space-y-4">
  <Select id="removal-status" label="Status" name="status" value={taskStatus} onChange={event=>setTaskStatus(event.target.value as TaskOutcome)} width="sm"
   options={taskOutcomes.filter(status=>(status!=='NOT_NEEDED'||editing.optional)&&(!scheduled||PLANNING.includes(status))).map(status=>({value:status,label:statusLabel(status)}))}/>
  {needsEmailDone&&request.emailAction&&<>
   <p className="rounded-md border border-border bg-muted px-4 py-3 text-[13px] leading-5"><span className="font-semibold">{recordedBy??'The manager'} chose {actionWord(request.emailAction)}</span>{request.emailAfter==='FORWARD'?', and to get new email for 30 days.':'.'}</p>
   <RadioGroup name="emailDone" label="What you did with the account" value={emailDone} onChange={value=>setEmailDone(value as EmailDone)} options={EMAIL_DONE_OPTIONS} hint={`Starts at what the manager chose. Needed to mark the task completed.${request.emailDone?` Recorded so far: ${doneWord(request.emailDone)}.`:''}`}/>
  </>}
  {needsTicks&&<fieldset className="grid gap-2"><legend className="mb-1 text-sm font-medium">Turned off</legend>
   {RINGCENTRAL_OFF.map(item=><Checkbox key={item.value} name="ringCentralOff" value={item.value} label={item.label} checked={turnedOff.includes(item.value)} onChange={event=>setTurnedOff(list=>event.target.checked?[...list,item.value]:list.filter(value=>value!==item.value))}/>)}
   <p className="text-[13px] leading-5 text-muted-foreground">Completed needs all four ticked. Something that was never on counts as off.</p></fieldset>}
  {needsOutcome&&<Select id="removal-number" label="What happens to the number" name="numberOutcome" value={outcome} placeholder="Choose what happens" optional={taskStatus!=='COMPLETED'}
   onChange={event=>setOutcome(event.target.value as NumberOutcome)} width="md" options={NUMBER_OUTCOMES} hint={`${profile.ringCentralNumber}. Needed to mark the task completed.`}/>}
  <Textarea id="removal-notes" label={taskStatus==='BLOCKED'?'Blocked reason':'Notes'} optional={taskStatus!=='BLOCKED'} name="notes" defaultValue={editing.notes} required={taskStatus==='BLOCKED'} maxLength={1000} hint="Visible to IT only. Don’t put passwords in notes."/>
  {completing&&<div className="space-y-3 rounded-md bg-warning-background p-4 text-sm text-warning"><p className="font-semibold">This finishes the removal.</p><p>Every task will be completed or marked not needed. The checklist becomes read-only and the manager who marked them as left receives a portal notification.</p><Checkbox name="confirmCompletion" required label="I confirm their access is removed." className="text-foreground"/></div>}
  <Notice message={taskError} error/><PendingHint pending={pending==='task'}/>
 </form>
 </Dialog>}
 </div>;
}
