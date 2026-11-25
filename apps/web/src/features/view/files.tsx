'use client';
import { Eye, Lock } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { LocalTime } from '@/components/ui/local-time';
import { PrivateImage } from '@/components/ui/private-image';
import { Table } from '@/components/ui/table';
import { ViewDocumentButton, type ViewableDocument } from '@/features/documents/document-modal';
import { PhotoButton, type ViewablePhoto } from '@/features/documents/photo-modal';
import { middayIso } from '@/lib/navigation';

/**
 * Photos and documents for someone an administrator gave them (ViewOnlyFilesScreen): the ID photo stays closed until View ID
 * photo, documents open in the viewer, and every opening is recorded by the API. Nothing can be added or replaced.
 */
export interface MemberFiles {
  idPhoto: boolean;
  signed: { id: string; kind: string; title: string; version: number; signedAt: string }[];
  paper: { kind: string; signedOn: string }[];
  scans: { id: string; kind: string; pageCount: number; createdAt: string }[];
}
const KIND: Record<string, string> = { NDA: 'NDA', SOP: 'SOP', CONTACT_LIST: 'Contact list' };

export function MemberFilesView({ memberId, name, photo, files }: { memberId: string; name: string; photo: boolean; files: MemberFiles }) {
  const profileUrl = `/api/backend/member-photos/${memberId}/profile`, idUrl = `/api/backend/member-photos/${memberId}/id`;
  const photos: ViewablePhoto[] = [...(photo ? [{ src: profileUrl, title: 'Profile photo', alt: `Profile photo of ${name}` }] : []), ...(files.idPhoto ? [{ src: idUrl, title: 'ID photo', meta: 'Opening it is recorded with your name.', alt: `ID photo of ${name}` }] : [])];
  const signed: ViewableDocument[] = files.signed.map(doc => ({ url: `/api/backend/view/dispatch/members/${memberId}/documents/${doc.id}/signed`, title: `${KIND[doc.kind] ?? doc.title}`, meta: `Version ${doc.version}`, certificate: true, fallbackName: `${doc.kind.toLowerCase()}-signed.pdf` }));
  const scans: ViewableDocument[] = files.scans.map(scan => ({ url: `/api/backend/view/dispatch/members/${memberId}/paper-scans/${scan.id}/file`, title: `${KIND[scan.kind] ?? scan.kind} signed on paper`, meta: `${scan.pageCount} ${scan.pageCount === 1 ? 'page' : 'pages'}`, fallbackName: `${scan.kind.toLowerCase()}-paper-scan.pdf` }));
  const rows = [...files.signed.map((doc, index) => ({ key: doc.id, name: KIND[doc.kind] ?? doc.title, when: <>{doc.kind === 'CONTACT_LIST' ? 'Read' : 'Signed'} <LocalTime iso={doc.signedAt} format="date" /></>, open: { list: signed, index } })),
    ...files.paper.map(paper => { const index = files.scans.findIndex(scan => scan.kind === paper.kind);
      return { key: `paper-${paper.kind}`, name: KIND[paper.kind] ?? paper.kind, when: <>Signed on paper <LocalTime iso={middayIso(paper.signedOn)} format="date" />{index >= 0 ? '' : ' · no scan'}</>, open: index >= 0 ? { list: scans, index } : null }; })];
  return <div className="space-y-6">
    <Card>
      <CardHeader title="Photos" description="As the applicant sent them, or as an administrator added them." />
      <CardBody>
        <div className="grid gap-4 sm:grid-cols-[repeat(auto-fill,minmax(220px,280px))]">
          <figure className="space-y-2">
            {photo ? <PhotoButton photos={photos} src={profileUrl} label={`Open the profile photo of ${name}`} className="w-full">
              <PrivateImage src={profileUrl} alt={`Profile photo of ${name}`} className="aspect-[4/5] w-full rounded-md border bg-muted object-cover" /></PhotoButton>
              : <div className="grid aspect-[4/5] w-full place-items-center rounded-md border border-dashed bg-muted text-sm text-muted-foreground">Not added yet</div>}
            <figcaption className="text-[13px] leading-5"><span className="font-medium">Profile photo</span><span className="block text-muted-foreground">Shows on their page and the team chart.</span></figcaption>
          </figure>
          <figure className="space-y-2">
            <div className="grid aspect-[4/5] w-full place-items-center gap-2 rounded-md border bg-muted p-4 text-center text-sm text-muted-foreground">
              <Lock aria-hidden="true" className="size-5" />{files.idPhoto ? 'Opens on request' : 'Not added yet'}
              {files.idPhoto && <PhotoButton photos={photos} src={idUrl} label={`View the ID photo of ${name}`} className="cursor-pointer">
                <span className="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent">View ID photo</span></PhotoButton>}
            </div>
            <figcaption className="text-[13px] leading-5"><span className="font-medium">ID photo</span><span className="block text-muted-foreground">Opening it is recorded with your name.</span></figcaption>
          </figure>
        </div>
      </CardBody>
    </Card>
    <Card>
      <CardHeader title="Signed documents" />
      <Table caption="Signed documents" className="mt-3 border-t border-border" rows={rows} rowKey={row => row.key} columns={[
        { key: 'name', label: 'Document', primary: true, cell: row => row.name },
        { key: 'when', label: 'Signed', muted: true, cell: row => row.when },
        { key: 'open', label: 'Actions', srOnly: true, action: true, align: 'right', cell: row => row.open
          ? <ViewDocumentButton documents={row.open.list} index={row.open.index} label={`View ${row.name}`}><Eye aria-hidden="true" className="size-4" />View</ViewDocumentButton> : null },
      ]} empty={<p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">No signed documents on record.</p>} />
    </Card>
  </div>;
}

/** A Safety document a viewer given scans may open (license, medical card, work authorization), a signed consent form, or a unit paper. */
export function OpenFile({ url, title, label }: { url: string; title: string; label: string }) {
  return <ViewDocumentButton documents={[{ url, title, fallbackName: 'document.pdf' }]} label={label}><Eye aria-hidden="true" className="size-4" />View</ViewDocumentButton>;
}
