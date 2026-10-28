'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { applicationDraftResolver, applicationSubmitSchema, applicationValidationFeedback, ApplicationValues } from './application-schema';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { mutate } from '@/lib/client-api';
import { ApplicantRecord, inputClass, readApi, fieldLabels, itemLabels } from './types';
import { ApplicantDocuments } from './applicant-documents';
type Values = ApplicationValues;
const baseSteps=['Personal information','Employment','Review & submit'];
const documentSteps=['Personal information','Employment','Documents & signatures','Review & submit'];
const labels = fieldLabels;
export function ApplicantForm() {
 const [record,setRecord]=useState<ApplicantRecord|null>(null),[loadError,setLoadError]=useState('');
 useEffect(()=>{let active=true;readApi<ApplicantRecord>('applicant/application').then(data=>{if(active)setRecord(data);}).catch(error=>{if(active)setLoadError(error.message);});return()=>{active=false;};},[]);
 if(loadError)return <Card className="space-y-4 p-8"><h1 className="text-xl font-normal">Access unavailable</h1><p>{loadError}</p><p className="text-sm text-muted-foreground">Your session or invitation may have expired or been revoked.</p><Link className="text-primary underline" href="/apply/resume">Verify access again</Link></Card>;
 if(!record)return <p role="status" className="p-8">Loading your application…</p>;
 return <Form initial={record}/>;
}
function Form({ initial }: { initial: ApplicantRecord }) {
 const router=useRouter();
 const [record,setRecord]=useState(initial),[step,setStep]=useState(0),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [failed,setFailed]=useState(false),[leaving,setLeaving]=useState(false),[referenceMessage,setReferenceMessage]=useState('');
 const steps=record.documents.required?documentSteps:baseSteps,reviewStep=steps.length-1;
 const stepHeading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{stepHeading.current?.focus();},[step]);
 const {register,handleSubmit,getValues,reset,setValue,control,setError,setFocus,formState:{errors,isDirty}}=useForm<Values>({resolver:applicationDraftResolver,defaultValues:{firstName:'',lastName:'',personalPhoneNumber:'',workPhoneNumber:'',preferredAmericanFirstName:'',preferredAmericanLastName:'',telegram:'',mcName:'',teamLead:'',jobTitle:'Dispatcher',...initial.application.fields,accurate:false}});
 const [invalidField,setInvalidField]=useState<{field:keyof Values}>();
 useEffect(()=>{if(invalidField)setFocus(invalidField.field);},[invalidField,setFocus]);
 function showValidationErrors(issues: {path: readonly PropertyKey[]; message: string}[]) {
  const feedback=applicationValidationFeedback(issues);
  // The schema numbers the review step 2; it moves to 3 when the documents step is shown.
  setFailed(true);setStep(feedback.step===2?reviewStep:feedback.step);setMessage(feedback.message);setInvalidField(feedback.field?{field:feedback.field}:undefined);
 }
 const invalidForm: Parameters<typeof handleSubmit>[1] = errors => showValidationErrors(Object.entries(errors).map(([field,error])=>({path:[field],message:typeof error?.message==='string'?error.message:'Check this field.'})));
 const employmentValues=useWatch({control,name:['mcName','teamLead']});
 useEffect(()=>{if(!isDirty)return;const warn=(event:BeforeUnloadEvent)=>event.preventDefault();window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[isDirty]);
 async function save(values:Values,submit:boolean) {
  if(submit&&record.documents.missing.length){setFailed(true);setStep(2);setMessage('Upload both photos and sign every required document before submitting.');return;}
  if(submit){const checked=applicationSubmitSchema(record.invitation.telegramRequired).safeParse(values);
   if(!checked.success){for(const issue of checked.error.issues)setError(issue.path[0] as keyof Values,{message:issue.message});showValidationErrors(checked.error.issues);return;}}
  setBusy(true);setFailed(false);setMessage('');
  try {
   const {accurate,...fields}=values;
   let version=record.application.version;
   // Preserve the explicit INVITED → DRAFT → SUBMITTED backend sequence for first-time submitters.
   if(submit&&record.application.status==='INVITED') {
    const draft:ApplicantRecord=await mutate('applicant/draft','PATCH',{...fields,version});
    version=draft.application.version;setRecord(draft);
   }
   const updated:ApplicantRecord=await mutate(submit?'applicant/submit':'applicant/draft',submit?'POST':'PATCH',{...fields,version,...(submit?{accurate}: {})});
   setRecord(updated);reset(values);setMessage(submit?'Your information has been submitted.':updated.correction?'Corrections saved. Resubmit when you are ready for review.':'Draft saved. You can return using your application reference.');
  }catch(error){setFailed(true);setMessage(error instanceof Error?error.message:'Unable to save. Your changes remain on this page.');}finally{setBusy(false);}
 }
 async function logout(){try{await mutate('applicant/logout','POST');router.replace('/apply/resume');router.refresh();}catch{setFailed(true);setMessage('Unable to sign out. Please try again.');}}
 async function refreshStatus() {
  setBusy(true);setFailed(false);try{const updated=await readApi<ApplicantRecord>('applicant/application');setRecord(updated);reset({firstName:'',lastName:'',personalPhoneNumber:'',workPhoneNumber:'',preferredAmericanFirstName:'',preferredAmericanLastName:'',telegram:'',mcName:'',teamLead:'',jobTitle:'Dispatcher',...updated.application.fields,accurate:false});setStep(0);setMessage('Status updated.');}catch(error){setFailed(true);setMessage(error instanceof Error?error.message:'Unable to refresh.');}finally{setBusy(false);}
 }
 if(!record.canEdit) {
  const status=record.application.status;
  const heading=status==='APPROVED'?'Application approved':status==='REJECTED'?'Application closed':status==='RESUBMITTED'?'Corrections resubmitted':'Application submitted';
  return <Card className="space-y-5 p-8"><p className="text-sm font-medium text-primary">{heading}</p><h1 className="text-2xl font-normal">{status==='REJECTED'?'Thank you for your interest.':`Thank you, ${record.application.fields.firstName}.`}</h1><p>{status==='REJECTED'?'Your application has been closed. Contact your manager if you have questions.':status==='APPROVED'?'Your application has been approved. Your manager will advise you on next steps.':'Your information has been received and is awaiting manager review. Check here for any correction requests.'}</p><p className="text-sm text-muted-foreground">This application is not currently open for edits.</p><p className="break-all text-sm">Application reference: {record.application.id}</p>{record.documents.items.some(doc=>doc.signed)&&<div className="space-y-2"><p className="text-sm font-medium">Your signed documents</p><ul className="space-y-1 text-sm">{record.documents.items.filter(doc=>doc.signed).map(doc=><li key={doc.kind}><a className="text-primary underline" href={`/api/backend/applicant/documents/${doc.signed!.documentId}/signed`} target="_blank" rel="noopener">{doc.title} (version {doc.signed!.version})</a></li>)}</ul></div>}<Notice message={message} error={failed}/><div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={()=>void refreshStatus()}>{busy?'Checking…':'Check status'}</Button><Button variant="outline" onClick={()=>void logout()}>End applicant session</Button></div></Card>;
 }
 const values=getValues();
 return <div className="space-y-5"><div><p className="text-sm font-medium text-primary">Dispatcher application</p><h1 className="mt-1 text-3xl font-normal sm:text-4xl">Let’s get to know you</h1><p className="mt-2 text-sm text-muted-foreground">Your answers, photos and signed documents are stored securely. Only your manager and administrators can see them; the IT team sees your name, contact details and profile photo.</p></div><Card className="p-4"><p className="text-sm">Save this application reference to return after your one-hour session expires:</p><p className="mt-1 break-all font-mono text-sm">{record.application.id}</p><Button type="button" variant="outline" className="mt-3" onClick={async()=>{try{await navigator.clipboard.writeText(record.application.id);setReferenceMessage('Reference copied.');}catch{setReferenceMessage('Select and copy the reference above.');}}}>Copy application reference</Button><p role="status" className="mt-2 text-sm">{referenceMessage}</p></Card>
 <ol className={`grid grid-cols-1 gap-2 ${steps.length===4?'sm:grid-cols-4':'sm:grid-cols-3'}`} aria-label="Application steps">{steps.map((label,index)=><li key={label}><button type="button" aria-current={step===index?'step':undefined} disabled={busy} onClick={()=>setStep(index)} className={`h-full w-full rounded-md border p-3 text-left text-xs ${step===index?'border-primary bg-brand-subtle font-semibold text-brand-subtle-foreground':'border-border text-muted-foreground'}`}>{index+1}. {label}</button></li>)}</ol>
 {record.correction&&<Card className="space-y-3 border-warning/40 bg-warning-background p-5"><h2 className="font-semibold">Corrections requested</h2><p className="whitespace-pre-wrap break-words text-sm">{record.correction.reason}</p><p className="text-sm">Fields to update: {record.correction.requestedFields.map(field=>itemLabels[field]).join(', ')}.</p><p className="text-xs text-muted-foreground">Only the highlighted fields can change. Save your progress, then resubmit for review. Access expires {new Date(record.accessUntil).toLocaleDateString()}.</p></Card>}
 <form noValidate onSubmit={handleSubmit(values=>save(values,true),invalidForm)}><fieldset disabled={busy} className="min-w-0"><Card className="space-y-5 p-6 sm:p-8"><h2 ref={stepHeading} tabIndex={-1} className="text-lg font-semibold outline-none">{steps[step]}</h2><p className="text-sm text-muted-foreground">Step {step+1} of {steps.length}. Required fields are marked with an asterisk.</p>
 {step===0&&<div className="grid gap-4 sm:grid-cols-2">{Object.entries(labels).filter(([key])=>!['mcName','teamLead','jobTitle'].includes(key)&&(key!=='workPhoneNumber'||!!record.correction?.requestedFields.includes('workPhoneNumber'))).map(([key,label])=>{const name=key as keyof typeof labels;const required=['firstName','lastName','personalPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName'].includes(key)||(key==='telegram'&&record.invitation.telegramRequired);return <label key={key} className={record.correction?.requestedFields.includes(name)?'rounded-md border border-warning/50 p-3':''}>{label}{required?' *':' (optional)'}<input {...register(name)} readOnly={!record.editableFields.includes(name)} aria-readonly={!record.editableFields.includes(name)} aria-required={required} aria-invalid={!!errors[name]} aria-describedby={errors[name]?`${name}-error`:undefined} type={['personalPhoneNumber','workPhoneNumber'].includes(key)?'tel':'text'} maxLength={['personalPhoneNumber','workPhoneNumber'].includes(key)?40:100} className={inputClass}/>{errors[name]&&<span id={`${name}-error`} className="text-sm text-danger">{errors[name]?.message}</span>}</label>;})}<label className="sm:col-span-2">Verified personal email<input readOnly value={record.invitation.email??''} className={inputClass}/></label></div>}
 {step===1&&<><p className="text-sm text-muted-foreground">Enter your employment details. Your manager will confirm the final assignments before approval. IT will assign your work phone number when setting up RingCentral.</p><div className="grid gap-4">{(['mcName','teamLead','jobTitle'] as const).map(name=><div key={name} className={record.correction?.requestedFields.includes(name)?'rounded-md border border-warning/50 p-3':''}><label>{labels[name]} *<input {...register(name)} maxLength={name==='jobTitle'?100:150} readOnly={!record.editableFields.includes(name)} aria-readonly={!record.editableFields.includes(name)} aria-required="true" aria-invalid={!!errors[name]} aria-describedby={errors[name]?`${name}-error`:undefined} className={inputClass}/></label>{name!=='jobTitle'&&<label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={employmentValues[name==='mcName'?0:1]==='Independent'} disabled={!record.editableFields.includes(name)} onChange={event=>setValue(name,event.target.checked?'Independent':'',{shouldDirty:true})}/>Independent</label>}{errors[name]&&<p id={`${name}-error`} className="text-sm text-danger">{errors[name]?.message}</p>}</div>)}</div></>}
 {steps[step]==='Documents & signatures'&&<ApplicantDocuments record={record} onRecord={setRecord} busy={busy}/>}
 {step===reviewStep&&<>{record.documents.missing.length>0&&<Alert tone="warning"><p>Still needed: {record.documents.missing.map(item=>itemLabels[item]).join(', ')}.</p></Alert>}<dl className="grid gap-4 sm:grid-cols-2">{[...Object.entries(labels).map(([key,label])=>[label,String(values[key as keyof typeof labels]||'Not provided')]),['Verified email',record.invitation.email]].map(([label,value])=><div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="break-words font-medium">{value}</dd></div>)}</dl><label className="flex items-start gap-3 border-t border-border pt-5"><input type="checkbox" {...register('accurate')} aria-invalid={!!errors.accurate} aria-describedby={errors.accurate?'accurate-error':undefined} className="mt-1"/>I confirm that the information is accurate.</label>{errors.accurate&&<p id="accurate-error" className="text-sm text-danger">{errors.accurate.message}</p>}</>}
 <Notice message={message} error={failed}/><p role="status" className="text-sm text-muted-foreground">{busy?'Saving your information…':isDirty?'You have unsaved changes.':'No unsaved changes.'}</p><div className="flex flex-wrap justify-between gap-3"><div className="flex gap-2">{step>0&&<Button type="button" variant="outline" onClick={()=>setStep(step-1)}>Back</Button>}<Button type="button" variant="outline" disabled={busy} onClick={()=>void handleSubmit(values=>save(values,false),invalidForm)()}>{record.correction?'Save corrections':'Save draft'}</Button></div>{step<reviewStep?<Button type="button" onClick={()=>setStep(step+1)}>Continue</Button>:<Button type="submit" disabled={busy}>{record.correction?'Resubmit application':'Submit application'}</Button>}</div></Card></fieldset></form><p className="text-sm text-muted-foreground">Save your draft before closing this page. <Link href="/apply/resume" onClick={event=>{if(isDirty||busy){event.preventDefault();if(!busy)setLeaving(true);}}} className="underline">Returning applicant access</Link></p>{leaving&&<Dialog open title="Leave without saving?" description="Your unsaved application changes will be lost. Save your draft before returning later." onClose={()=>setLeaving(false)} protectChanges={false} closeLabel="Keep editing" actions={<Button variant="destructive" onClick={()=>router.push('/apply/resume')}>Leave without saving</Button>}><p className="text-sm">Your previously saved draft will still be available.</p></Dialog>}</div>;
}
