import { notFound, redirect } from 'next/navigation';
import { Download } from 'lucide-react';
import { apiRequest, requirePage } from '@/lib/auth';
import { memberProfileSchema, readResponse, reviewDetailSchema, savedSignatureSchema } from '@/lib/api-schemas';
import type { SavedSignature } from '@/features/auth/saved-signature';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { LocalTime } from '@/components/ui/local-time';
import { PrivateImage } from '@/components/ui/private-image';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { PageCrumb } from '@/components/shell-context';
import { PageHeader } from '@/components/workspace-ui';
import type { MemberProfile } from '@/features/dispatch/types';
import { ReviewActions } from '@/features/onboarding/review-actions';
import { itemLabels, type ReviewDetail } from '@/features/onboarding/types';
export const metadata = { title: 'Paperwork' };
/** Someone already working here sent their paperwork: their manager checks it and countersigns. Nothing about their job changes. */
export default async function PaperworkReviewPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePage('dispatchers');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const memberResponse = await apiRequest(`dispatch/members/${id}`);
  if (memberResponse.status === 404) notFound();
  if (!memberResponse.ok) throw new Error('Unable to load the dispatcher');
  const member = await readResponse<MemberProfile>(memberResponse, 'dispatcher', memberProfileSchema);
  const applicationId = member.existing?.catchUp?.applicationId;
  // Nothing to review yet, or it's another manager's to check.
  if (!applicationId || !member.existing?.catchUp?.canReview) redirect(`/dispatch/dispatchers/${id}`);
  const response = await apiRequest(`onboarding/applications/${applicationId}`);
  // Sent but never submitted: there is nothing to read yet.
  if (response.status === 409 || response.status === 404) redirect(`/dispatch/dispatchers/${id}`);
  if (!response.ok) throw new Error('Unable to load the paperwork');
  const data = await readResponse<ReviewDetail>(response, 'paperwork', reviewDetailSchema);
  const signatureResponse = data.documents.countersign ? await apiRequest('staff/signature') : null;
  const savedSignature = signatureResponse?.ok ? (await readResponse<{ saved: SavedSignature | null }>(signatureResponse, 'saved signature', savedSignatureSchema)).saved : null;
  const fields = data.application.fields, app = data.application, name = `${member.firstName} ${member.lastName}`;
  const photos = [['selfie', 'Selfie', 'Becomes the profile photo', data.documents.photos.selfie], ['id-selfie', 'Selfie holding ID', 'Only you and administrators', data.documents.photos.idSelfie]] as const;
  return <div className="space-y-6">
    <PageCrumb label={name} />
    <PageHeader title={name} badge={<span className="flex flex-wrap gap-2"><Badge label="Active" tone="success" />{data.canReview ? <Badge label="Paperwork to check" tone="info" /> : app.status === 'APPROVED' ? <Badge label="Paperwork finished" tone="success" /> : <Badge label="Changes asked" tone="warning" />}</span>}
      meta={[[member.current?.mc ?? 'Independent', member.current?.team].filter(Boolean).join(' · '), <>Sent <LocalTime iso={app.submittedAt!} format="date" /></>]} />
    {data.requiredFields.length > 0 && app.status !== 'APPROVED' && <Alert tone="warning" title="Still needed"><p>{data.requiredFields.map(field => itemLabels[field]).join(', ')}</p></Alert>}
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <div className="min-w-0 space-y-6">
        <Card><CardHeader title="Details" description={`What ${member.firstName} sent. Their MC, team and job title don’t change here.`} /><CardBody><DescriptionList items={[{ label: 'First name', value: fields.firstName }, { label: 'Last name', value: fields.lastName }, { label: 'American first name', value: fields.preferredAmericanFirstName }, { label: 'American last name', value: fields.preferredAmericanLastName }, { label: 'Personal phone', value: fields.personalPhoneNumber, mono: true }, { label: 'Personal email', value: data.invitation.email }, { label: 'Telegram', value: fields.telegram }]} /></CardBody></Card>
        {data.documents.required && <Card><CardHeader title="Photos" description="Photos are checked by a person, not software." /><CardBody><div className="grid gap-6 sm:grid-cols-2">{photos.map(([path, label, caption, present]) => <figure key={path} className="space-y-2">
          {present ? <a href={`/api/backend/onboarding/applications/${applicationId}/photos/${path}`} target="_blank" rel="noopener" className="block"><PrivateImage src={`/api/backend/onboarding/applications/${applicationId}/photos/${path}`} alt={label} className="aspect-[4/3] w-full rounded-md border border-border bg-muted object-contain" /></a>
            : <div className="grid aspect-[4/3] place-items-center rounded-md border border-dashed border-border text-sm text-warning">Not uploaded</div>}
          <figcaption><span className="block text-sm font-medium">{label}</span><span className="block text-[13px] text-muted-foreground">{caption}</span></figcaption></figure>)}</div></CardBody></Card>}
        {data.documents.required && <Card><CardHeader title="Documents" description="Documents on file on paper aren’t asked for again." /><Table className="mt-3 border-t border-border" caption={`${name}’s documents`} rows={data.documents.items} rowKey={doc => doc.kind} columns={[
          { key: 'doc', label: 'Document', primary: true, cell: doc => doc.label },
          { key: 'detail', label: 'Detail', cell: doc => doc.applicant ? <>{doc.requiresSignature ? 'Signed' : 'Acknowledged'} <LocalTime iso={doc.applicant.signedAt} format="date" />.{doc.company ? <> Countersigned by {doc.company.typedName}.</> : data.documents.countersign?.documentId === doc.applicant.documentId ? ' Needs your countersignature.' : ''}</> : 'Not signed.' },
          { key: 'status', label: 'Status', cell: doc => doc.applicant ? <Badge label={doc.requiresSignature ? 'Signed' : 'Acknowledged'} tone="success" /> : <Badge label="To sign" tone="warning" /> },
          { key: 'open', label: 'Open', srOnly: true, action: true, cell: doc => doc.applicant && <Button asChild variant="ghost" size="icon"><a href={`/api/backend/onboarding/applications/${applicationId}/documents/${doc.applicant.documentId}/signed`} target="_blank" rel="noopener" aria-label={`Download signed ${doc.label}`}><Download aria-hidden="true" className="size-4" /></a></Button> }]} /></Card>}
      </div>
      <div className="min-w-0 space-y-6 xl:sticky xl:top-6">
        {app.status === 'APPROVED' ? <Alert tone="success" title="Paperwork finished"><p>{member.firstName}’s details and signed copies are on their page.</p></Alert>
          : app.status === 'CHANGES_REQUESTED' ? <Alert tone="info" title="Waiting for their changes"><p>They were asked to correct something. This updates when they send it again.</p></Alert>
          : <ReviewActions id={applicationId} version={app.version} status={app.status} requiredFields={data.requiredFields} documentsRequired={data.documents.required} countersign={data.documents.countersign} savedSignature={savedSignature} employment={{ mcName: '', teamLead: '', jobTitle: '' }} catchUpName={member.firstName} />}
      </div>
    </div>
  </div>;
}
