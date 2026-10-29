'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { CheckCircle2, Lock, TriangleAlert } from 'lucide-react';
import { applicationDraftResolver, applicationSubmitSchema, applicationValidationFeedback, ApplicationValues, employmentFields, personalFields, stepIssues } from './application-schema';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Checkbox, Input } from '@/components/ui/field';
import { DescriptionList } from '@/components/ui/description-list';
import { Progress } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { ApiError, APPLICANT_SESSION_EXPIRED_EVENT, errorMessage, mutate, readApi } from '@/lib/client-api';
import { applicantSessionExpiry, clearApplicantSession } from '@/lib/applicant-session';
import { ApplicantRecord, fieldLabels, FieldName, itemLabels } from './types';
import { ApplicantDocuments } from './applicant-documents';
import { ApplicantUpdates } from './applicant-updates';
import { VerifyAccess } from './applicant-access';
type Values = ApplicationValues;
const baseSteps=['Personal information','Employment','Review & submit'];
const documentSteps=['Personal information','Employment','Documents & signatures','Review & submit'];
const labels = fieldLabels;
const blank={firstName:'',lastName:'',personalPhoneNumber:'',workPhoneNumber:'',preferredAmericanFirstName:'',preferredAmericanLastName:'',telegram:'',mcName:'',teamLead:'',jobTitle:'Dispatcher'};
const formValues=(record:ApplicantRecord):Values=>({...blank,...record.application.fields,accurate:false});
const conflictMessage='Your application changed in another tab; we loaded the latest version. Review your entries and save again.';
// Autofill and keyboard hints. American names are chosen names, so the browser must not fill the legal name into them.
const inputHints:Partial<Record<FieldName,React.ComponentProps<'input'>>>={
 firstName:{autoComplete:'given-name'},lastName:{autoComplete:'family-name'},
 preferredAmericanFirstName:{autoComplete:'off'},preferredAmericanLastName:{autoComplete:'off'},
 personalPhoneNumber:{type:'tel',autoComplete:'tel',inputMode:'tel'},workPhoneNumber:{type:'tel',autoComplete:'off',inputMode:'tel'},
 telegram:{autoComplete:'off',autoCapitalize:'none',spellCheck:false},
};

export function ApplicantForm() {
 const [record,setRecord]=useState<ApplicantRecord|null>(null),[loadError,setLoadError]=useState('');
 useEffect(()=>{let active=true;readApi<ApplicantRecord>('applicant/application').then(data=>{if(active)setRecord(data);}).catch(error=>{if(active)setLoadError(errorMessage(error,'Unable to load your application. Please try again.'));});return()=>{active=false;};},[]);
 if(loadError)return <Card className="space-y-4 p-8"><h1 className="text-xl font-normal">Access unavailable</h1><p>{loadError}</p><p className="text-sm text-muted-foreground">Your session or invitation may have expired or been revoked.</p><Link className="text-primary underline" href="/apply/resume">Verify access again</Link></Card>;
 if(!record)return <div className="space-y-2 p-8"><p role="status">Loading your application…</p><PendingHint pending/></div>;
 return <Form initial={record}/>;
}

/** Remaining minutes of this tab's applicant session, or null when unknown. Re-read every 15 seconds. */
function useSessionMinutes(refreshKey:number) {
 const [minutes,setMinutes]=useState<number|null>(null);
 useEffect(()=>{
  const tick=()=>{const expiry=applicantSessionExpiry();setMinutes(expiry===null?null:Math.max(0,Math.ceil((expiry-Date.now())/60000)));};
  const first=window.setTimeout(tick,0),timer=window.setInterval(tick,15000);
  return()=>{window.clearTimeout(first);window.clearInterval(timer);};
 },[refreshKey]);
 return minutes;
}

