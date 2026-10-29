'use client';
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Checkbox, Input, Textarea } from '@/components/ui/field';
import { PendingHint } from '@/components/ui/pending-hint';
import { errorMessage, mutate } from '@/lib/client-api';
import type { SavedSignature } from '@/features/auth/saved-signature';
import { SignaturePad, type SignatureMethod } from './signature-pad';
import { EmploymentPicker, pickedEmployment, type EmploymentOptions } from './employment-picker';
import { documentItemLabels, fieldLabels, FieldName, itemLabels, RequestableItem, StaffDocuments, type SupportChoice } from './types';
import { Select } from '@/components/ui/field';
type Action='APPROVE'|'REQUEST_CHANGES'|'REJECT';
type Employment={mcName:string;teamLead:string;jobTitle:string};
const titles:Record<Action,string>={APPROVE:'Approve application',REQUEST_CHANGES:'Request corrections',REJECT:'Reject application'};
const employmentFields=['mcName','teamLead','jobTitle'] as const;

/**
 * The decision rail on the application page. The final MC, team lead and job title are confirmed in the rail; Approve
 * opens a dialog for the NDA countersignature (when needed), an internal comment and the final confirmation. With
 * `options` (from an API that has the managed lists) they are picked from the lists; otherwise typed as before.
 * While corrections are outstanding (CHANGES_REQUESTED) the only decision left is rejection; approval waits for a resubmission.
 * A support (`supports`) has no employment and no IT setup: the rail confirms the dispatcher they will assist instead.
 */
