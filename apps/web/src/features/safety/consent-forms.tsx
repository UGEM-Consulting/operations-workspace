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
import type { DocumentField } from '@/features/documents/fields';

export interface ConsentVersion { id: string; kind: string; version: number; title: string; sha256: string; pageCount: number; createdAt: string; uploader: string | null; fields?: DocumentField[] }
export interface ConsentList { storageEnabled: boolean; canPublish: boolean; kinds: { kind: string; label: string; signature: boolean; versions: ConsentVersion[] }[] }
const hints: Record<string, string> = {
  BACKGROUND_DISCLOSURE: 'The standalone disclosure that a background check, including the MVR, may be obtained.',
  BACKGROUND_AUTHORIZATION: 'The driver’s written authorization to obtain those reports. Required before Safety pulls an MVR.',
  CLEARINGHOUSE_CONSENT: 'The driver’s consent to the FMCSA Clearinghouse limited query.',
};

/**
 * Safety › Consent forms: the forms drivers sign in their application. Each upload publishes a new, permanent version;
 * drivers always sign the current one and signed copies keep the version that was signed. The legal text is the PDF's.
 */
export function ConsentForms({ initial }: { initial: ConsentList }) {
  const router = useRouter();
  const toast = useToast();
  const [publishing, setPublishing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const kind = initial.kinds.find(item => item.kind === publishing), [placing, setPlacing] = useState<{ title: string; file: File } | null>(null);
  async function send(title: string, file: File, fields: DocumentField[]) {
    const published = await mutate<ConsentVersion>('safety/consents', 'POST', { kind: publishing, title, file: await fileToBase64(file), fields });
    toast({ title: 'Form published', description: `${published.title} is now version ${published.version}.` });
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
  return <div className="space-y-6">
    <PageHeader title="Consent forms" description="The forms drivers open and sign in their application. Publish the final PDFs your legal or compliance adviser approved; the workspace adds no legal text of its own." />
    {!initial.storageEnabled && <Alert tone="warning" title="Document storage is not configured"><p>Forms can’t be published, and drivers aren’t asked to sign.</p></Alert>}
    {initial.kinds.map(item => {
      const current = item.versions[0];
      return <Card key={item.kind}>
        <CardHeader title={item.label} description={`${hints[item.kind] ?? ''} ${item.signature ? 'Typed name and a drawn or typed signature.' : 'Acknowledged as read.'}`}
          actions={initial.canPublish && <Button size="sm" variant={current ? 'outline' : 'default'} disabled={!initial.storageEnabled} onClick={() => { setPublishing(item.kind); setError(''); }}>
            <Upload aria-hidden="true" className="size-4" />{current ? 'Publish new version' : 'Publish'}</Button>} />
        <div className="p-4 sm:px-5 sm:pb-5">{current ? <ol className="space-y-2">{item.versions.map((version, index) => <li key={version.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-2 text-sm">
          <span><ViewDocumentButton variant="link" size="sm" className="text-sm" documents={[{ url: `/api/backend/safety/consents/${version.id}/file`, title: version.title, meta: `Version ${version.version}` }]}>{version.title}</ViewDocumentButton> · version {version.version}{index === 0 && <span className="ml-2"><Badge label="Current" tone="success" /></span>}</span>
          <span className="text-muted-foreground">{version.pageCount} {version.pageCount === 1 ? 'page' : 'pages'} · {version.uploader ?? 'A former account'} · <LocalTime iso={version.createdAt} format="date" /></span>
          <span className="w-full break-all font-mono text-xs text-muted-foreground">SHA-256 {version.sha256}</span></li>)}</ol>
          : <p className="text-sm text-muted-foreground">Not published. Drivers aren’t asked to sign it until a version is published.</p>}</div>
      </Card>;
    })}
    {kind && placing && <FieldPlacer file={placing.file} title={placing.title} signerLabel="The driver" signature={kind.signature} initial={kind.versions[0]?.fields ?? []} onBack={() => setPlacing(null)} onPublish={fields => send(placing.title, placing.file, fields)} />}
    {kind && !placing && <Dialog open title={`Publish ${kind.label.toLowerCase()}`} onClose={() => setPublishing(null)}
      description="Upload the final PDF (3 MB maximum). It can’t be edited or deleted after publishing; upload a new version instead. Drivers who haven’t submitted yet sign the new version."
      actions={<Button form="publish-consent" type="submit">Next: place the fields</Button>}>
      <form id="publish-consent" onSubmit={publish} className="space-y-4">
        <Input label="Title shown to drivers" name="title" required maxLength={200} defaultValue={kind.versions[0]?.title ?? kind.label} width="full" />
        <Field id="consent-file" label="PDF file" hint="3 MB maximum."><input id="consent-file" name="file" type="file" accept="application/pdf" required aria-describedby="consent-file-hint"
          className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
