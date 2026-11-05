'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageCrumb } from '@/components/shell-context';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checklist, type ChecklistItem } from '@/components/ui/checklist';
import { CopyButton } from '@/components/ui/copy-button';
import { Avatar } from '@/components/ui/avatar';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/field';
import { Progress } from '@/components/ui/feedback';
import { DescriptionList } from '@/components/ui/description-list';
import { Timeline } from '@/components/ui/timeline';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { PrivateImage } from '@/components/ui/private-image';
import { Badge, StatusBadge, statusLabel } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { readApi } from '@/features/onboarding/types';
import { ItDetail, ItTask, taskDone, taskOutcomes, TaskOutcome } from './types';
const RINGCENTRAL=['RINGCENTRAL','SMS','CALL_RECORDING'];
// Task names in the activity list, written as on the checklist (not the key in sentence case: SMS, not Sms).
const TASK_NAMES:Record<string,string>={GOOGLE_WORKSPACE:'Google Workspace',DISPATCH_GROUP:'Dispatch group',RINGCENTRAL:'RingCentral',SMS:'SMS',CALL_RECORDING:'Call recording',BUSINESS_SOFTWARE:'Business software',EQUIPMENT:'Equipment'};
// The account a task creates: recorded first in that task's dialog, before its status can change.
const ACCOUNTS:Record<string,{label:string;prompt:string;type:'email'|'tel';max:number;placeholder:string;hint?:string}>={
 GOOGLE_WORKSPACE:{label:'Company email',prompt:'company email',type:'email',max:254,placeholder:'name@ugemconsulting.com'},
 RINGCENTRAL:{label:'Assigned RingCentral number',prompt:'RingCentral number',type:'tel',max:40,placeholder:'+1 202 555 0190',hint:'Include the country code, such as +1 202 555 0190.'}};
// Only completing the task needs its account; IT can start it, or record what blocks it (often the account itself), before.
const WITHOUT_ACCOUNT:readonly TaskOutcome[]=['PENDING','IN_PROGRESS','BLOCKED'];
/**
 * An IT request: the setup checklist with progress and the profile in a side rail. The Google Workspace and RingCentral
 * dialogs ask for the company email or number first; the status can change once it is filled in.
 */
