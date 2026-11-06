'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Upload } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Badge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { mutate } from '@/lib/client-api';
import { fileToBase64, MAX_PDF_BYTES } from '@/lib/files';
import { ViewDocumentButton } from '@/features/documents/document-modal';
import { FieldPlacer } from '@/features/documents/field-placer';
import { fieldLabels, type DocumentField } from '@/features/documents/fields';

export interface ConsentVersion { id: string; kind: string; version: number; title: string; sha256: string; pageCount: number; createdAt: string; uploader: string | null; fields?: DocumentField[] }
export interface ConsentList { storageEnabled: boolean; canPublish: boolean; kinds: { kind: string; label: string; signature: boolean; versions: ConsentVersion[] }[];
  // From an API with notice letters; absent on an older one.
  letters?: { kind: 'PRE_ADVERSE' | 'FINAL'; label: string; versions: ConsentVersion[] }[] }
const hints: Record<string, string> = {
  BACKGROUND_DISCLOSURE: 'The standalone disclosure that a background check, including the MVR, may be obtained.',
  BACKGROUND_AUTHORIZATION: 'The driver’s written authorization to obtain those reports. Required before Safety pulls an MVR.',
  CLEARINGHOUSE_CONSENT: 'The driver’s consent to the FMCSA Clearinghouse limited query.',
  PRE_ADVERSE: 'Sent before a rejection based on the MVR or background report. Your adviser’s letter, with the driver’s name, address and the date filled in. The summary of rights goes inside it.',
  FINAL: 'The final adverse action notice: the decision, the reporting company’s contact details and the driver’s right to dispute. Name, address and date filled in.',
};
type Publishing = { kind: string; label: string; letter: boolean; signature: boolean; versions: ConsentVersion[] };
const pages = (count: number) => `${count} ${count === 1 ? 'page' : 'pages'}`;

/**
 * Safety › Forms and letters (designed as NoticeLettersScreen): the consent forms drivers sign in their application, and
 * the pre-adverse and final notice letters Safety sends. Each upload publishes a new, permanent version, with the places
 * to fill in marked on it (NoticeLetterPlaceScreen); the legal text is always the PDF's.
 */