export function ReviewActions({id,version,employment:initial,requiredFields,documentsRequired,countersign,status,savedSignature=null,options=null,supports=null}:{id:string;version:number;status?:string;requiredFields:RequestableItem[];documentsRequired:boolean;countersign:StaffDocuments['countersign'];employment:Employment;savedSignature?:SavedSignature|null;options?:EmploymentOptions|null;supports?:SupportChoice|null}) {
 const router=useRouter();
 const [action,setAction]=useState<Action|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[signature,setSignature]=useState<{image:string;method:SignatureMethod}|null>(null),[countersignName,setCountersignName]=useState('');
 const [employment,setEmployment]=useState<Employment>(()=>options?pickedEmployment(options,initial):initial),[employmentConfirmed,setEmploymentConfirmed]=useState(false),[railError,setRailError]=useState('');
 const onSignature=useCallback((image:string|null,method:SignatureMethod)=>setSignature(image?{image,method}:null),[]);
 // A saved signature is offered first; the approver can still sign here instead.
 const [useSaved,setUseSaved]=useState(!!savedSignature);
 function open(next:Action){setAction(next);setError('');setSignature(null);setUseSaved(!!savedSignature);}
 const [supportsId,setSupportsId]=useState(supports?.supportsMemberId??'');
 const dispatcher=supports?.options.find(option=>option.id===supportsId);
 function approve(){
  if(supports){
   if(!supportsId){setRailError('Choose the dispatcher this support will assist.');return;}
   if(!employmentConfirmed){setRailError('Confirm the dispatcher first.');return;}
   setRailError('');open('APPROVE');return;
  }
  if(employmentFields.some(field=>!employment[field].trim())){setRailError(options?'Choose the MC, team and job title.':'Fill in the MC, team lead and job title.');return;}
  if(!employmentConfirmed){setRailError(options?'Confirm the MC, team and job title first.':'Confirm the MC, team lead and job title first.');return;}
  setRailError('');open('APPROVE');
 }
 // Work phones are assigned by IT; only an invalid legacy value is offered for correction.
 const correctable:RequestableItem[]=[...(Object.keys(fieldLabels) as FieldName[]).filter(field=>field!=='workPhoneNumber'||requiredFields.includes(field)),...(documentsRequired?Object.keys(documentItemLabels) as RequestableItem[]:[])];
 async function decide(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy||!action)return;const data=new FormData(event.currentTarget);
  if(action==='REQUEST_CHANGES'&&!data.getAll('requestedFields').length){setError('Select at least one item for the applicant to correct.');return;}
  if(action==='APPROVE'&&countersign&&!useSaved&&!signature){setError('Draw or adopt your signature to countersign the NDA.');return;}
  setBusy(true);setError('');
  try{await mutate(`onboarding/applications/${id}/reviews`,'POST',{version,decisionType:action,reason:String(data.get('reason')??''),requestedFields:data.getAll('requestedFields'),confirmed:data.get('confirmed')==='on',...(supports?{}:{employmentConfirmed}),
   ...(action==='APPROVE'&&supports?{supportsMemberId:supportsId}:{}),
   ...(action==='APPROVE'&&!supports?{employment:{mcName:employment.mcName.trim(),teamLead:employment.teamLead.trim(),jobTitle:employment.jobTitle.trim()}}:{}),
   ...(action==='APPROVE'&&countersign?{countersignature:useSaved?{useSavedSignature:true,agreed:data.get('countersignAgreed')==='on'}:{typedName:countersignName,signature:signature?.image,signatureMethod:signature?.method,agreed:data.get('countersignAgreed')==='on'}}:{})});setAction(null);router.refresh();}
  catch(error){setError(errorMessage(error,'Unable to record decision. Your entries have been kept.'));}finally{setBusy(false);}
 }
 const awaitingCorrections=status==='CHANGES_REQUESTED';
 const blocked=requiredFields.length>0;
 return <>
  <Card>
   <CardHeader title="Your decision" description={awaitingCorrections?'Waiting for the applicant’s corrections.':supports?'Approving adds them as a support. No IT setup.':'Approving sends this dispatcher to IT setup.'}/>
   <CardBody className="space-y-4">
    {awaitingCorrections?<>
     <p className="text-sm leading-6 text-muted-foreground">The applicant has not resubmitted. You can wait, or reject: rejecting closes the application and they can no longer edit it.</p>
     <Button variant="outline" className="w-full text-danger" onClick={()=>open('REJECT')}>Reject</Button>
    </>:<>
     <fieldset className="space-y-4" disabled={blocked}>
      <legend className="sr-only">{supports?'The dispatcher this support assists':'Final employment assignments'}</legend>
      {supports?<>
       <Select label="Supports" name="supportsMemberId" value={supportsId} onChange={event=>{setSupportsId(event.target.value);setEmploymentConfirmed(false);}} placeholder="Choose a dispatcher" required width="full"
        options={supports.options.map(option=>({value:option.id,label:[option.name,option.mc??'Independent',option.team].filter(Boolean).join(' · ')+(option.status==='ONBOARDING'?' (onboarding)':'')}))}
        hint="Supports work where their dispatcher works; they have no MC, team or job title of their own."/>
       <Checkbox name="employmentConfirmed" checked={employmentConfirmed} onChange={event=>setEmploymentConfirmed(event.target.checked)} label="This is the dispatcher they will assist."/>
      </>:options?<EmploymentPicker options={options} original={initial} onChange={setEmployment} disabled={blocked}/>
       :employmentFields.map(field=><Input key={field} label={fieldLabels[field]} name={field} value={employment[field]} onChange={event=>setEmployment(current=>({...current,[field]:event.target.value}))} required maxLength={field==='jobTitle'?100:150} width="full"/>)}
      {!supports&&<Checkbox name="employmentConfirmed" checked={employmentConfirmed} onChange={event=>setEmploymentConfirmed(event.target.checked)} label={options?'The MC, team and job title are correct.':'The MC, team lead and job title are correct.'}/>}
     </fieldset>
     {blocked&&<p className="text-[13px] leading-5 text-warning">Approval needs complete applicant information, photos and signatures. Request corrections for {requiredFields.map(field=>itemLabels[field]).join(', ')}.</p>}
     <Notice message={railError} error/>
     <Button className="w-full" disabled={blocked} onClick={approve}><CircleCheck aria-hidden="true" className="size-4"/>{countersign?'Approve and countersign NDA':'Approve'}</Button>
     <div className="grid grid-cols-2 gap-2"><Button variant="outline" onClick={()=>open('REQUEST_CHANGES')}>Request changes</Button><Button variant="outline" className="text-danger" onClick={()=>open('REJECT')}>Reject</Button></div>
    </>}
   </CardBody>
  </Card>
  {action&&<Dialog open onClose={()=>setAction(null)} busy={busy} title={titles[action]} size={action==='APPROVE'&&countersign?'lg':'md'} tone={action==='REJECT'?'danger':undefined}
  description={action==='REQUEST_CHANGES'?'Your instructions and selected items will be visible to the applicant. Only these items become editable.':action==='APPROVE'?supports?'Approval is final. Supports need no IT setup.':'Approval is final and creates a manual IT onboarding checklist.':awaitingCorrections?'The applicant has not resubmitted; rejecting closes the application and ends their correction access. This cannot be undone. Your internal reason will not be shown to the applicant.':'Rejection closes this application and cannot be undone. Your internal reason will not be shown to the applicant.'}
  actions={<Button form="review-decision" type="submit" variant={action==='REJECT'?'destructive':'default'}>{busy?'Recording decision…':titles[action]}</Button>}>
  <form id="review-decision" onSubmit={decide} className="space-y-5">
   <PendingHint pending={busy}/>
   {action==='APPROVE'&&supports&&<div className="rounded-md bg-muted px-4 py-3 text-sm"><p className="font-medium">Support for {dispatcher?.name ?? 'the chosen dispatcher'}</p><p className="mt-1 text-muted-foreground">{[dispatcher?.mc??'Independent',dispatcher?.team].filter(Boolean).join(' · ')}. No IT setup.</p></div>}
   {action==='APPROVE'&&!supports&&<div className="rounded-md bg-muted px-4 py-3 text-sm"><p className="font-medium">Final assignments</p><p className="mt-1 text-muted-foreground">{employment.mcName.trim()} · {employment.teamLead.trim()} · {employment.jobTitle.trim()}</p></div>}
   {action==='APPROVE'&&countersign&&<fieldset className="space-y-4 border-t border-border pt-5"><legend className="mb-3 text-[15px] font-semibold">Countersign the NDA for the company</legend>
    <p className="text-sm text-muted-foreground"><a className="text-primary underline" href={`/api/backend/onboarding/applications/${id}/documents/${countersign.documentId}/signed`} target="_blank" rel="noopener">Open the applicant-signed {countersign.title} (version {countersign.version})</a></p>
    {useSaved&&savedSignature?<div className="space-y-3">
     {/* eslint-disable-next-line @next/next/no-img-element -- server-provided data URL */}
     <img src={savedSignature.image} alt={`Your saved signature for ${savedSignature.typedName}`} className="h-20 w-auto max-w-full rounded-sm border border-border bg-white p-2"/>
     <p className="text-sm">Signing as <span className="font-medium">{savedSignature.typedName}</span> with your saved signature.</p>
     <Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>setUseSaved(false)}>Sign here instead</Button>
    </div>:<>
    <Input label="Your full legal name" hint="Latin letters, as on your ID." name="countersignName" value={countersignName} onChange={event=>setCountersignName(event.target.value)} required maxLength={100} pattern="[A-Za-z][A-Za-z .,'\-]+" autoComplete="name" width="md"/>
    <SignaturePad label="Your signature" onChange={onSignature} disabled={busy} allowTyped typedName={countersignName}/>
    {savedSignature?<Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>{setUseSaved(true);setSignature(null);}}>Use my saved signature</Button>
     :<p className="text-[13px] leading-5 text-muted-foreground">Tip: save your signature on <a className="text-primary underline" href="/account/security">Account security</a> to skip this step next time.</p>}
    </>}
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
