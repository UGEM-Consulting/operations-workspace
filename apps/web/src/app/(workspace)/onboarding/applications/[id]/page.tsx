import { notFound } from 'next/navigation';
import { Download, FileText } from 'lucide-react';
import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse, reviewDetailSchema, savedSignatureSchema } from '@/lib/api-schemas';
import type { SavedSignature } from '@/features/auth/saved-signature';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { DescriptionList } from '@/components/ui/description-list';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Tabs } from '@/components/ui/tabs';
import { Timeline } from '@/components/ui/timeline';
import { Table } from '@/components/ui/table';
import { decisionTitle, decisionTone } from '@/features/onboarding/history';
import { PrivateImage } from '@/components/ui/private-image';
import { ReviewActions } from '@/features/onboarding/review-actions';
import { TaskStatus } from '@/features/it/types';
import { PageHeader } from '@/components/workspace-ui';
import { PageCrumb } from '@/components/shell-context';
import { Badge, StatusBadge, statusLabel } from '@/components/ui/status-badge';
import { fieldLabels, FieldName, itemLabels, ReviewDetail } from '@/features/onboarding/types';

export const metadata = { title: 'Application' };
/**
 * Application review: the record in tabs on the left (overview, documents, what changed, history) and the decision
 * rail on the right, sticky from 1280px (scrolling on its own when taller than the screen); below that the rail follows the content.
 */
