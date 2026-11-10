'use client';
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { useToast } from '@/components/ui/toast';
import { Checkbox, Input, Textarea,RadioGroup } from '@/components/ui/field';
import { PendingHint } from '@/components/ui/pending-hint';
import { errorMessage, mutate } from '@/lib/client-api';
import type { SavedSignature } from '@/features/auth/saved-signature';
import { LATIN_NAME, type SignatureMethod } from './signature-pad';
import { CountersignModal } from '@/features/documents/countersign-modal';
import { roleLabel } from '@/components/ui/status-badge';
import { shortName } from '@/features/documents/signed-documents';
import { EmploymentPicker, pickedEmployment, type EmploymentOptions } from './employment-picker';
import { documentItemLabels, fieldLabels, FieldName, itemLabels, RequestableItem, StaffDocuments, type SupportChoice } from './types';
import { Select } from '@/components/ui/field';
import { supportName, supportWord, underMc } from '@/features/dispatch/types';
import { SUPPORT_IT_ITEMS, SupportItChoices, type SupportItItem } from '@/features/dispatch/support-it';
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
export function ReviewActions({id,version,employment:initial,requiredFields,documentsRequired,countersign,documentItems=[],status,savedSignature=null,options=null,supports=null,catchUpName=null}:{catchUpName?:string|null;id:string;version:number;status?:string;requiredFields:RequestableItem[];documentsRequired:boolean;countersign:StaffDocuments['countersign'];documentItems?:StaffDocuments['items'];employment:Employment;savedSignature?:SavedSignature|null;options?:EmploymentOptions|null;supports?:SupportChoice|null}) {
 const router=useRouter();
 const [action,setAction]=useState<Action|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[signature,setSignature]=useState<{image:string;method:SignatureMethod}|null>(null),[countersignName,setCountersignName]=useState(LATIN_NAME.test(countersign?.signerName??'')?countersign!.signerName!:''),[countersignTitle,setCountersignTitle]=useState(countersign?.lastTitle??(countersign?.signerRole?roleLabel(countersign.signerRole):'')),[countersigned,setCountersigned]=useState(false),[reading,setReading]=useState(false),[saveForLater,setSaveForLater]=useState(false);
 const toast=useToast();
 const [employment,setEmployment]=useState<Employment>(()=>options?pickedEmployment(options,initial):initial),[employmentConfirmed,setEmploymentConfirmed]=useState(false),[railError,setRailError]=useState('');
 // The tick to save a signature adopts that exact image, so any change to it asks again.
 const onSignature=useCallback((image:string|null,method:SignatureMethod)=>{setSignature(image?{image,method}:null);setSaveForLater(false);},[]);
 // A saved signature is offered first; the approver can still sign here instead.
 const [useSaved,setUseSaved]=useState(!!savedSignature);
 function open(next:Action){setAction(next);setError('');setSignature(null);setCountersigned(false);setUseSaved(!!savedSignature);setSaveForLater(false);}
 const signedItem=countersign&&documentItems.find(item=>item.applicant?.documentId===countersign.documentId),signedRecord=signedItem?signedItem.applicant:null;
 const signedOn=signedRecord?new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'America/New_York'}).format(new Date(signedRecord.signedAt)):'';
 // The title goes on the record only when the form asked for it and the approver saw it.
 const titleAsked=!!countersign?.fields?.some(field=>field.signer==='COMPANY'&&field.kind==='TITLE');
 const [supportsId,setSupportsId]=useState(supports?.supportsMemberId??''),[supportType,setSupportType]=useState<'SUPPORT'|'UPDATER'>(supports?.supportType??'SUPPORT');
 const [assisting,setAssisting]=useState(supports?.supportsTeamId?'TEAM':'DISPATCHER'),[supportsTeamId,setSupportsTeamId]=useState(supports?.supportsTeamId??'');
 // What IT is asked to set up for them (section 32): nothing unless ticked, and only when the API offers it.
 const [itSetup,setItSetup]=useState<SupportItItem[]>([]),itOffered=!!supports?.itSetupItems?.length;
 const wholeTeam=assisting==='TEAM',dispatcher=supports?.options.find(option=>option.id===supportsId),team=supports?.teamOptions?.find(option=>option.id===supportsTeamId);
 function approve(){
  if(catchUpName){setRailError('');open('APPROVE');return;}
  if(supports){
   if(wholeTeam?!supportsTeamId:!supportsId){setRailError(`Choose the ${wholeTeam?'team':'dispatcher'} this ${supportWord({supportType})} will assist.`);return;}
   if(wholeTeam&&team?.archived){setRailError('This team was archived. Choose another team.');return;}
   if(!employmentConfirmed){setRailError(`Confirm the ${wholeTeam?'team':'dispatcher'} first.`);return;}
   setRailError('');open('APPROVE');return;
  }
  if(employmentFields.some(field=>!employment[field].trim())){setRailError(options?'Choose the MC, team and job title.':'Fill in the MC, team lead and job title.');return;}
  if(!employmentConfirmed){setRailError(options?'Confirm the MC, team and job title first.':'Confirm the MC, team lead and job title first.');return;}
  setRailError('');open('APPROVE');
 }
 // Work phones are assigned by IT; only an invalid legacy value is offered for correction.
 const correctable:RequestableItem[]=[...(Object.keys(fieldLabels) as FieldName[]).filter(field=>(field!=='workPhoneNumber'||requiredFields.includes(field))&&!(catchUpName&&(employmentFields as readonly string[]).includes(field))),...(documentsRequired?Object.keys(documentItemLabels) as RequestableItem[]:[])];
 async function decide(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy||!action)return;const data=new FormData(event.currentTarget);
  if(action==='REQUEST_CHANGES'&&!data.getAll('requestedFields').length){setError('Select at least one item for the applicant to correct.');return;}
  if(action==='APPROVE'&&countersign&&!countersigned){setError('Read and countersign the NDA first.');return;}
  setBusy(true);setError('');
  try{await mutate(`onboarding/applications/${id}/reviews`,'POST',{version,decisionType:action,reason:String(data.get('reason')??''),requestedFields:data.getAll('requestedFields'),confirmed:data.get('confirmed')==='on',...(supports||catchUpName?{}:{employmentConfirmed}),
   ...(action==='APPROVE'&&supports?{...(wholeTeam?{supportsTeamId}:{supportsMemberId:supportsId}),...(supportType!==(supports.supportType??'SUPPORT')?{supportType}:{}),...(itOffered&&itSetup.length?{itSetup}:{})}:{}),
   ...(action==='APPROVE'&&!supports&&!catchUpName?{employment:{mcName:employment.mcName.trim(),teamLead:employment.teamLead.trim(),jobTitle:employment.jobTitle.trim()}}:{}),
   ...(action==='APPROVE'&&countersign?{countersignature:{...(useSaved?{useSavedSignature:true}:{typedName:countersignName,signature:signature?.image,signatureMethod:signature?.method}),agreed:true,...(titleAsked&&countersignTitle.trim()?{title:countersignTitle.trim()}:{})}}:{})});
   // Only once the approval has gone through, and a failed save never affects it.
   if(action==='APPROVE'&&countersign&&saveForLater&&!useSaved&&!savedSignature&&signature){
    try{await mutate('staff/signature','POST',{typedName:countersignName,signature:signature.image,signatureMethod:signature.method,agreed:true});toast({title:'Signature saved',description:'You can use it for your next approvals.'});}
    catch{toast({title:'Your signature wasn’t saved',description:'The approval went through. You can save a signature on Account security.'});}
   }
   setAction(null);router.refresh();}
  catch(error){setError(errorMessage(error,'Unable to record decision. Your entries have been kept.'));}finally{setBusy(false);}
 }
 const awaitingCorrections=status==='CHANGES_REQUESTED';
 const blocked=requiredFields.length>0;
 return <>
  <Card>
   <CardHeader title="Your decision" description={catchUpName?`Accepting finishes ${catchUpName}’s paperwork. It doesn’t change their job, and they aren’t messaged.`:awaitingCorrections?'Waiting for the applicant’s corrections.':supports?'Approving adds them as a support. No IT setup.':'Approving sends this dispatcher to IT setup.'}/>
   <CardBody className="space-y-4">
    {catchUpName?<>
     {blocked&&<p className="text-[13px] leading-5 text-warning">This needs complete details, photos and signatures. Ask for changes for {requiredFields.map(field=>itemLabels[field]).join(', ')}.</p>}
     <Button className="w-full" disabled={blocked} onClick={approve}><CircleCheck aria-hidden="true" className="size-4"/>{countersign?'Accept and countersign NDA':'Accept paperwork'}</Button>
     <Button variant="outline" className="w-full" onClick={()=>open('REQUEST_CHANGES')}>Ask for changes</Button>
     <p className="text-[13px] leading-5 text-muted-foreground">Asking for changes sends the usual email, with the way back.</p>
    </>:awaitingCorrections?<>
     <p className="text-sm leading-6 text-muted-foreground">The applicant has not resubmitted. You can wait, or reject: rejecting closes the application and they can no longer edit it.</p>
     <Button variant="outline" className="w-full text-danger" onClick={()=>open('REJECT')}>Reject</Button>
    </>:<>
     <fieldset className="space-y-4" disabled={blocked}>
      <legend className="sr-only">{supports?'Who this support assists':'Final employment assignments'}</legend>
      {supports?<>
       <Select label="Position" name="supportType" value={supportType} onChange={event=>setSupportType(event.target.value as 'SUPPORT'|'UPDATER')} width="full" options={[{value:'SUPPORT',label:'Support'},{value:'UPDATER',label:'Updater'}]}/>
       {!!supports.teamOptions&&<RadioGroup name="assisting" label="They assist" value={assisting} onChange={value=>{setAssisting(value);setEmploymentConfirmed(false);}} options={[{value:'DISPATCHER',label:'One dispatcher'},{value:'TEAM',label:'A whole team',description:'Everyone on the team, with no one dispatcher.'}]}/>}
       {wholeTeam?<Select label="Team" name="supportsTeamId" value={supportsTeamId} onChange={event=>{setSupportsTeamId(event.target.value);setEmploymentConfirmed(false);}} placeholder="Choose a team" required width="full"
        options={(supports.teamOptions??[]).map(option=>({value:option.id,label:[option.name,option.mc].filter(Boolean).join(' · ')+(option.archived?' (archived)':'')}))} hint="They work where the team works, with no MC or job title of their own."/>
       :<Select label="Dispatcher they assist" name="supportsMemberId" value={supportsId} onChange={event=>{setSupportsId(event.target.value);setEmploymentConfirmed(false);}} placeholder="Choose a dispatcher" required width="full"
        options={supports.options.map(option=>({value:option.id,label:[option.name,option.mc??'No MC yet',underMc(option.mc)?option.team??'Independent':null].filter(Boolean).join(' · ')+(option.leaving?' (leaving)':option.status==='ONBOARDING'?' (onboarding)':'')}))}
        hint="They work where their dispatcher works, with no MC, team or job title of their own."/>}
       {itOffered&&<div className="space-y-3 rounded-md border border-border p-4">
        <div><p className="text-sm font-semibold">Ask IT to set up (optional)</p><p className="text-[13px] leading-5 text-muted-foreground">Only what they need. Most supports work with their dispatcher’s accounts.</p></div>
        <SupportItChoices value={itSetup} onChange={setItSetup} disabled={blocked}/>
        {itSetup.length>0&&<p className="text-[13px] leading-5 text-muted-foreground">IT gets an alert and a checklist with {itSetup.length===1?'this':'these '+itSetup.length}. You can ask for more later from their page.</p>}
       </div>}
       <Checkbox name="employmentConfirmed" checked={employmentConfirmed} onChange={event=>setEmploymentConfirmed(event.target.checked)} label={wholeTeam?'This is the team they will assist.':'This is the dispatcher they will assist.'}/>
      </>:options?<EmploymentPicker options={options} original={initial} onChange={next=>{setEmployment(next);setEmploymentConfirmed(false);}} disabled={blocked}/>
       :employmentFields.map(field=><Input key={field} label={fieldLabels[field]} name={field} value={employment[field]} onChange={event=>{const value=event.target.value;setEmployment(current=>({...current,[field]:value}));setEmploymentConfirmed(false);}} required maxLength={field==='jobTitle'?100:150} width="full"/>)}
      {!supports&&<Checkbox name="employmentConfirmed" checked={employmentConfirmed} onChange={event=>setEmploymentConfirmed(event.target.checked)} label={options?'The MC, team and job title are correct.':'The MC, team lead and job title are correct.'}/>}
     </fieldset>
     {blocked&&<p className="text-[13px] leading-5 text-warning">Approval needs complete applicant information, photos and signatures. Request corrections for {requiredFields.map(field=>itemLabels[field]).join(', ')}.</p>}
     <Notice message={railError} error/>
     <Button className="w-full" disabled={blocked} onClick={approve}><CircleCheck aria-hidden="true" className="size-4"/>{countersign?'Approve and countersign NDA':'Approve'}</Button>
     <div className="grid grid-cols-2 gap-2"><Button variant="outline" onClick={()=>open('REQUEST_CHANGES')}>Request changes</Button><Button variant="outline" className="text-danger" onClick={()=>open('REJECT')}>Reject</Button></div>
    </>}
   </CardBody>
  </Card>
  {action&&<Dialog open onClose={()=>setAction(null)} busy={busy} title={catchUpName?(action==='APPROVE'?'Accept paperwork':'Ask for changes'):titles[action]} size={action==='APPROVE'&&countersign?'lg':'md'} tone={action==='REJECT'?'danger':undefined}
  description={catchUpName&&action==='APPROVE'?'This finishes their paperwork and can’t be undone. There’s no IT setup, and they aren’t messaged.':action==='REQUEST_CHANGES'?'Your instructions and selected items will be visible to the applicant. Only these items become editable.':action==='APPROVE'?supports?'Approval is final. Supports need no IT setup.':'Approval is final and creates a manual IT onboarding checklist.':awaitingCorrections?'The applicant has not resubmitted; rejecting closes the application and ends their correction access. This cannot be undone. Your internal reason will not be shown to the applicant.':'Rejection closes this application and cannot be undone. Your internal reason will not be shown to the applicant.'}
  actions={<Button form="review-decision" type="submit" variant={action==='REJECT'?'destructive':'default'}>{busy?'Recording decision…':catchUpName?(action==='APPROVE'?'Accept paperwork':'Ask for changes'):titles[action]}</Button>}>
  <form id="review-decision" onSubmit={decide} className="space-y-5">
   <PendingHint pending={busy}/>
   {action==='APPROVE'&&supports&&<div className="rounded-md bg-muted px-4 py-3 text-sm"><p className="font-medium">{supportName({supportType})} for {wholeTeam?(team?.name??'the chosen team'):(dispatcher?.name??'the chosen dispatcher')}</p><p className="mt-1 text-muted-foreground">{wholeTeam?team?.mc:(underMc(dispatcher?.mc)?`${dispatcher!.mc} · ${dispatcher!.team??'Independent'}`:'No MC yet')}. {itOffered&&itSetup.length?`IT sets up: ${SUPPORT_IT_ITEMS.filter(item=>itSetup.includes(item.key)).map(item=>item.label.toLowerCase()).join(', ')}.`:'No IT setup.'}</p></div>}
   {action==='APPROVE'&&!supports&&!catchUpName&&<div className="rounded-md bg-muted px-4 py-3 text-sm"><p className="font-medium">Final assignments</p><p className="mt-1 text-muted-foreground">{employment.mcName.trim()} · {employment.teamLead.trim()} · {employment.jobTitle.trim()}</p></div>}
   {action==='APPROVE'&&countersign&&<div className="space-y-3 rounded-md border border-border p-4"><p className="text-[15px] font-semibold">Countersign the NDA for the company</p>
    {countersigned?<p className="flex items-center gap-2 text-sm text-success"><CircleCheck aria-hidden="true" className="size-4"/>Ready. It’s added when you approve.</p>:<p className="text-sm text-muted-foreground">Read the signed {countersign.title} and sign it for UGEM.</p>}
    <Button type="button" variant={countersigned?'outline':'default'} disabled={busy} onClick={()=>{setCountersigned(false);setReading(true);}}>{countersigned?'Review the countersignature':'Read and countersign'}</Button>
   </div>}
   <Textarea name="reason" label={action==='REQUEST_CHANGES'?'Instructions for the applicant':action==='REJECT'?'Reason for rejection':'Internal comment'} optional={action==='APPROVE'} required={action!=='APPROVE'} maxLength={2000} hint={action==='REQUEST_CHANGES'?'The applicant sees this message.':'Visible to staff only. The applicant never sees it.'}/>
   {action==='REQUEST_CHANGES'?<fieldset className="space-y-3"><legend className="mb-1 text-sm font-medium">Items to correct</legend><p className="text-[13px] leading-5 text-muted-foreground">Choose at least one; only these become editable.{requiredFields.length>0&&' Missing required items are already selected.'}</p><div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{correctable.map(field=><Checkbox key={field} name="requestedFields" value={field} defaultChecked={requiredFields.includes(field)} label={itemLabels[field]}/>)}</div></fieldset>:<Checkbox name="confirmed" required label={catchUpName?'I’ve checked this paperwork. This can’t be reopened.':`I confirm this ${action==='APPROVE'?'approval':'rejection'}. This decision cannot be reopened.`}/>}
   <Notice message={error} error/>
   {error&&<p className="text-sm text-muted-foreground">If another reviewer changed this application, close this dialog and reload its latest details before trying again.</p>}
  </form>
  </Dialog>}
  {reading&&countersign&&<CountersignModal url={`/api/backend/onboarding/applications/${id}/documents/${countersign.documentId}/signed`} title={signedItem&&signedRecord?`${shortName(signedItem)} · ${signedRecord.typedName}`:countersign.title} meta={signedRecord?`Signed by ${signedRecord.typedName}, ${signedOn}`:'Signed by the applicant'} statement={countersign.statement} fields={countersign.fields??[]} savedSignature={savedSignature} useSaved={useSaved} onUseSaved={value=>{setUseSaved(value);setSignature(null);setCountersigned(false);}}
   name={countersignName} onName={setCountersignName} signature={signature} onSignature={onSignature} jobTitle={countersignTitle} onJobTitle={setCountersignTitle} saveForLater={saveForLater} onSaveForLater={setSaveForLater} onDone={()=>{setCountersigned(true);setReading(false);setError('');}} onClose={()=>setReading(false)}/>}
 </>;
}
