'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { mutate } from '@/lib/client-api';
import { fieldLabels, FieldName, inputClass } from './types';
type Action='APPROVE'|'REQUEST_CHANGES'|'REJECT';
const titles:Record<Action,string>={APPROVE:'Approve application',REQUEST_CHANGES:'Request corrections',REJECT:'Reject application'};
export function ReviewActions({id,version,employment,requiredFields}:{id:string;version:number;requiredFields:FieldName[];employment:{mcName:string;teamLead:string;jobTitle:string}}) {
 const router=useRouter();
 const [action,setAction]=useState<Action|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 function open(next:Action){setAction(next);setError('');}
 async function decide(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy||!action)return;const data=new FormData(event.currentTarget);
  if(action==='REQUEST_CHANGES'&&!data.getAll('requestedFields').length){setError('Select at least one field for the applicant to correct.');return;}
  setBusy(true);setError('');
  try{await mutate(`onboarding/applications/${id}/reviews`,'POST',{version,decisionType:action,reason:String(data.get('reason')??''),requestedFields:data.getAll('requestedFields'),confirmed:data.get('confirmed')==='on',employmentConfirmed:data.get('employmentConfirmed')==='on',...(action==='APPROVE'?{employment:{mcName:data.get('mcName'),teamLead:data.get('teamLead'),jobTitle:data.get('jobTitle')}}:{})});setAction(null);router.refresh();}
  catch(error){setError(error instanceof Error?error.message:'Unable to record decision. Your entries have been kept.');}finally{setBusy(false);}
 }
 return <><div className="flex flex-wrap gap-3"><Button disabled={requiredFields.length>0} onClick={()=>open('APPROVE')}>Approve</Button><Button variant="outline" onClick={()=>open('REQUEST_CHANGES')}>Request changes</Button><Button variant="outline" className="text-destructive" onClick={()=>open('REJECT')}>Reject</Button></div>
 {requiredFields.length>0&&<p className="text-sm text-warning">Approval needs complete applicant information. Request corrections for {requiredFields.map(field=>fieldLabels[field]).join(', ')}.</p>}
 {action&&<Dialog open onClose={()=>setAction(null)} busy={busy} title={titles[action]}
 description={action==='REQUEST_CHANGES'?'Your instructions and selected fields will be visible to the applicant. Only these fields become editable.':action==='APPROVE'?'Confirm the final employment assignments. Approval is final and creates a manual IT onboarding checklist.':'Rejection closes this application and cannot be undone. Your internal reason will not be shown to the applicant.'}
 actions={<Button form="review-decision" type="submit" variant={action==='REJECT'?'destructive':'default'}>{busy?'Recording decision…':titles[action]}</Button>}>
 <form id="review-decision" onSubmit={decide} className="space-y-5">
  {action==='APPROVE'&&<fieldset className="space-y-3"><legend className="mb-2 font-medium">Final employment assignments</legend>{(['mcName','teamLead','jobTitle'] as const).map(field=><label key={field} className="block text-sm">{fieldLabels[field]} *<input name={field} defaultValue={employment[field]} required maxLength={field==='jobTitle'?100:150} className={inputClass}/></label>)}<label className="flex items-start gap-3 text-sm"><input type="checkbox" name="employmentConfirmed" required className="mt-1"/>I have confirmed the MC, team lead and job title.</label></fieldset>}
  <label className="block text-sm">{action==='REQUEST_CHANGES'?'Instructions for the applicant *':action==='REJECT'?'Internal rejection reason *':'Internal comment (optional)'}<textarea name="reason" required={action!=='APPROVE'} maxLength={2000} rows={4} className={inputClass}/></label>
  {action==='REQUEST_CHANGES'?<fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">Fields requiring correction — choose at least one</legend>{requiredFields.length>0&&<p className="text-sm text-muted-foreground">Missing required fields are preselected and must be completed.</p>}{(Object.keys(fieldLabels) as FieldName[]).filter(field=>field!=='workPhoneNumber'||requiredFields.includes(field)).map(field=><label key={field} className="flex items-center gap-3 text-sm"><input type="checkbox" name="requestedFields" value={field} defaultChecked={requiredFields.includes(field)}/>{fieldLabels[field]}</label>)}</fieldset>:<label className="flex items-start gap-3 text-sm"><input name="confirmed" type="checkbox" required className="mt-1"/>I confirm this {action==='APPROVE'?'approval':'rejection'}. This decision cannot be reopened.</label>}
  <Notice message={error} error/>
  {error&&<p className="text-sm text-muted-foreground">If another reviewer changed this application, close this dialog and reload its latest details before trying again.</p>}
 </form>
 </Dialog>}
 </>;
}