export function ConsentForms({ initial }: { initial: ConsentList }) {
  const router = useRouter();
  const toast = useToast();
  const [publishing, setPublishing] = useState<Publishing | null>(null);
  const [error, setError] = useState('');
  const [placing, setPlacing] = useState<{ title: string; file: File } | null>(null);
  async function send(title: string, file: File, fields: DocumentField[]) {
    if (!publishing) return;
    const published = await mutate<ConsentVersion>(publishing.letter ? 'safety/letters' : 'safety/consents', 'POST', { kind: publishing.kind, title, file: await fileToBase64(file), fields });
    toast({ title: publishing.letter ? 'Letter published' : 'Form published', description: `${published.title} is now version ${published.version}.` });
    setPublishing(null); setPlacing(null); router.refresh();
  }
  async function publish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publishing) return;
    const form = new FormData(event.currentTarget), file = form.get('file');
    if (!(file instanceof File) || file.type !== 'application/pdf') { setError('Choose a PDF file.'); return; }
    if (file.size > MAX_PDF_BYTES) { setError('The PDF must be 3 MB or smaller. Compress it and try again.'); return; }
    setError(''); setPlacing({ title: String(form.get('title') ?? ''), file });
  }
  const start = (item: Publishing) => { setPublishing(item); setError(''); };
  const publishButton = (item: Publishing) => initial.canPublish && <Button size="sm" variant={item.versions[0] ? 'outline' : 'default'} disabled={!initial.storageEnabled} onClick={() => start(item)}>
    <Upload aria-hidden="true" className="size-4" />{item.versions[0] ? 'Publish new version' : 'Publish'}<span className="sr-only"> of the {item.label.toLowerCase()}</span></Button>;
  const fileUrl = (item: Publishing, version: ConsentVersion) => `/api/backend/safety/${item.letter ? 'letters' : 'consents'}/${version.id}/file`;
  // The current version (a link that opens it) and any earlier ones.
  const versions = (item: Publishing) => <div className="space-y-1">
    {item.versions.map((version, index) => <p key={version.id} className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
      <ViewDocumentButton variant="link" size="sm" className="text-[13px]" documents={[{ url: fileUrl(item, version), title: version.title, meta: `Version ${version.version}` }]}>{version.title}</ViewDocumentButton>
      <span>version {version.version}</span>{index === 0 && <Badge label="Current" tone="success" />}
      <span>· {pages(version.pageCount)}{item.letter && version.fields ? ` · fields: ${[...new Set(version.fields.map(field => fieldLabels[field.kind].toLowerCase()))].join(', ') || 'none'}` : ''} · {version.uploader ?? 'A former account'} · <LocalTime iso={version.createdAt} format="date" /></span>
    </p>)}</div>;
  const consents: Publishing[] = initial.kinds.map(item => ({ ...item, letter: false }));
  const letters: Publishing[] = (initial.letters ?? []).map(item => ({ ...item, letter: true, signature: false }));
  return <div className="space-y-6">
    <PageHeader title="Forms and letters" description="Publish the final PDFs your legal or compliance adviser approved. The workspace adds no legal text of its own; it only fills in the driver’s details where you place them." />
    {!initial.storageEnabled && <Alert tone="warning" title="Document storage is not configured"><p>Nothing can be published, and drivers aren’t asked to sign.</p></Alert>}
    <Card>
      <CardHeader title="Consent forms" description="Signed by drivers in their application: background check disclosure, authorization and Clearinghouse consent." />
      <ul className="mt-3 divide-y divide-border border-t border-border">{consents.map(item => <li key={item.kind} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{item.label}</p>
          <p className="text-[13px] text-muted-foreground">{hints[item.kind]} {item.signature ? 'Typed name and a drawn or typed signature.' : 'Acknowledged as read.'}</p>
          {item.versions.length ? <div className="mt-1">{versions(item)}</div> : <p className="mt-1 text-[13px] text-muted-foreground">Not published. Drivers aren’t asked to sign it until a version is published.</p>}
        </div>
        {publishButton(item)}
      </li>)}</ul>
    </Card>
    {letters.map(item => <Card key={item.kind}>
      <CardHeader title={item.label} description={hints[item.kind]} actions={publishButton(item)} />
      <div className="px-4 pb-4 sm:px-5 sm:pb-5">{item.versions.length ? versions(item)
        : <p className="text-sm text-muted-foreground">Not published. Until it is, Safety writes the {item.kind === 'FINAL' ? 'final' : 'pre-adverse'} letter outside the workspace, as today.</p>}</div>
    </Card>)}
    {publishing && placing && <FieldPlacer file={placing.file} title={placing.title} signerLabel="The driver" signature={publishing.signature} letter={publishing.letter}
      initial={publishing.versions[0]?.fields ?? []} onBack={() => setPlacing(null)} onPublish={fields => send(placing.title, placing.file, fields)} />}
    {publishing && !placing && <Dialog open title={`Publish the ${publishing.label.toLowerCase()}`} onClose={() => setPublishing(null)}
      description={publishing.letter ? 'Upload the final PDF (3 MB maximum), then mark where the driver’s name, address and the date go. It can’t be edited or deleted after publishing; upload a new version instead.'
        : 'Upload the final PDF (3 MB maximum). It can’t be edited or deleted after publishing; upload a new version instead. Drivers who haven’t submitted yet sign the new version.'}
      actions={<Button form="publish-consent" type="submit">Next: place the fields</Button>}>
      <form id="publish-consent" onSubmit={publish} className="space-y-4">
        <Input label={publishing.letter ? 'Title' : 'Title shown to drivers'} name="title" required maxLength={200} defaultValue={publishing.versions[0]?.title ?? publishing.label} width="full" />
        <Field id="consent-file" label="PDF file" hint="3 MB maximum."><input id="consent-file" name="file" type="file" accept="application/pdf" required aria-describedby="consent-file-hint"
          className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
