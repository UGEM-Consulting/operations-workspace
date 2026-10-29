'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PageCrumb, useLeaveGuard } from '@/components/shell-context';
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
/** An IT request: the setup checklist with progress, and the profile and company accounts in a side rail. */
export function ItOnboarding({initial}:{initial:ItDetail}){
 const router=useRouter();
 const toast=useToast();
 const [data,setData]=useState(initial),[pending,setPending]=useState<'refresh'|'contact'|'task'|null>(null);
 const [editing,setEditing]=useState<ItTask|null>(null),[taskStatus,setTaskStatus]=useState<TaskOutcome>('PENDING'),[taskError,setTaskError]=useState('');
 const [assigned,setAssigned]=useState(initial.request.assignedRingCentralPhoneNumber??''),[verified,setVerified]=useState(!!initial.request.workPhoneVerifiedAt);
 const [companyEmail,setCompanyEmail]=useState(initial.request.companyEmail??'');
 const [discard,setDiscard]=useState<'refresh'|{leave:string}|null>(null);
 const {request,tasks}=data,profile=request.profile,closed=!!request.completedAt,busy=!!pending;
 const contactDirty=assigned!==(request.assignedRingCentralPhoneNumber??'')||companyEmail.trim().toLowerCase()!==(request.companyEmail??'')||verified!==!!request.workPhoneVerifiedAt;
 const completed=tasks.filter(taskDone).length;
 const completing=!!editing&&taskDone({status:taskStatus})&&tasks.filter(task=>task.id!==editing.id).every(taskDone);
 // Breadcrumb, sidebar and notification links ask before discarding unsaved company accounts.
 useLeaveGuard(useCallback((href:string)=>{if(!contactDirty&&!busy)return true;if(!busy)setDiscard({leave:href});return false;},[contactDirty,busy]));
 useEffect(()=>{if(!contactDirty)return;const warn=(event:BeforeUnloadEvent)=>event.preventDefault();window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[contactDirty]);
 function applyContact(updated:ItDetail){setData(updated);setAssigned(updated.request.assignedRingCentralPhoneNumber??'');setCompanyEmail(updated.request.companyEmail??'');setVerified(!!updated.request.workPhoneVerifiedAt);}
 async function refresh(){setDiscard(null);setPending('refresh');try{applyContact(await readApi<ItDetail>(`it/onboarding/${request.id}`));toast({title:'Request refreshed'});}catch(error){toast({tone:'danger',title:'Request not refreshed',description:errorMessage(error,'Unable to refresh. Your entries have been kept.')});}finally{setPending(null);}}
 async function contact(event:React.FormEvent<HTMLFormElement>){event.preventDefault();if(busy)return;setPending('contact');try{applyContact(await mutate<ItDetail>(`it/onboarding/${request.id}/contact`,'PATCH',{version:request.version,workPhoneVerified:verified,assignedRingCentralPhoneNumber:assigned,companyEmail}));toast({title:'Company accounts saved'});}catch(error){toast({tone:'danger',title:'Company accounts not saved',description:errorMessage(error,'Unable to save. Your entries have been kept.')});}finally{setPending(null);}}
 function open(task:ItTask){setEditing(task);setTaskStatus(task.status);setTaskError('');}
 async function update(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(!editing||busy)return;
  const values=new FormData(event.currentTarget),notes=String(values.get('notes')??'');
  if(taskStatus==='BLOCKED'&&!notes.trim()){setTaskError('Describe what is blocking this task.');return;}
  if(completing&&contactDirty){setTaskError('Save your company account changes before completing onboarding.');return;}
  setPending('task');setTaskError('');
  try{const updated=await mutate<ItDetail>(`it/onboarding/${request.id}/tasks/${editing.key}`,'PATCH',{version:request.version,status:taskStatus,notes});
   // Task updates must never overwrite unsaved contact fields.
   setData(updated);setEditing(null);toast(updated.request.completedAt?{title:'Onboarding completed',description:'The responsible manager has a new portal notification.'}:{title:'Checklist task updated'});
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
 <PageHeader title={name} badge={<StatusBadge status={closed?'COMPLETED':request.status}/>}
  meta={[created&&<>Request created <LocalTime iso={created} format="date"/></>,`${profile.mcName} · ${profile.teamLead} · ${profile.jobTitle}`].filter(Boolean)}
  action={!closed&&<Button variant="outline" disabled={busy} onClick={()=>contactDirty?setDiscard('refresh'):void refresh()}><RefreshCw aria-hidden="true" className="size-4"/>{pending==='refresh'?'Refreshing…':'Refresh'}</Button>}/>
 <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
  <div className="min-w-0 space-y-6">
   {closed?<Alert tone="success" title="Setup complete"><p>Finished <LocalTime iso={request.completedAt}/>. The manager was notified and this checklist is read-only.</p></Alert>
    :blocked.length>0&&<Alert tone="warning" title={blocked.length===1?'1 task is blocked':`${blocked.length} tasks are blocked`}><ul className="space-y-1">{blocked.map(task=><li key={task.key}><span className="font-medium">{task.label}:</span> {task.notes}</li>)}</ul></Alert>}
   <Card>
    <CardHeader title="Setup checklist" description={closed?'Every task is finished.':'Finishing the last task completes setup and lets the manager know.'}
     actions={<Progress className="w-44" label="Progress" value={completed} max={tasks.length}/>}/>
    <div className="mt-3 border-t border-border">{sections.map((section,index)=><Checklist key={section.items[0].key} className={index>0?'border-t border-border':undefined} heading={section.heading} titleAs={section.heading?'h4':'h3'} items={section.items.map(toChecklist)}/>)}</div>
   </Card>
   <Card><CardHeader title="Activity"/><CardBody><Timeline items={[...data.activity].reverse().map(event=>({id:event.id,tone:activityTone(event),title:`${statusLabel(event.event)}${event.metadata.key?` · ${statusLabel(String(event.metadata.key))}`:''}`,meta:<LocalTime iso={event.createdAt}/>}))}/></CardBody></Card>
  </div>
  <div className="min-w-0 space-y-6 xl:sticky xl:top-20">
   <Card><CardHeader title="Profile"/><CardBody className="space-y-4">
    <div className="flex items-center gap-3">{request.profilePhoto?<PrivateImage src={`/api/backend/it/onboarding/${request.id}/photo`} alt="Profile photo" className="size-14 shrink-0 rounded-full border object-cover"/>:<Avatar name={name} size="lg"/>}
     <div className="min-w-0"><p className="truncate font-medium">{name}</p><p className="text-[13px] text-muted-foreground">Proposed display name</p></div></div>
    <DescriptionList layout="rows" items={[
     {label:'Legal name',value:[profile.legalFirstName,profile.legalLastName].filter(Boolean).join(' ')},
     {label:'Personal email',value:profile.personalEmail&&<><span className="block break-all">{profile.personalEmail}</span><span className="-ml-2.5 mt-1 block"><CopyButton text={profile.personalEmail} label="Copy email" size="sm" variant="ghost"/></span></>},
     {label:'Personal phone',value:profile.personalPhoneNumber,mono:true},
     {label:'MC / Independent',value:profile.mcName},{label:'Team lead',value:profile.teamLead},{label:'Job title',value:profile.jobTitle}]}/>
   </CardBody></Card>
   <Card><CardHeader title="Company accounts" description={closed?'The manager sees these on the employee details.':'Both are needed to finish setup. The manager will see these.'}/><CardBody>
    {closed?<DescriptionList layout="rows" items={[{label:'Company email',value:request.companyEmail},{label:'Work phone (RingCentral)',value:request.assignedRingCentralPhoneNumber,mono:true}]}/>
    :<form onSubmit={contact}><fieldset disabled={busy} className="space-y-4">
     <Input label="Company email" name="companyEmail" type="email" maxLength={254} value={companyEmail} onChange={event=>setCompanyEmail(event.target.value)} placeholder="name@ugemconsulting.com" autoComplete="off" width="full"/>
     <Input label="RingCentral number" name="assigned" type="tel" maxLength={40} value={assigned} onChange={event=>setAssigned(event.target.value)} placeholder="+1 202 555 0190" hint="Include the country code, e.g. +1 202 555 0190." width="full"/>
     {!!profile.workPhoneNumber?.trim()&&<div className="space-y-2 rounded-md bg-muted px-3 py-2.5 text-sm"><p className="flex flex-wrap items-center gap-2">Older application work phone: <span className="font-mono text-[13px]">{profile.workPhoneNumber}</span><Badge label={request.workPhoneVerifiedAt?'Verified by IT':'Applicant provided'} tone={request.workPhoneVerifiedAt?'success':'neutral'}/></p>
      <Checkbox name="verified" checked={verified} onChange={event=>setVerified(event.target.checked)} label="I verified this work phone number."/></div>}
     <Button className="w-full">{pending==='contact'?'Saving…':'Save company accounts'}</Button>
     {contactDirty&&<p role="status" className="text-center text-sm text-warning">Unsaved changes</p>}
     <PendingHint pending={pending==='contact'||pending==='refresh'}/>
    </fieldset></form>}
   </CardBody></Card>
   <p className="text-xs leading-5 text-muted-foreground">Checklist updates are manual records; they do not create accounts or send messages. Never enter passwords or tokens in notes.</p>
  </div>
 </div>
 {editing&&<Dialog open onClose={()=>setEditing(null)} title={`Update ${editing.label}`} description="Record the outcome of your manual setup work." busy={pending==='task'} actions={<Button form="it-task-editor" type="submit">{pending==='task'?'Saving…':completing?'Complete onboarding':'Save task'}</Button>}>
 <form id="it-task-editor" onSubmit={update} className="space-y-4"><Select label="Status" name="status" value={taskStatus} onChange={event=>setTaskStatus(event.target.value as TaskOutcome)} width="sm" options={taskOutcomes.filter(status=>status!=='NOT_NEEDED'||editing.optional).map(status=>({value:status,label:statusLabel(status)}))}/><Textarea label={taskStatus==='BLOCKED'?'Blocked reason':'Notes'} optional={taskStatus!=='BLOCKED'} name="notes" defaultValue={editing.notes} required={taskStatus==='BLOCKED'} maxLength={1000} hint="Visible to IT only. Never include passwords or tokens."/>
 {completing&&<div className="space-y-3 rounded-md bg-warning-background p-4 text-sm text-warning"><p className="font-semibold">This completes onboarding.</p><p>Every task will be completed or marked not needed. The checklist becomes read-only and the manager receives a portal notification. Save the company email and assigned RingCentral number first.</p>{contactDirty&&<p>Close this dialog and save your unsaved company account changes before continuing.</p>}<Checkbox name="confirmCompletion" required label="I confirm setup is complete." className="text-foreground"/></div>}
 <Notice message={taskError} error/><PendingHint pending={pending==='task'}/>{taskError&&<p className="text-sm text-muted-foreground">If someone else updated this request, close this dialog and refresh its status before trying again.</p>}</form>
 </Dialog>}
 {discard&&<Dialog open size="sm" tone="warning" title="Discard unsaved company account changes?" description="The company email, RingCentral number or verification changes on this page have not been saved." onClose={()=>setDiscard(null)} protectChanges={false} closeLabel="Keep editing" actions={<Button variant="destructive" onClick={()=>{if(discard==='refresh')void refresh();else{const href=discard.leave;setDiscard(null);applyContact(data);router.push(href);}}}>{discard==='refresh'?'Discard and refresh':'Discard and leave'}</Button>}><p className="text-sm">Save your contact changes first if you want to keep them.</p></Dialog>}
 </div>;
}
