'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
export function ItOnboarding({initial}:{initial:ItDetail}){
 const router=useRouter();
 const toast=useToast();
 const [data,setData]=useState(initial),[pending,setPending]=useState<'refresh'|'contact'|'task'|null>(null);
 const [editing,setEditing]=useState<ItTask|null>(null),[taskStatus,setTaskStatus]=useState<TaskOutcome>('PENDING'),[taskError,setTaskError]=useState('');
 const [assigned,setAssigned]=useState(initial.request.assignedRingCentralPhoneNumber??''),[verified,setVerified]=useState(!!initial.request.workPhoneVerifiedAt);
 const [companyEmail,setCompanyEmail]=useState(initial.request.companyEmail??'');
 const [discard,setDiscard]=useState<'refresh'|'leave'|null>(null);
 const {request,tasks}=data,profile=request.profile,closed=!!request.completedAt,busy=!!pending;
 const contactDirty=assigned!==(request.assignedRingCentralPhoneNumber??'')||companyEmail.trim().toLowerCase()!==(request.companyEmail??'')||verified!==!!request.workPhoneVerifiedAt;
 const completed=tasks.filter(taskDone).length;
 const completing=!!editing&&taskDone({status:taskStatus})&&tasks.filter(task=>task.id!==editing.id).every(taskDone);
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
 // Tasks inside the RingCentral group sit one heading level below it.
 const renderTask=(task:ItTask,Heading:'h3'|'h4'='h3')=><Card key={task.key} className="space-y-3 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><Heading className="font-semibold">{task.label}{task.optional&&<span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span>}</Heading><StatusBadge status={task.status}/></div><p className="text-sm text-muted-foreground">{task.description}</p>{task.notes&&<p className={`whitespace-pre-wrap break-words rounded-md p-3 text-sm ${task.status==='BLOCKED'?'bg-warning-background text-warning':'bg-muted'}`}>{task.status==='BLOCKED'&&<strong>Blocked: </strong>}{task.notes}</p>}{!closed&&<Button variant="outline" disabled={busy} onClick={()=>open(task)}>Update task<span className="sr-only">: {task.label}</span></Button>}</Card>;
 const fields=[['First name',profile.legalFirstName],['Last name',profile.legalLastName],['American first name',profile.preferredAmericanFirstName],['American last name',profile.preferredAmericanLastName],['Personal email',profile.personalEmail],['Personal phone number',profile.personalPhoneNumber],['MC / Independent',profile.mcName],['Team lead / Independent',profile.teamLead],['Job title',profile.jobTitle],['Company email',request.companyEmail],['Work phone (RingCentral)',request.assignedRingCentralPhoneNumber]];
 return <div className="space-y-6">
 <Link href="/it/tasks" onClick={event=>{if(contactDirty||busy){event.preventDefault();if(!busy)setDiscard('leave');}}} className="inline-flex min-h-11 items-center text-sm text-primary underline">Back to IT onboarding</Link>
 <PageHeader eyebrow="IT onboarding" title={profile.proposedDisplayName??'Approved dispatcher'} description="Manager-approved employment and a manual setup checklist." action={<StatusBadge status={request.status}/>}/>
 {closed?<Alert tone="success" title="Onboarding completed"><p>The manager was notified in this portal on <LocalTime iso={request.completedAt}/>. This checklist is read-only.</p></Alert>:<Card className="space-y-3 p-4 sm:p-5"><div className="flex flex-wrap items-end justify-between gap-3"><Progress className="min-w-0 flex-1 basis-60" label="Setup progress" value={completed} max={tasks.length} valueLabel={`${completed} of ${tasks.length} tasks done`}/><Button variant="outline" size="sm" disabled={busy} onClick={()=>contactDirty?setDiscard('refresh'):void refresh()}>{pending==='refresh'?'Refreshing…':'Refresh status'}</Button></div><p className="text-sm text-muted-foreground">{tasks.some(task=>task.status==='BLOCKED')?'Resolve the blocked tasks below to continue setup.':'Complete each setup task and save the company email and assigned RingCentral number.'} Completing the final task closes this checklist and notifies the manager in this portal.</p></Card>}
 <details className="rounded-lg border bg-card p-5" open><summary className="cursor-pointer font-semibold">Employee details</summary>{request.profilePhoto&&<figure className="mt-5 space-y-2"><figcaption className="text-sm text-muted-foreground">Profile photo</figcaption><PrivateImage src={`/api/backend/it/onboarding/${request.id}/photo`} alt="Profile photo" className="size-40 rounded-md border object-cover"/></figure>}<DescriptionList className="mt-5" items={fields.map(([label,value])=>({label:label??'',value}))}/></details>
 <Card className="space-y-5 p-5 sm:p-6"><div><h2 className="font-semibold">Company accounts</h2><p className="mt-1 text-sm text-muted-foreground">Record the accounts you created. Both are required before onboarding can finish and appear on the employee details for the manager.</p></div>
 {profile.workPhoneNumber?.trim()&&<div className="flex flex-wrap items-center gap-3 text-sm"><span>Applicant-provided work phone (older application):</span><span className="font-medium">{profile.workPhoneNumber}</span><Badge label={request.workPhoneVerifiedAt?'Verified by IT':'Applicant provided'} tone={request.workPhoneVerifiedAt?'success':'neutral'}/></div>}
 <form onSubmit={contact} className="space-y-4"><fieldset disabled={closed||busy} className="grid gap-4"><div className="flex flex-wrap gap-4"><Input label="Company email" name="companyEmail" type="email" maxLength={254} value={companyEmail} onChange={event=>setCompanyEmail(event.target.value)} placeholder="name@ugemconsulting.com" autoComplete="off" width="md"/><Input label="Assigned RingCentral phone number" name="assigned" type="tel" maxLength={40} value={assigned} onChange={event=>setAssigned(event.target.value)} placeholder="+1 202 555 0190" aria-describedby="ringcentral-help" width="md"/></div><p id="ringcentral-help" className="-mt-2 text-[13px] leading-5 text-muted-foreground">Phone numbers use 7–15 digits; international formatting is accepted.</p>{!!profile.workPhoneNumber?.trim()&&<Checkbox name="verified" checked={verified} onChange={event=>setVerified(event.target.checked)} label="I verified the applicant-provided work phone number."/>}{!closed&&<div className="flex flex-wrap items-center gap-3"><Button>{pending==='contact'?'Saving…':'Save company accounts'}</Button>{contactDirty&&<p role="status" className="text-sm text-warning">Unsaved changes</p>}</div>}<PendingHint pending={pending==='contact'||pending==='refresh'}/></fieldset></form>
 {request.workPhoneVerifiedAt&&<p className="text-xs text-muted-foreground">Verified <LocalTime iso={request.workPhoneVerifiedAt}/></p>}</Card>
 <section aria-labelledby="checklist-title" className="space-y-4"><h2 id="checklist-title" className="text-lg font-semibold">Setup checklist</h2>
 <Card className="space-y-4 p-5 sm:p-6"><h3 className="font-semibold">RingCentral</h3>{tasks.filter(task=>['RINGCENTRAL','SMS','CALL_RECORDING'].includes(task.key)).map(task=>renderTask(task,'h4'))}</Card>
 <div className="grid gap-4">{tasks.filter(task=>!['RINGCENTRAL','SMS','CALL_RECORDING'].includes(task.key)).map(task=>renderTask(task))}</div></section>
 <details className="rounded-lg border bg-card p-6"><summary className="cursor-pointer font-semibold">Activity history</summary><Timeline className="mt-5" items={[...data.activity].reverse().map(event=>({id:event.id,title:`${statusLabel(event.event)}${event.metadata.key?` · ${statusLabel(String(event.metadata.key))}`:''}`,meta:<LocalTime iso={event.createdAt}/>}))}/></details>
 <p className="text-xs text-muted-foreground">Checklist updates are manual records; they do not create external accounts or send messages. Never enter passwords or tokens in notes.</p>
 {editing&&<Dialog open onClose={()=>setEditing(null)} title={`Update ${editing.label}`} description="Record the outcome of your manual setup work." busy={pending==='task'} actions={<Button form="it-task-editor" type="submit">{pending==='task'?'Saving…':completing?'Complete onboarding':'Save task'}</Button>}>
 <form id="it-task-editor" onSubmit={update} className="space-y-4"><Select label="Status" name="status" value={taskStatus} onChange={event=>setTaskStatus(event.target.value as TaskOutcome)} width="sm" options={taskOutcomes.filter(status=>status!=='NOT_NEEDED'||editing.optional).map(status=>({value:status,label:statusLabel(status)}))}/><Textarea label={taskStatus==='BLOCKED'?'Blocked reason':'Notes'} optional={taskStatus!=='BLOCKED'} name="notes" defaultValue={editing.notes} required={taskStatus==='BLOCKED'} maxLength={1000} hint="Visible to IT only. Never include passwords or tokens."/>
 {completing&&<div className="space-y-3 rounded-md bg-warning-background p-4 text-sm text-warning"><p className="font-semibold">This completes onboarding.</p><p>Every task will be completed or marked not needed. The checklist becomes read-only and the manager receives a portal notification. Save the company email and assigned RingCentral number first.</p>{contactDirty&&<p>Close this dialog and save your unsaved company account changes before continuing.</p>}<Checkbox name="confirmCompletion" required label="I confirm setup is complete." className="text-foreground"/></div>}
 <Notice message={taskError} error/><PendingHint pending={pending==='task'}/>{taskError&&<p className="text-sm text-muted-foreground">If someone else updated this request, close this dialog and refresh its status before trying again.</p>}</form>
 </Dialog>}
 {discard&&<Dialog open size="sm" tone="warning" title="Discard unsaved company account changes?" description="The company email, RingCentral number or verification changes on this page have not been saved." onClose={()=>setDiscard(null)} protectChanges={false} closeLabel="Keep editing" actions={<Button variant="destructive" onClick={()=>discard==='refresh'?void refresh():router.push('/it/tasks')}>{discard==='refresh'?'Discard and refresh':'Discard and leave'}</Button>}><p className="text-sm">Save your contact changes first if you want to keep them.</p></Dialog>}
 </div>;
}