export function ItOnboarding({initial}:{initial:ItDetail}){
 const toast=useToast();
 const router=useRouter();
 const [data,setData]=useState(initial),[pending,setPending]=useState<'refresh'|'task'|null>(null);
 const [editing,setEditing]=useState<ItTask|null>(null),[taskStatus,setTaskStatus]=useState<TaskOutcome>('PENDING'),[taskError,setTaskError]=useState('');
 const [account,setAccount]=useState(''),[verified,setVerified]=useState(false),[extension,setExtension]=useState(''),[dat,setDat]=useState(''),[truckstop,setTruckstop]=useState('');
 // A setup cancelled because the dispatcher left is read-only too; their removal checklist takes over.
 const {request,tasks}=data,profile=request.profile,cancelled=!!request.cancelledAt,closed=!!request.completedAt||cancelled,busy=!!pending;
 const completed=tasks.filter(taskDone).length;
 const completing=!!editing&&taskDone({status:taskStatus})&&tasks.filter(task=>task.id!==editing.id).every(taskDone);
 const field=editing?ACCOUNTS[editing.key]:undefined;
 // An account task without its account offers only the statuses that don't need it (and keeps the one it has).
 const locked=!!field&&!account.trim(),allowed=(status:TaskOutcome)=>WITHOUT_ACCOUNT.includes(status)||status===editing?.status;
 const recorded=(key:string)=>key==='GOOGLE_WORKSPACE'?request.companyEmail??'':key==='RINGCENTRAL'?request.assignedRingCentralPhoneNumber??'':'';
 const legacyPhone=!!profile.workPhoneNumber?.trim();
 async function refresh(){setPending('refresh');try{setData(await readApi<ItDetail>(`it/onboarding/${request.id}`));toast({title:'Request refreshed'});}catch(error){toast({tone:'danger',title:'Request not refreshed',description:errorMessage(error,'Unable to refresh.')});}finally{setPending(null);}}
 function open(task:ItTask){setEditing(task);setTaskStatus(task.status);setTaskError('');setAccount(recorded(task.key));setVerified(!!request.workPhoneVerifiedAt);setExtension(request.ringCentralExtension??'');setDat(request.datEmail??'');setTruckstop(request.truckstopEmail??'');}
 async function update(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(!editing||busy)return;
  const values=new FormData(event.currentTarget),notes=String(values.get('notes')??'');
  if(field&&locked&&(!allowed(taskStatus)||recorded(editing.key))){setTaskError(`Enter the ${field.prompt} first.`);return;}
  if(taskStatus==='BLOCKED'&&!notes.trim()){setTaskError('Describe what is blocking this task.');return;}
  setPending('task');setTaskError('');
  try{
   // The account is saved first (its own versioned change), then the task with the version it returns.
   let version=request.version;
   const accountChanged=!!field&&(account.trim()!==recorded(editing.key)||(editing.key==='RINGCENTRAL'&&legacyPhone&&verified!==!!request.workPhoneVerifiedAt));
   // Sent only when changed and only with these tasks, and never needed to finish setup.
   const extras={...(editing.key==='RINGCENTRAL'&&extension.trim()!==(request.ringCentralExtension??'')?{ringCentralExtension:extension.trim()}:{}),
    ...(editing.key==='BUSINESS_SOFTWARE'&&dat.trim().toLowerCase()!==(request.datEmail??'')?{datEmail:dat.trim()}:{}),...(editing.key==='BUSINESS_SOFTWARE'&&truckstop.trim().toLowerCase()!==(request.truckstopEmail??'')?{truckstopEmail:truckstop.trim()}:{})};
   const extrasChanged=Object.keys(extras).length>0;
   if(accountChanged||extrasChanged){
    const saved=await mutate<ItDetail>(`it/onboarding/${request.id}/contact`,'PATCH',{version,workPhoneVerified:editing.key==='RINGCENTRAL'?verified:!!request.workPhoneVerifiedAt,
     ...(!accountChanged?{}:editing.key==='GOOGLE_WORKSPACE'?{companyEmail:account.trim()}:{assignedRingCentralPhoneNumber:account.trim()}),...extras});
    setData(saved);version=saved.request.version;
   }
   const updated=taskStatus===editing.status&&notes===editing.notes&&(accountChanged||extrasChanged)?null:await mutate<ItDetail>(`it/onboarding/${request.id}/tasks/${editing.key}`,'PATCH',{version,status:taskStatus,notes});
   if(updated)setData(updated);setEditing(null);
   // Finishing changes the IT tasks count in the sidebar, which comes from the server layout.
   if(updated?.request.completedAt)router.refresh();
   toast(updated?.request.completedAt?{title:'Onboarding completed',description:'The responsible manager has been notified.'}:{title:accountChanged&&!updated?`${field!.label} saved`:'Checklist task updated'});
  }catch(error){setTaskError(errorMessage(error,'Unable to update. Your entries have been kept.'));}finally{setPending(null);}
 }
 const name=profile.proposedDisplayName??'Approved dispatcher';
 const blocked=tasks.filter(task=>task.status==='BLOCKED');
 const created=data.activity.find(event=>event.event==='IT_REQUEST_CREATED')?.createdAt??data.activity[0]?.createdAt;
 const toChecklist=(task:ItTask):ChecklistItem=>({id:task.key,title:task.label,optional:task.optional,description:task.description,status:task.status,note:task.notes||undefined,
  meta:task.status!=='PENDING'&&<>Updated <LocalTime iso={task.updatedAt}/></>,
  action:!closed&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>open(task)}>Update<span className="sr-only">: {task.label}</span></Button>});
 // RingCentral, SMS and call recording are one group, shown where the first of them falls in the checklist.
 const grouped=tasks.filter(task=>RINGCENTRAL.includes(task.key)),firstGrouped=tasks.findIndex(task=>RINGCENTRAL.includes(task.key));
 const sections=tasks.flatMap((task,index):{heading?:string;items:ItTask[]}[]=>index===firstGrouped?[{heading:'RingCentral',items:grouped}]:RINGCENTRAL.includes(task.key)?[]:[{heading:undefined,items:[task]}]);
 const activityTone=(event:ItDetail['activity'][number])=>event.event==='IT_ONBOARDING_COMPLETED'||event.metadata.newStatus==='COMPLETED'?'success' as const:event.metadata.newStatus==='BLOCKED'?'warning' as const:'neutral' as const;
 return <div className="space-y-6">
 <PageCrumb label={name}/>
 <PageHeader title={name} badge={cancelled?<Badge label="Cancelled" tone="neutral"/>:<StatusBadge status={closed?'COMPLETED':request.status}/>}
  meta={[created&&<>Request created <LocalTime iso={created} format="date"/></>,`${profile.mcName} · ${profile.teamLead} · ${profile.jobTitle}`].filter(Boolean)}
  action={!closed&&<Button variant="outline" disabled={busy} onClick={()=>void refresh()}><RefreshCw aria-hidden="true" className="size-4"/>{pending==='refresh'?'Refreshing…':'Refresh'}</Button>}/>
 <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
  <div className="min-w-0 space-y-6">
   {cancelled?<Alert tone="info" title="Setup cancelled"><p>The dispatcher left on <LocalTime iso={request.cancelledAt} format="date"/> before setup finished. Remove anything already created on their removal checklist in <Link href="/it/tasks?view=removal" className="text-primary underline-offset-4 hover:underline">IT tasks</Link>.</p></Alert>
    :closed?<Alert tone="success" title="Setup complete"><p>Finished <LocalTime iso={request.completedAt}/>. The manager was notified and this checklist is read-only.</p></Alert>
    :blocked.length>0&&<Alert tone="warning" title={blocked.length===1?'1 task is blocked':`${blocked.length} tasks are blocked`}><ul className="space-y-1">{blocked.map(task=><li key={task.key}><span className="font-medium">{task.label}:</span> {task.notes}</li>)}</ul></Alert>}
   <Card>
    <CardHeader title="Setup checklist" description={closed?'Every task is finished.':'Finishing the last task completes setup and lets the manager know.'}
     actions={<Progress className="w-44" label="Progress" value={completed} max={tasks.length}/>}/>
    <div className="mt-3 border-t border-border">{sections.map((section,index)=><Checklist key={section.items[0].key} className={index>0?'border-t border-border':undefined} heading={section.heading} titleAs={section.heading?'h4':'h3'} items={section.items.map(toChecklist)}/>)}</div>
   </Card>
   <Card><CardHeader title="Activity"/><CardBody><Timeline items={[...data.activity].reverse().map(event=>({id:event.id,tone:activityTone(event),title:`${statusLabel(event.event)}${event.metadata.key?` · ${TASK_NAMES[String(event.metadata.key)]??statusLabel(String(event.metadata.key))}`:''}`,meta:<LocalTime iso={event.createdAt}/>}))}/></CardBody></Card>
  </div>
  <div className="min-w-0 space-y-6 xl:sticky xl:top-20 xl:-mx-1 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:overscroll-contain xl:px-1 xl:pb-1">
   <Card><CardHeader title="Profile"/><CardBody className="space-y-4">
    <div className="flex items-center gap-3">{request.profilePhoto?<PrivateImage src={`/api/backend/it/onboarding/${request.id}/photo`} alt="Profile photo" className="size-14 shrink-0 rounded-full border object-cover"/>:<Avatar name={name} size="lg"/>}
     <div className="min-w-0"><p className="truncate font-medium">{name}</p><p className="text-[13px] text-muted-foreground">Proposed display name</p></div></div>
    <DescriptionList layout="rows" items={[
     {label:'Legal name',value:[profile.legalFirstName,profile.legalLastName].filter(Boolean).join(' ')},
     {label:'Personal email',value:profile.personalEmail&&<><span className="block break-all">{profile.personalEmail}</span><span className="-ml-2.5 mt-1 block"><CopyButton text={profile.personalEmail} label="Copy email" size="sm" variant="ghost"/></span></>},
     {label:'Personal phone',value:profile.personalPhoneNumber,mono:true},
     {label:'MC / Independent',value:profile.mcName},{label:'Team lead',value:profile.teamLead},{label:'Job title',value:profile.jobTitle},
     // Recorded in the Google Workspace and RingCentral tasks; the manager sees these on the employee details.
     {label:'Company email',value:request.companyEmail,emptyLabel:'Set in the Google Workspace task'},
     {label:'RingCentral number',value:request.assignedRingCentralPhoneNumber,mono:true,emptyLabel:'Set in the RingCentral task'},
     ...(request.ringCentralExtension?[{label:'Extension',value:request.ringCentralExtension,mono:true}]:[]),
     ...(request.datEmail?[{label:'DAT sign-in',value:<span className="break-all">{request.datEmail}</span>}]:[]),...(request.truckstopEmail?[{label:'Truckstop sign-in',value:<span className="break-all">{request.truckstopEmail}</span>}]:[]),
     ...(legacyPhone?[{label:'Older application work phone',value:<span className="flex flex-wrap items-center gap-2"><span className="font-mono text-[13px]">{profile.workPhoneNumber}</span><Badge label={request.workPhoneVerifiedAt?'Verified by IT':'Applicant provided'} tone={request.workPhoneVerifiedAt?'success':'neutral'}/></span>}]:[])]}/>
   </CardBody></Card>
   <p className="text-xs leading-5 text-muted-foreground">Checklist updates are manual records; they don’t create accounts or send messages. Don’t put passwords in notes.</p>
  </div>
 </div>
 {editing&&<Dialog open onClose={()=>setEditing(null)} title={`Update ${editing.label}`} description="Record the outcome of your manual setup work." busy={pending==='task'} actions={<Button form="it-task-editor" type="submit">{pending==='task'?'Saving…':completing?'Complete onboarding':'Save task'}</Button>}>
 <form id="it-task-editor" onSubmit={update} className="space-y-4">
 {field&&<Input label={field.label} name="account" type={field.type} required={!allowed(taskStatus)||!!recorded(editing.key)} optional={allowed(taskStatus)&&!recorded(editing.key)} maxLength={field.max} value={account}
  onChange={event=>{setAccount(event.target.value);if(!event.target.value.trim()&&!allowed(taskStatus))setTaskStatus(allowed(editing.status)?editing.status:'IN_PROGRESS');}}
  placeholder={field.placeholder} autoComplete="off" width="md" hint={field.hint??'The manager sees it on the employee details.'}/>}
 {editing.key==='RINGCENTRAL'&&<Input label="Extension" optional name="extension" inputMode="numeric" pattern="[0-9]{1,6}" maxLength={6} value={extension} onChange={event=>setExtension(event.target.value)} autoComplete="off" width="sm" hint="Digits only."/>}
 {editing.key==='RINGCENTRAL'&&legacyPhone&&<Checkbox name="verified" checked={verified} onChange={event=>setVerified(event.target.checked)} label={`I verified the older application work phone (${profile.workPhoneNumber}).`}/>}
 <Select label="Status" name="status" value={taskStatus} hint={field&&locked?`Enter the ${field.prompt} to mark it completed.`:undefined} onChange={event=>setTaskStatus(event.target.value as TaskOutcome)} width="sm"
  options={taskOutcomes.filter(status=>(status!=='NOT_NEEDED'||editing.optional)&&(!locked||allowed(status))).map(status=>({value:status,label:statusLabel(status)}))}/>
 {editing.key==='BUSINESS_SOFTWARE'&&<><div className="grid gap-4 sm:grid-cols-2"><Input label="DAT sign-in email" optional name="dat" type="email" maxLength={254} value={dat} onChange={event=>setDat(event.target.value)} autoComplete="off" width="full"/><Input label="Truckstop sign-in email" optional name="truckstop" type="email" maxLength={254} value={truckstop} onChange={event=>setTruckstop(event.target.value)} autoComplete="off" width="full"/></div>
  <p className="text-[13px] leading-5 text-muted-foreground">The email only. Never a password, here or in notes.</p></>}
 <Textarea label={taskStatus==='BLOCKED'?'Blocked reason':'Notes'} optional={taskStatus!=='BLOCKED'} name="notes" defaultValue={editing.notes} required={taskStatus==='BLOCKED'} maxLength={1000} hint="Visible to IT only. Don’t put passwords in notes."/>
 {completing&&<div className="space-y-3 rounded-md bg-warning-background p-4 text-sm text-warning"><p className="font-semibold">This completes onboarding.</p><p>Every task will be completed or marked not needed. The checklist becomes read-only and the manager is notified. It needs the company email and RingCentral number recorded in their tasks.</p><Checkbox name="confirmCompletion" required label="I confirm setup is complete." className="text-foreground"/></div>}
 <Notice message={taskError} error/><PendingHint pending={pending==='task'}/>{taskError&&<p className="text-sm text-muted-foreground">If someone else updated this request, close this dialog and refresh its status before trying again.</p>}</form>
 </Dialog>}

 </div>;
}
