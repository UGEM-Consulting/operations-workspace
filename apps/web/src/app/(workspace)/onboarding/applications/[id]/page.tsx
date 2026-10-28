import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse, reviewDetailSchema, savedSignatureSchema } from '@/lib/api-schemas';
import type { SavedSignature } from '@/features/auth/saved-signature';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { LocalTime } from '@/components/ui/local-time';
import { Timeline } from '@/components/ui/timeline';
import { Table } from '@/components/ui/table';
import { decisionTitle, decisionTone } from '@/features/onboarding/history';
import { PrivateImage } from '@/components/ui/private-image';
import { ReviewActions } from '@/features/onboarding/review-actions';
import { TaskStatus } from '@/features/it/types';
import { PageHeader } from '@/components/workspace-ui';
import { StatusBadge, statusLabel } from '@/components/ui/status-badge';
import { fieldLabels, FieldName, itemLabels, ReviewDetail } from '@/features/onboarding/types';
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
 return <div className="space-y-6"><Link href="/onboarding/applications" className="text-sm text-primary underline">Back to applications</Link>
  <PageHeader eyebrow="Application review" title={`${app.fields.firstName??''} ${app.fields.lastName??''}`} description={app.submittedAt?<>Last submitted <LocalTime iso={app.submittedAt}/></>:'Not submitted yet'} action={<StatusBadge status={app.status}/>}/>
  {data.readyForIt&&<Alert tone="success" title="Approved · IT onboarding"><p>{data.invitation.mcName} · {data.invitation.teamLead} · {data.invitation.jobTitle}</p><p className="text-muted-foreground">{data.itOnboarding?'IT owns the setup checklist. Its progress is separate from application approval.':'This application was approved before IT checklists were introduced. No IT request is linked.'}</p>{it&&<p className="flex items-center gap-2"><span>IT setup:</span><StatusBadge status={it.status as TaskStatus}/></p>}</Alert>}
  {it&&<Card><CardHeader title="Employee details"/><CardBody><DescriptionList items={([['Display name',data.itDetails.proposedDisplayName],['MC / Independent',data.invitation.mcName],['Team lead / Independent',data.invitation.teamLead],['Job title',data.invitation.jobTitle],['Company email',it.companyEmail],['Work phone (RingCentral)',it.workPhoneNumber]] as const).map(([label,value])=>({label,value,emptyLabel:'Pending IT setup'}))}/></CardBody></Card>}
  {app.status==='CHANGES_REQUESTED'&&<Alert tone="info"><p>Waiting for applicant corrections. The values below are the last submitted version; saved correction drafts remain private.</p></Alert>}
  <Card><CardHeader title="Applicant-provided information"/><CardBody><DescriptionList items={fields.map(([label,value])=>({label:String(label),value}))}/></CardBody></Card>
  {data.documents.required&&<Card><CardHeader title="Photos & signed documents"/><CardBody className="space-y-6">
   <div className="grid gap-6 sm:grid-cols-2">{([['selfie','Selfie (profile photo)',data.documents.photos.selfie],['id-selfie','Selfie holding ID: compare the face with the ID photo and check the name',data.documents.photos.idSelfie]] as const).map(([path,label,present])=><figure key={path} className="space-y-2"><figcaption className="text-sm text-muted-foreground">{label}</figcaption>{present?<a href={`/api/backend/onboarding/applications/${id}/photos/${path}`} target="_blank" rel="noopener"><PrivateImage src={`/api/backend/onboarding/applications/${id}/photos/${path}`} alt={label.split(':')[0]} className="max-h-72 rounded-md border object-contain"/></a>:<p className="text-sm text-warning">Not uploaded</p>}</figure>)}</div>
   {data.documents.items.length>0&&<ul className="space-y-3">{data.documents.items.map(doc=><li key={doc.kind} className="rounded-md border border-border p-4 text-sm"><p className="font-medium">{doc.applicant?.title??doc.current.title} <span className="font-normal text-muted-foreground">· {doc.label} · version {doc.applicant?.version??doc.current.version}</span></p>{doc.applicant?<><p className="mt-1">{doc.requiresSignature?'Signed':'Acknowledged'} by {doc.applicant.typedName} on <LocalTime iso={doc.applicant.signedAt}/></p>{doc.company&&<p>Countersigned by {doc.company.typedName} on <LocalTime iso={doc.company.signedAt}/></p>}<a className="mt-2 inline-block text-primary underline" href={`/api/backend/onboarding/applications/${id}/documents/${doc.applicant.documentId}/signed`} target="_blank" rel="noopener">Download signed copy</a></>:<p className="mt-1 text-warning">Not signed yet</p>}</li>)}</ul>}
  </CardBody></Card>}
  {data.requiredFields.length>0&&<Alert tone="warning" title={data.readyForIt?'Historical approval preserved':'Completion required before approval'}><p>{data.requiredFields.map(field=>itemLabels[field]).join(', ')}</p>{data.canReview&&<p className="text-muted-foreground">Request corrections so the applicant can complete these fields.</p>}</Alert>}
  {(data.canReview||data.canReject)&&<Card><CardHeader title="Review decision"/><CardBody><ReviewActions id={id} version={app.version} status={app.status} requiredFields={data.requiredFields} documentsRequired={data.documents.required} countersign={data.documents.countersign} savedSignature={savedSignature} employment={{mcName:data.invitation.mcName??app.fields.mcName??'',teamLead:data.invitation.teamLead??app.fields.teamLead??'',jobTitle:data.invitation.jobTitle??app.fields.jobTitle??''}}/></CardBody></Card>}
  <Card><CardHeader title="Review history"/><CardBody>{data.reviews.length?<Timeline items={[...data.reviews].reverse().map(review=>({id:review.id,tone:decisionTone(review.decisionType),title:decisionTitle(review),
   meta:<><LocalTime iso={review.createdAt}/> · {statusLabel(review.previousStatus)} → {statusLabel(review.newStatus)}{review.employment&&<><br/>Confirmed assignments: {review.employment.mcName} · {review.employment.teamLead} · {review.employment.jobTitle}</>}{review.requestedFields.length>0&&<><br/>Requested: {review.requestedFields.map(field=>itemLabels[field]).join(', ')}</>}</>,body:review.reason||undefined}))}/>:<p className="text-sm text-muted-foreground">No review decisions yet.</p>}</CardBody></Card>
  <Card><CardHeader title="Submitted changes"/><CardBody className="space-y-5">{data.submissions.length<2?<p className="text-sm text-muted-foreground">This is the first submission.</p>:data.submissions.slice(1).map((submission,index)=>{const previous=data.submissions[index];const changed=(Object.keys(fieldLabels) as FieldName[]).filter(key=>(previous.fields[key]??'')!==(submission.fields[key]??''));return <section key={submission.id} className="space-y-3"><h3 className="text-sm font-medium">Resubmission {index+1} · <LocalTime iso={submission.createdAt}/></h3>{changed.length?<div className="overflow-hidden rounded-md border border-border"><Table dense caption={`Fields changed in resubmission ${index+1}`} rows={changed} rowKey={key=>key} columns={[{key:'field',label:'Field',primary:true,cell:key=><span className="font-medium">{fieldLabels[key]}</span>},{key:'before',label:'Previously submitted',muted:true,cell:key=>previous.fields[key]||<span className="italic">Not provided</span>},{key:'after',label:'Resubmitted value',cell:key=>submission.fields[key]||<span className="italic text-muted-foreground">Not provided</span>}]}/></div>:<p className="text-sm text-muted-foreground">No personal fields changed in this resubmission.</p>}</section>;})}</CardBody></Card>
  <Card><CardHeader title="Activity"/><CardBody><Timeline items={[...data.activity].reverse().map(item=>({id:item.id,title:statusLabel(item.event),meta:<LocalTime iso={item.createdAt}/>}))}/></CardBody></Card>
  <p className="text-sm text-muted-foreground">Photos are checked by people only; no face recognition is used. When you approve, request changes or reject, the applicant gets a short email or Telegram update with the outcome only; your reasons and notes are never included.</p>
 </div>;
}
