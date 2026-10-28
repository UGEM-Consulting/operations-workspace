'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Checkbox, Input, Textarea } from '@/components/ui/field';
import { mutate } from '@/lib/client-api';
import { SignaturePad } from './signature-pad';
import { documentItemLabels, fieldLabels, FieldName, itemLabels, RequestableItem, StaffDocuments } from './types';
type Action='APPROVE'|'REQUEST_CHANGES'|'REJECT';
const titles:Record<Action,string>={APPROVE:'Approve application',REQUEST_CHANGES:'Request corrections',REJECT:'Reject application'};
export function ReviewActions({id,version,employment,requiredFields,documentsRequired,countersign}:{id:string;version:number;requiredFields:RequestableItem[];documentsRequired:boolean;countersign:StaffDocuments['countersign'];employment:{mcName:string;teamLead:string;jobTitle:string}}) {
 const router=useRouter();
 const [action,setAction]=useState<Action|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[signature,setSignature]=useState<string|null>(null);
 function open(next:Action){setAction(next);setError('');setSignature(null);}
 // Work phones are assigned by IT; only an invalid legacy value is offered for correction.
 const correctable:RequestableItem[]=[...(Object.keys(fieldLabels) as FieldName[]).filter(field=>field!=='workPhoneNumber'||requiredFields.includes(field)),...(documentsRequired?Object.keys(documentItemLabels) as RequestableItem[]:[])];
 async function decide(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy||!action)return;const data=new FormData(event.currentTarget);
  if(action==='REQUEST_CHANGES'&&!data.getAll('requestedFields').length){setError('Select at least one item for the applicant to correct.');return;}
  if(action==='APPROVE'&&countersign&&!signature){setError('Draw your signature to countersign the NDA.');return;}
  setBusy(true);setError('');
  try{await mutate(`onboarding/applications/${id}/reviews`,'POST',{version,decisionType:action,reason:String(data.get('reason')??''),requestedFields:data.getAll('requestedFields'),confirmed:data.get('confirmed')==='on',employmentConfirmed:data.get('employmentConfirmed')==='on',
   ...(action==='APPROVE'?{employment:{mcName:data.get('mcName'),teamLead:data.get('teamLead'),jobTitle:data.get('jobTitle')}}:{}),
   ...(action==='APPROVE'&&countersign?{countersignature:{typedName:String(data.get('countersignName')??''),signature,agreed:data.get('countersignAgreed')==='on'}}:{})});setAction(null);router.refresh();}
  catch(error){setError(error instanceof Error?error.message:'Unable to record decision. Your entries have been kept.');}finally{setBusy(false);}
 }
 return <><div className="flex flex-wrap gap-3"><Button disabled={requiredFields.length>0} onClick={()=>open('APPROVE')}>Approve</Button><Button variant="outline" onClick={()=>open('REQUEST_CHANGES')}>Request changes</Button><Button variant="outline" className="text-danger" onClick={()=>open('REJECT')}>Reject</Button></div>
 {requiredFields.length>0&&<p className="text-sm text-warning">Approval needs complete applicant information, photos and signatures. Request corrections for {requiredFields.map(field=>itemLabels[field]).join(', ')}.</p>}
 {action&&<Dialog open onClose={()=>setAction(null)} busy={busy} title={titles[action]} size={action==='APPROVE'&&countersign?'lg':'md'} tone={action==='REJECT'?'danger':undefined}
 description={action==='REQUEST_CHANGES'?'Your instructions and selected items will be visible to the applicant. Only these items become editable.':action==='APPROVE'?'Confirm the final employment assignments. Approval is final and creates a manual IT onboarding checklist.':'Rejection closes this application and cannot be undone. Your internal reason will not be shown to the applicant.'}
 actions={<Button form="review-decision" type="submit" variant={action==='REJECT'?'destructive':'default'}>{busy?'Recording decision…':titles[action]}</Button>}>
 <form id="review-decision" onSubmit={decide} className="space-y-5">
  {action==='APPROVE'&&<fieldset className="space-y-4"><legend className="mb-3 text-[15px] font-semibold">Final employment assignments</legend>{(['mcName','teamLead','jobTitle'] as const).map(field=><Input key={field} label={fieldLabels[field]} name={field} defaultValue={employment[field]} required maxLength={field==='jobTitle'?100:150} width="md"/>)}<Checkbox name="employmentConfirmed" required label="I have confirmed the MC, team lead and job title."/></fieldset>}
  {action==='APPROVE'&&countersign&&<fieldset className="space-y-4 border-t border-border pt-5"><legend className="mb-3 text-[15px] font-semibold">Countersign the NDA for the company</legend>
   <p className="text-sm text-muted-foreground"><a className="text-primary underline" href={`/api/backend/onboarding/applications/${id}/documents/${countersign.documentId}/signed`} target="_blank" rel="noopener">Open the applicant-signed {countersign.title} (version {countersign.version})</a></p>
   <Input label="Your full legal name" hint="Latin letters, as on your ID." name="countersignName" required maxLength={100} pattern="[A-Za-z][A-Za-z .,'\-]+" autoComplete="name" width="md"/>
   <SignaturePad label="Draw your signature" onChange={setSignature} disabled={busy}/>
   <Checkbox name="countersignAgreed" required label={countersign.statement}/>
  </fieldset>}
  <Textarea name="reason" label={action==='REQUEST_CHANGES'?'Instructions for the applicant':action==='REJECT'?'Reason for rejection':'Internal comment'} optional={action==='APPROVE'} required={action!=='APPROVE'} maxLength={2000} hint={action==='REQUEST_CHANGES'?'The applicant sees this message.':'Visible to staff only. The applicant never sees it.'}/>
  {action==='REQUEST_CHANGES'?<fieldset className="space-y-3"><legend className="mb-1 text-sm font-medium">Items to correct</legend><p className="text-[13px] leading-5 text-muted-foreground">Choose at least one; only these become editable.{requiredFields.length>0&&' Missing required items are already selected.'}</p><div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{correctable.map(field=><Checkbox key={field} name="requestedFields" value={field} defaultChecked={requiredFields.includes(field)} label={itemLabels[field]}/>)}</div></fieldset>:<Checkbox name="confirmed" required label={`I confirm this ${action==='APPROVE'?'approval':'rejection'}. This decision cannot be reopened.`}/>}
  <Notice message={error} error/>
  {error&&<p className="text-sm text-muted-foreground">If another reviewer changed this application, close this dialog and reload its latest details before trying again.</p>}
 </form>
 </Dialog>}
 </>;
}