function StepState({state}:{state:'complete'|'attention'|null}) {
 if(state==='complete')return <span className="mt-1 flex items-center gap-1 font-normal text-success"><CheckCircle2 aria-hidden="true" className="size-3.5"/>Complete</span>;
 if(state==='attention')return <span className="mt-1 flex items-center gap-1 font-normal text-warning"><TriangleAlert aria-hidden="true" className="size-3.5"/>Needs attention</span>;
 return null;
}

function Form({ initial }: { initial: ApplicantRecord }) {
 const router=useRouter(),toast=useToast();
 const [record,setRecord]=useState(initial),[step,setStep]=useState(0),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [failed,setFailed]=useState(false),[leaving,setLeaving]=useState(false),[referenceMessage,setReferenceMessage]=useState('');
 const [conflict,setConflict]=useState(false),[reverify,setReverify]=useState(false),[verifiedAt,setVerifiedAt]=useState(0),[submitAttempted,setSubmitAttempted]=useState(false);
 const steps=record.documents.required?documentSteps:baseSteps,reviewStep=steps.length-1;
 // A support (updater) assists one dispatcher and has no employment of their own: their manager sets the assignment.
 const support=record.invitation.position==='SUPPORT';
 const stepHeading=useRef<HTMLHeadingElement>(null),resultHeading=useRef<HTMLHeadingElement>(null);
 // Focus moves to the step heading when the user changes step, not on first load and not when an invalid field takes focus.
 const focusHeading=useRef(false),[submittedHere,setSubmittedHere]=useState(false);
 useEffect(()=>{if(focusHeading.current)stepHeading.current?.focus();focusHeading.current=false;},[step]);
 useEffect(()=>{if(!record.canEdit&&submittedHere)resultHeading.current?.focus();},[record.canEdit,submittedHere]);
 const {register,handleSubmit,getValues,reset,setValue,control,setError,clearErrors,setFocus,formState:{errors,isDirty}}=useForm<Values>({resolver:applicationDraftResolver,defaultValues:formValues(initial)});
 const [invalidField,setInvalidField]=useState<{field:keyof Values}>();
 useEffect(()=>{if(invalidField)setFocus(invalidField.field);},[invalidField,setFocus]);
 const watched=useWatch({control});
 const minutes=useSessionMinutes(verifiedAt);
 // Any applicant request (this form, photos, signatures, update choices) that finds the session gone opens re-verification.
 useEffect(()=>{const open=()=>setReverify(true);window.addEventListener(APPLICANT_SESSION_EXPIRED_EVENT,open);return()=>window.removeEventListener(APPLICANT_SESSION_EXPIRED_EVENT,open);},[]);
 useEffect(()=>{if(!isDirty)return;const warn=(event:BeforeUnloadEvent)=>event.preventDefault();window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[isDirty]);
 function goTo(index:number){focusHeading.current=true;setStep(index);}
 function showValidationErrors(issues: {path: readonly PropertyKey[]; message: string}[]) {
  const feedback=applicationValidationFeedback(issues);
  // The schema numbers the review step 2; it moves to 3 when the documents step is shown.
  setFailed(true);setStep(feedback.step===2?reviewStep:feedback.step);setMessage(feedback.message);setInvalidField(feedback.field?{field:feedback.field}:undefined);
 }
 const invalidForm: Parameters<typeof handleSubmit>[1] = errors => showValidationErrors(Object.entries(errors).map(([field,error])=>({path:[field],message:typeof error?.message==='string'?error.message:'Check this field.'})));
 const editable=(name:FieldName)=>record.editableFields.includes(name);
 const requested=(name:FieldName)=>!!record.correction?.requestedFields.includes(name);
 const personalShown=personalFields.filter(key=>key!=='workPhoneNumber'||requested('workPhoneNumber'));
 const stepFields:(readonly (keyof Values)[])[]=[personalShown,employmentFields];
 function stepState(index:number):'complete'|'attention'|null {
  if(index===reviewStep)return null;
  if(steps[index]==='Documents & signatures'){
   const items=['selfiePhoto','idPhoto','documents'] as const;
   if(items.some(item=>record.correction?.requestedFields.includes(item))&&record.documents.missing.length)return 'attention';
   return record.documents.missing.length?(submitAttempted?'attention':null):'complete';
  }
  const fields=stepFields[index];
  if(fields.some(field=>errors[field]))return 'attention';
  if(stepIssues({...formValues(record),...watched} as Values,record.invitation.telegramRequired,fields,support).length)return submitAttempted||fields.some(field=>requested(field as FieldName))?'attention':null;
  return 'complete';
 }
 function continueStep() {
  // Documents and review have no answer fields of their own; locked correction fields are never checked here.
  const fields=(stepFields[step]??[]).filter(field=>editable(field as FieldName));
  const issues=stepIssues(getValues(),record.invitation.telegramRequired,fields,support);
  clearErrors(fields as (keyof Values)[]);
  if(issues.length){for(const issue of issues)setError(issue.path[0] as keyof Values,{message:issue.message});setFailed(true);setMessage(`Please correct the highlighted fields. ${[...new Set(issues.map(issue=>issue.message))].join(' ')}`);setInvalidField({field:issues[0].path[0] as keyof Values});return;}
  setFailed(false);setMessage('');goTo(step+1);
 }
 async function loadLatest(keepEntries:boolean) {
  const latest=await readApi<ApplicantRecord>('applicant/application');
  setRecord(latest);
  // Keep the user's typed values; only the record (version, status, editable fields) is replaced.
  if(!keepEntries)reset(formValues(latest));
  return latest;
 }
 async function save(values:Values,submit:boolean) {
  if(submit)setSubmitAttempted(true);
  if(submit&&record.documents.missing.length){setFailed(true);setStep(2);setMessage('Upload both photos and sign every required document before submitting.');return;}
  if(submit){const checked=applicationSubmitSchema(record.invitation.telegramRequired,support).safeParse(values);
   if(!checked.success){for(const issue of checked.error.issues)setError(issue.path[0] as keyof Values,{message:issue.message});showValidationErrors(checked.error.issues);return;}}
  setBusy(true);setFailed(false);setMessage('');setConflict(false);
  try {
   const {accurate,...fields}=values;
   let version=record.application.version;
   // Preserve the explicit INVITED → DRAFT → SUBMITTED backend sequence for first-time submitters.
   if(submit&&record.application.status==='INVITED') {
    const draft=await mutate<ApplicantRecord>('applicant/draft','PATCH',{...fields,version});
    version=draft.application.version;setRecord(draft);
   }
   const updated=await mutate<ApplicantRecord>(submit?'applicant/submit':'applicant/draft',submit?'POST':'PATCH',{...fields,version,...(submit?{accurate}: {})});
   if(submit)setSubmittedHere(true);
   setRecord(updated);reset(values);
   toast({title:submit?'Application submitted':updated.correction?'Corrections saved':'Draft saved',description:submit?'Your information has been received.':updated.correction?'Resubmit when you are ready for review.':'You can return using your application reference.'});
  }catch(error){
   setFailed(true);
   if(error instanceof ApiError&&error.kind==='conflict'){
    // Never retry the save: load the latest record, keep the typed values and let the user review and save again.
    try{await loadLatest(true);setConflict(true);setMessage(conflictMessage);}catch(reload){setMessage(errorMessage(reload,'Your application changed. Reload the page before saving again.'));}
   }else setMessage(errorMessage(error,'Unable to save. Your changes remain on this page.'));
  }finally{setBusy(false);}
 }
 async function reloadLatest(){setBusy(true);try{await loadLatest(false);setConflict(false);setFailed(false);setMessage('');clearErrors();toast({title:'Latest version loaded'});}catch(error){setFailed(true);setMessage(errorMessage(error,'Unable to reload. Please try again.'));}finally{setBusy(false);}}
 async function logout(){try{await mutate('applicant/logout','POST');clearApplicantSession();router.replace('/apply/resume');router.refresh();}catch(error){setFailed(true);setMessage(errorMessage(error,'Unable to sign out. Please try again.'));}}
 async function refreshStatus() {
  setBusy(true);setFailed(false);try{await loadLatest(false);setStep(0);toast({title:'Status updated'});}catch(error){setFailed(true);setMessage(errorMessage(error,'Unable to refresh.'));}finally{setBusy(false);}
 }
 const reverifyDialog=reverify&&<Dialog open title="Verify your email to continue" description="Your session expired. Your entries are still on this page. After verifying, save again; nothing is sent until you do." onClose={()=>setReverify(false)} protectChanges={false} closeLabel="Not now">
  <VerifyAccess applicationId={record.application.id} email={record.invitation.email} onVerified={()=>{setReverify(false);setVerifiedAt(Date.now());setFailed(false);setMessage('');toast({title:'Email verified',description:'Your session is active again. Save your changes to continue.'});}}/>
 </Dialog>;
 if(!record.canEdit) {
  const status=record.application.status;
  const heading=status==='APPROVED'?'Application approved':status==='REJECTED'?'Application closed':status==='RESUBMITTED'?'Corrections resubmitted':'Application submitted';
  return <Card className="space-y-5 p-8"><p className="text-sm font-medium text-primary">{heading}</p><h1 ref={resultHeading} tabIndex={-1} className="text-2xl font-normal outline-none">{status==='REJECTED'?'Thank you for your interest.':`Thank you, ${record.application.fields.firstName}.`}</h1><p>{status==='REJECTED'?'Your application has been closed. Contact your manager if you have questions.':status==='APPROVED'?'Your application has been approved. Your manager will advise you on next steps.':'Your information has been received and is awaiting manager review. Check here for any correction requests.'}</p><p className="text-sm text-muted-foreground">This application is not currently open for edits.</p><p className="break-all text-sm">Application reference: {record.application.id}</p>{status!=='REJECTED'&&<ApplicantUpdates email={record.invitation.email}/>}{record.documents.items.some(doc=>doc.signed)&&<div className="space-y-2"><p className="text-sm font-medium">Your signed documents</p><ul className="space-y-1 text-sm">{record.documents.items.filter(doc=>doc.signed).map(doc=><li key={doc.kind}><a className="text-primary underline" href={`/api/backend/applicant/documents/${doc.signed!.documentId}/signed`} target="_blank" rel="noopener">{doc.title} (version {doc.signed!.version})</a></li>)}</ul></div>}{conflict&&<Alert tone="info"><p>This application was submitted or changed in another tab, so it is no longer open for edits here.</p></Alert>}<Notice message={conflict?'':message} error={failed}/><PendingHint pending={busy}/><div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={()=>void refreshStatus()}>{busy?'Checking…':'Check status'}</Button><Button variant="outline" onClick={()=>void logout()}>End applicant session</Button></div>{reverifyDialog}</Card>;
 }
 const values=getValues();
 const correctionHint=(name:FieldName):ReactNode=>requested(name)
  ?<span className="inline-flex items-center gap-1 font-medium text-warning"><TriangleAlert aria-hidden="true" className="size-3.5"/>Needs correction</span>
  :record.correction&&!editable(name)?<span className="inline-flex items-center gap-1"><Lock aria-hidden="true" className="size-3.5"/>Not editable in this correction</span>:undefined;
 const field=(name:FieldName,{required,hint,maxLength}:{required:boolean;hint?:string;maxLength:number})=><Input key={name} {...register(name)} {...inputHints[name]} id={`field-${name}`} label={labels[name]} optional={!required} aria-required={required||undefined}
  readOnly={!editable(name)} maxLength={maxLength} error={errors[name]?.message} width="full"
  hint={correctionHint(name)||hint?<>{correctionHint(name)}{correctionHint(name)&&hint?' ':''}{hint}</>:undefined}
  className={cn(requested(name)&&'rounded-md border border-warning-border bg-warning-background/40 p-3')}/>;
 const phoneHint='7–15 digits; international formats such as +1 202 555 0190 are accepted.';
 const sessionWarning=minutes!==null&&minutes<=10;
 const reviewItems=[...(Object.keys(labels) as FieldName[]).filter(key=>key!=='workPhoneNumber'||requested('workPhoneNumber')).map(key=>({label:labels[key],value:String(values[key]||'')})),{label:'Verified email',value:record.invitation.email??''}];
 return <div className="space-y-5"><div><p className="text-sm font-medium text-primary">Dispatcher application</p><h1 className="mt-1 text-3xl font-normal sm:text-4xl">Let’s get to know you</h1><p className="mt-2 text-sm text-muted-foreground">Your answers, photos and signed documents are stored securely. Only your manager and administrators can see them; the IT team sees your name, contact details and profile photo.</p></div>
 <Card className="p-4"><p className="text-sm">Save this application reference to return after your one-hour session expires:</p><p className="mt-1 break-all font-mono text-sm">{record.application.id}</p><Button type="button" variant="outline" className="mt-3" onClick={async()=>{try{await navigator.clipboard.writeText(record.application.id);setReferenceMessage('Reference copied.');}catch{setReferenceMessage('Select and copy the reference above.');}}}>Copy application reference</Button><p role="status" className="mt-2 text-sm">{referenceMessage}</p>{minutes!==null&&!sessionWarning&&<p className="mt-1 text-sm text-muted-foreground">Session time left: about {minutes} minutes.</p>}</Card>
 {sessionWarning&&<Alert tone="warning" role="status" title={minutes===0?'Your session has ended':`Your session ends in ${minutes} minute${minutes===1?'':'s'}`} action={minutes===0?<Button size="sm" variant="outline" onClick={()=>setReverify(true)}>Verify email</Button>:undefined}><p>{minutes===0?'Verify your email again, then save. Your entries are still on this page.':'Save your draft now. If the session ends, you can verify your email again without losing what is on this page.'}</p></Alert>}
 <div className="sm:hidden"><Progress label={`Step ${step+1} of ${steps.length}: ${steps[step]}`} value={step+1} max={steps.length} valueLabel={`Step ${step+1} of ${steps.length}`}/></div>
 <ol className={`hidden gap-2 sm:grid ${steps.length===4?'sm:grid-cols-4':'sm:grid-cols-3'}`} aria-label="Application steps">{steps.map((label,index)=>{const state=stepState(index);return <li key={label}><button type="button" aria-current={step===index?'step':undefined} disabled={busy} onClick={()=>goTo(index)} className={`h-full w-full rounded-md border p-3 text-left text-xs ${step===index?'border-primary bg-brand-subtle font-semibold text-brand-subtle-foreground':'border-border text-muted-foreground'}`}>{index+1}. {label}<StepState state={state}/></button></li>;})}</ol>
 {record.correction&&<Alert tone="warning" title="Corrections requested"><p className="whitespace-pre-wrap break-words">{record.correction.reason}</p><p>Items to update: {record.correction.requestedFields.map(field=>itemLabels[field]).join(', ')}.</p><p className="text-[13px] text-muted-foreground">Only the items marked Needs correction can change. Save your progress, then resubmit for review. Access expires <LocalTime iso={record.accessUntil} format="date"/>.</p></Alert>}
 <form noValidate onSubmit={handleSubmit(values=>save(values,true),invalidForm)}><fieldset disabled={busy} className="min-w-0"><Card className="space-y-5 p-6 sm:p-8"><h2 ref={stepHeading} tabIndex={-1} className="text-lg font-semibold outline-none">{steps[step]}</h2><p className="text-sm text-muted-foreground">Step {step+1} of {steps.length}. All fields are required unless marked optional.</p>
 {step===0&&<div className="grid gap-4 sm:grid-cols-2">{personalShown.map(name=>field(name,{required:['firstName','lastName','personalPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName'].includes(name)||(name==='telegram'&&record.invitation.telegramRequired),maxLength:['personalPhoneNumber','workPhoneNumber'].includes(name)?40:100,hint:['personalPhoneNumber','workPhoneNumber'].includes(name)?phoneHint:undefined}))}<Input id="field-verifiedEmail" label="Verified personal email" type="email" readOnly value={record.invitation.email??''} hint="Verified when you started. It cannot be changed." className="sm:col-span-2" width="full"/></div>}
 {step===1&&support&&<p className="text-sm leading-6 text-muted-foreground">You’re joining as a support (updater), working with one of our dispatchers. Your manager sets your assignment, so there’s nothing to fill in here. Continue to the next step.</p>}
 {step===1&&!support&&<><p className="text-sm text-muted-foreground">Enter your employment details. Your manager will confirm the final assignments before approval. IT will assign your work phone number when setting up RingCentral.</p><div className="grid gap-4">{employmentFields.map(name=><div key={name} className="grid gap-2">{field(name,{required:true,maxLength:name==='jobTitle'?100:150})}{name!=='jobTitle'&&<Checkbox label="Independent" checked={watched[name]==='Independent'} disabled={!editable(name)} onChange={event=>setValue(name,event.target.checked?'Independent':'',{shouldDirty:true,shouldValidate:!!errors[name]})}/>}</div>)}</div></>}
 {steps[step]==='Documents & signatures'&&<ApplicantDocuments record={record} onRecord={setRecord} busy={busy}/>}
 {step===reviewStep&&<>{record.documents.missing.length>0&&<Alert tone="warning"><p>Still needed: {record.documents.missing.map(item=>itemLabels[item]).join(', ')}.</p></Alert>}<DescriptionList items={reviewItems}/><ApplicantUpdates email={record.invitation.email}/><Checkbox {...register('accurate')} label="I confirm that the information is accurate." error={!!errors.accurate} aria-describedby={errors.accurate?'accurate-error':undefined} className="border-t border-border pt-5"/>{errors.accurate&&<p id="accurate-error" className="text-sm text-danger">{errors.accurate.message}</p>}</>}
 {message&&<Alert tone={failed?(conflict?'warning':'danger'):'success'} role={failed?'alert':'status'} action={conflict?<Button type="button" size="sm" variant="outline" onClick={()=>void reloadLatest()}>Reload latest</Button>:undefined}><p>{message}</p>{conflict&&<p className="text-[13px] text-muted-foreground">Reload latest replaces your unsaved entries with the saved version.</p>}</Alert>}
 <p role="status" className="text-sm text-muted-foreground">{busy?'Saving your information…':isDirty?'You have unsaved changes.':'No unsaved changes.'}</p><PendingHint pending={busy}/>
 <div className="flex flex-wrap justify-between gap-3"><div className="flex gap-2">{step>0&&<Button type="button" variant="outline" onClick={()=>goTo(step-1)}>Back</Button>}<Button type="button" variant="outline" disabled={busy} onClick={()=>void handleSubmit(values=>save(values,false),invalidForm)()}>{record.correction?'Save corrections':'Save draft'}</Button></div>{step<reviewStep?<Button type="button" onClick={continueStep}>Continue</Button>:<Button type="submit" disabled={busy}>{record.correction?'Resubmit application':'Submit application'}</Button>}</div></Card></fieldset></form>
 <p className="text-sm text-muted-foreground">Save your draft before closing this page. <Link href="/apply/resume" onClick={event=>{if(isDirty||busy){event.preventDefault();if(!busy)setLeaving(true);}}} className="underline">Returning applicant access</Link></p>
 {leaving&&<Dialog open title="Leave without saving?" description="Your unsaved application changes will be lost. Save your draft before returning later." onClose={()=>setLeaving(false)} protectChanges={false} closeLabel="Keep editing" actions={<Button variant="destructive" onClick={()=>router.push('/apply/resume')}>Leave without saving</Button>}><p className="text-sm">Your previously saved draft will still be available.</p></Dialog>}
 {reverifyDialog}</div>;
}