export default async function Page({params}:{params:Promise<{id:string}>}) {
 await requirePage('applications');const {id}=await params;if(!/^[0-9a-f-]{36}$/.test(id))notFound();
 const response=await apiRequest(`onboarding/applications/${id}`);if([404,409].includes(response.status))notFound();if(!response.ok)throw new Error('Unable to load application');
 const data=await readResponse<ReviewDetail>(response,'application review',reviewDetailSchema),app=data.application;
 // The approver's own saved signature, offered when this approval needs an NDA countersignature.
 const signatureResponse=data.documents.countersign?await apiRequest('staff/signature'):null;
 const savedSignature=signatureResponse?.ok?(await readResponse<{saved:SavedSignature|null}>(signatureResponse,'saved signature',savedSignatureSchema)).saved:null;
 // Work phones are assigned by IT; only legacy applications carry an applicant-provided one.
 const personal=(Object.keys(fieldLabels) as FieldName[]).filter(key=>key!=='workPhoneNumber'||!!app.fields.workPhoneNumber).map(key=>[fieldLabels[key],app.fields[key]]);
 const it=data.itOnboarding;
 const fields=[...personal,['Personal email',data.invitation.email]];
 const name=`${app.fields.firstName??''} ${app.fields.lastName??''}`.trim()||'Applicant';
 const decided=[...data.reviews].reverse().find(review=>review.decisionType!=='REQUEST_CHANGES');
 const changes=data.submissions.length-1;

 const overview=<div className="space-y-6">
  {app.status==='RESUBMITTED'&&<Alert tone="info" title="Resubmitted after your change request"><p>See <span className="font-medium">What changed</span> for the updated answers.</p></Alert>}
  {app.status==='CHANGES_REQUESTED'&&<Alert tone="info" title="Waiting for corrections"><p>These are the last submitted answers. The applicant’s saved correction drafts stay private until they resubmit.</p></Alert>}
  {data.requiredFields.length>0&&<Alert tone="warning" title={data.readyForIt?'Historical approval preserved':'Completion required before approval'}><p>{data.requiredFields.map(field=>itemLabels[field]).join(', ')}</p>{data.canReview&&<p className="text-muted-foreground">Request corrections so the applicant can complete these.</p>}</Alert>}
  <Card><CardHeader title="Application details" description="As the applicant sent it."/><CardBody><DescriptionList items={fields.map(([label,value])=>({label:String(label),value}))}/></CardBody></Card>
  {it&&<Card><CardHeader title="Employee details" description="The approved assignments and the accounts IT created."/><CardBody><DescriptionList items={([['Display name',data.itDetails.proposedDisplayName],['MC / Independent',data.invitation.mcName],['Team lead / Independent',data.invitation.teamLead],['Job title',data.invitation.jobTitle],['Company email',it.companyEmail],['Work phone (RingCentral)',it.workPhoneNumber]] as const).map(([label,value])=>({label,value,emptyLabel:'Pending IT setup'}))}/></CardBody></Card>}
  {data.documents.required&&<Card><CardHeader title="Identity photos" description="Check that the face and name match the ID. Photos are checked by a person, not software."/><CardBody>
   <div className="grid gap-6 sm:grid-cols-2">{([['selfie','Selfie','Becomes the profile photo',data.documents.photos.selfie],['id-selfie','Selfie holding ID','Managers and admins only',data.documents.photos.idSelfie]] as const).map(([path,label,caption,present])=><figure key={path} className="space-y-2">
    {present?<a href={`/api/backend/onboarding/applications/${id}/photos/${path}`} target="_blank" rel="noopener" className="block"><PrivateImage src={`/api/backend/onboarding/applications/${id}/photos/${path}`} alt={label} className="aspect-[4/3] w-full rounded-md border border-border bg-muted object-contain"/></a>
     :<div className="grid aspect-[4/3] place-items-center rounded-md border border-dashed border-border text-sm text-warning">Not uploaded</div>}
    <figcaption><span className="block text-sm font-medium">{label}</span><span className="block text-[13px] text-muted-foreground">{caption}</span></figcaption>
   </figure>)}</div>
  </CardBody></Card>}
 </div>;

 const documents=data.documents.required?(data.documents.items.length?<Card><CardHeader title="Signed documents"/><ul className="mt-3 divide-y divide-border border-t border-border">{data.documents.items.map(doc=>{
   const signed=doc.applicant,pending=!!signed&&data.documents.countersign?.documentId===signed.documentId&&!doc.company;
   return <li key={doc.kind} className="flex items-start gap-3 px-4 py-3 sm:px-5">
    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><FileText aria-hidden="true" className="size-4"/></span>
    <div className="min-w-0 flex-1 text-sm"><p className="font-medium">{signed?.title??doc.current.title}</p>
     <p className="text-[13px] leading-5 text-muted-foreground">{doc.label} · version {signed?.version??doc.current.version}{signed&&<> · {doc.requiresSignature?'Signed':'Acknowledged'} by {signed.typedName} <LocalTime iso={signed.signedAt} format="date"/></>}{doc.company&&<> · Countersigned by {doc.company.typedName}</>}</p></div>
    <span className="flex shrink-0 items-center gap-1">{!signed?<Badge label="Not signed" tone="warning"/>:pending?<Badge label="Countersign at approval" tone="warning"/>:<Badge label="Complete" tone="success"/>}
     {signed&&<Button asChild variant="ghost" size="icon"><a href={`/api/backend/onboarding/applications/${id}/documents/${signed.documentId}/signed`} target="_blank" rel="noopener" aria-label={`Download signed ${signed.title}`}><Download aria-hidden="true" className="size-4"/></a></Button>}</span>
   </li>;})}</ul></Card>
  :<Card><EmptyState title="No company documents published" description="Publish the NDA and SOP under Documents before applicants sign."/></Card>)
  :<Card><EmptyState title="Documents are not collected here" description="This workspace has no document storage, so photos and signatures are not required."/></Card>;

 const whatChanged=<div className="space-y-6">{data.submissions.slice(1).map((submission,index)=>{const previous=data.submissions[index];const changed=(Object.keys(fieldLabels) as FieldName[]).filter(key=>(previous.fields[key]??'')!==(submission.fields[key]??''));
  return <Card key={submission.id}><CardHeader title={`Resubmission ${index+1}`} description={<LocalTime iso={submission.createdAt}/>}/>{changed.length?<Table dense caption={`Fields changed in resubmission ${index+1}`} className="mt-3 border-t border-border" rows={changed} rowKey={key=>key} columns={[{key:'field',label:'Field',primary:true,cell:key=><span className="font-medium">{fieldLabels[key]}</span>},{key:'before',label:'Before',muted:true,cell:key=>previous.fields[key]||<span className="italic">Not provided</span>},{key:'after',label:'After',cell:key=>submission.fields[key]||<span className="italic text-muted-foreground">Not provided</span>}]}/>:<CardBody><p className="text-sm text-muted-foreground">No answers changed; photos or signatures may have.</p></CardBody>}</Card>;})}</div>;

 const history=<div className="space-y-6">
  <Card><CardHeader title="Decisions"/><CardBody>{data.reviews.length?<Timeline items={[...data.reviews].reverse().map(review=>({id:review.id,tone:decisionTone(review.decisionType),title:decisionTitle(review),
   meta:<><LocalTime iso={review.createdAt}/> · {statusLabel(review.previousStatus)} → {statusLabel(review.newStatus)}{review.employment&&<><br/>Confirmed assignments: {review.employment.mcName} · {review.employment.teamLead} · {review.employment.jobTitle}</>}{review.requestedFields.length>0&&<><br/>Requested: {review.requestedFields.map(field=>itemLabels[field]).join(', ')}</>}</>,body:review.reason||undefined}))}/>:<p className="text-sm text-muted-foreground">No decisions yet.</p>}</CardBody></Card>
  <Card><CardHeader title="Activity"/><CardBody><Timeline items={[...data.activity].reverse().map(item=>({id:item.id,title:statusLabel(item.event),meta:<LocalTime iso={item.createdAt}/>}))}/></CardBody></Card>
 </div>;

 const outcome=decided&&<Card><CardHeader title="Decision" actions={<StatusBadge status={app.status}/>}/><CardBody className="space-y-3 text-sm">
  <p>{decisionTitle(decided)} on <LocalTime iso={decided.createdAt} format="date"/>.</p>
  {data.readyForIt&&<><p className="text-muted-foreground">{data.invitation.mcName} · {data.invitation.teamLead} · {data.invitation.jobTitle}</p>
   {it?<p className="flex flex-wrap items-center gap-2"><span>IT setup</span><StatusBadge status={it.status as TaskStatus}/></p>:<p className="text-muted-foreground">Approved before IT checklists existed; no IT request is linked.</p>}</>}
 </CardBody></Card>;

 return <div className="space-y-6"><PageCrumb label={name}/>
  <PageHeader title={name} badge={<span className="flex flex-wrap gap-2"><StatusBadge status={app.status}/>{data.invitation.position==='SUPPORT'&&<Badge label="Support" tone="info"/>}</span>}
   meta={[<span key="ref" className="font-mono">{app.id}</span>,app.submittedAt?<>Last submitted <LocalTime iso={app.submittedAt}/></>:'Not submitted yet']}
   action={<CopyButton text={app.id} label="Copy reference"/>}/>
  <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
   <Tabs label="Application sections" items={[{key:'overview',label:'Overview'},{key:'documents',label:'Documents',count:data.documents.required?data.documents.items.length:undefined},
    ...(changes>0?[{key:'changes',label:'What changed',count:changes}]:[]),{key:'history',label:'History'}]}
    panels={{overview,documents,changes:whatChanged,history}}/>
   <aside aria-label="Decision" className="space-y-4 xl:sticky xl:top-20 xl:-mx-1 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:overscroll-contain xl:px-1 xl:pb-1">
    {(data.canReview||data.canReject)&&<ReviewActions id={id} version={app.version} status={app.status} requiredFields={data.requiredFields} documentsRequired={data.documents.required} countersign={data.documents.countersign} savedSignature={savedSignature} options={data.employmentOptions??null} supports={data.supports??null} employment={{mcName:data.invitation.mcName??app.fields.mcName??'',teamLead:data.invitation.teamLead??app.fields.teamLead??'',jobTitle:data.invitation.jobTitle??app.fields.jobTitle??''}}/>}
    {outcome}
    {(data.canReview||data.canReject)&&<Card><CardHeader title="What happens next"/><CardBody className="space-y-2 text-[13px] leading-5 text-muted-foreground">
     <p>{data.invitation.position==='SUPPORT'?'Approving adds them as a support for the dispatcher you confirm. Supports need no IT setup.':'Approving creates an IT setup checklist. You get a notification here when the dispatcher’s accounts are ready.'}</p>
     <p>The applicant gets a short email or Telegram update with the outcome only; your reasons and notes are never included.</p>
    </CardBody></Card>}
   </aside>
  </div>
 </div>;
}
