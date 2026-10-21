'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { mutate } from '@/lib/client-api';
import { fieldLabels, FieldName, inputClass } from './types';
type Action='APPROVE'|'REQUEST_CHANGES'|'REJECT';
const titles:Record<Action,string>={APPROVE:'Approve application',REQUEST_CHANGES:'Request corrections',REJECT:'Reject application'};
export function ReviewActions({id,version,employment,requiredFields}:{id:string;version:number;requiredFields:FieldName[];employment:{mcName:string;teamLead:string;jobTitle:string}}) {
 const router=useRouter(),dialog=useRef<HTMLDialogElement>(null);
 const [action,setAction]=useState<Action>('APPROVE'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 function open(next:Action){setAction(next);setError('');dialog.current?.showModal();}
 async function decide(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();const data=new FormData(event.currentTarget);setBusy(true);setError('');
  try{await mutate(`onboarding/applications/${id}/reviews`,'POST',{version,decisionType:action,reason:String(data.get('reason')??''),requestedFields:data.getAll('requestedFields'),confirmed:data.get('confirmed')==='on',employmentConfirmed:data.get('employmentConfirmed')==='on',...(action==='APPROVE'?{employment:{mcName:data.get('mcName'),teamLead:data.get('teamLead'),jobTitle:data.get('jobTitle')}}:{})});dialog.current?.close();router.refresh();}
  catch(error){setError(error instanceof Error?error.message:'Unable to record decision.');}finally{setBusy(false);}
 }
 return <><div className="flex flex-wrap gap-3"><Button disabled={requiredFields.length>0} onClick={()=>open('APPROVE')}>Approve</Button><Button variant="outline" onClick={()=>open('REQUEST_CHANGES')}>Request changes</Button><Button variant="outline" onClick={()=>open('REJECT')}>Reject</Button></div>
 <dialog ref={dialog} aria-labelledby="review-dialog-title" onCancel={event=>{if(busy)event.preventDefault();}} className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-xl border border-border bg-card p-6 text-card-foreground shadow-xl backdrop:bg-black/50">
  <form key={action} onSubmit={decide} className="space-y-5"><h2 id="review-dialog-title" className="text-xl font-semibold">{titles[action]}</h2>
  <p className="text-sm text-muted-foreground">{action==='REQUEST_CHANGES'?'Your reason and selected fields will be visible to the applicant. Only the flagged fields become editable. Missing required fields are included automatically so the applicant can complete them.':action==='APPROVE'?'Confirm or correct the MC, team lead and job title below. Approval is final in this workflow. Approval creates an internal IT onboarding checklist. External accounts are not created automatically.':'Rejection closes this application. Your internal reason will not be shown to the applicant.'}</p>
  {action==='APPROVE'&&<fieldset className="space-y-3"><legend className="mb-2 font-medium">Final employment assignments</legend>{(['mcName','teamLead','jobTitle'] as const).map(field=><label key={field} className="block text-sm">{fieldLabels[field]}<input name={field} defaultValue={employment[field]} required maxLength={field==='jobTitle'?100:150} className={inputClass}/></label>)}<label className="flex items-start gap-3 text-sm"><input type="checkbox" name="employmentConfirmed" required className="mt-1"/>I have confirmed the MC, team lead and job title.</label></fieldset>}
  <label className="block text-sm">{action==='REQUEST_CHANGES'?'Applicant-facing correction instructions':action==='REJECT'?'Internal rejection reason':'Internal comment (optional)'}<textarea autoFocus name="reason" required={action!=='APPROVE'} maxLength={2000} rows={4} className={inputClass}/></label>
  {action==='REQUEST_CHANGES'?<fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">Fields requiring correction (choose at least one)</legend>{(Object.keys(fieldLabels) as FieldName[]).map(field=><label key={field} className="flex items-center gap-3 text-sm"><input type="checkbox" name="requestedFields" value={field} defaultChecked={requiredFields.includes(field)}/>{fieldLabels[field]}</label>)}</fieldset>:<label className="flex items-start gap-3 text-sm"><input name="confirmed" type="checkbox" required className="mt-1"/>I confirm this {action==='APPROVE'?'approval':'rejection'}. This decision cannot be reopened in the current workflow.</label>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <div className="flex flex-wrap justify-end gap-3"><Button type="button" variant="outline" disabled={busy} onClick={()=>dialog.current?.close()}>Cancel</Button><Button disabled={busy}>{busy?'Recording decision…':titles[action]}</Button></div>
  {error&&<Button type="button" variant="ghost" onClick={()=>{dialog.current?.close();router.refresh();}}>Reload current application</Button>}
  </form>
 </dialog></>;
}
