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
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { fileToBase64, MAX_PDF_BYTES } from '@/lib/files';

export interface ConsentVersion { id: string; kind: string; version: number; title: string; sha256: string; pageCount: number; createdAt: string; uploader: string | null }
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kind = initial.kinds.find(item => item.kind === publishing);
  async function publish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publishing || busy) return;
    const form = new FormData(event.currentTarget), file = form.get('file');
    if (!(file instanceof File) || file.type !== 'application/pdf') { setError('Choose a PDF file.'); return; }
    if (file.size > MAX_PDF_BYTES) { setError('The PDF must be 3 MB or smaller. Compress it and try again.'); return; }
    setBusy(true); setError('');
    try {
      const published = await mutate<ConsentVersion>('safety/consents', 'POST', { kind: publishing, title: String(form.get('title') ?? ''), file: await fileToBase64(file) });
      toast({ title: 'Form published', description: `${published.title} is now version ${published.version}.` });
      setPublishing(null); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to publish. Please try again.')); }
    finally { setBusy(false); }
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
          <span><a className="text-primary underline" href={`/api/backend/safety/consents/${version.id}/file`} target="_blank" rel="noopener">{version.title}</a> · version {version.version}{index === 0 && <span className="ml-2"><Badge label="Current" tone="success" /></span>}</span>
          <span className="text-muted-foreground">{version.pageCount} {version.pageCount === 1 ? 'page' : 'pages'} · {version.uploader ?? 'A former account'} · <LocalTime iso={version.createdAt} format="date" /></span>
          <span className="w-full break-all font-mono text-xs text-muted-foreground">SHA-256 {version.sha256}</span></li>)}</ol>
          : <p className="text-sm text-muted-foreground">Not published. Drivers aren’t asked to sign it until a version is published.</p>}</div>
      </Card>;
    })}
    {kind && <Dialog open title={`Publish ${kind.label.toLowerCase()}`} onClose={() => setPublishing(null)} busy={busy}
      description="Upload the final PDF (3 MB maximum). It can’t be edited or deleted after publishing; upload a new version instead. Drivers who haven’t submitted yet sign the new version."
      actions={<Button form="publish-consent" type="submit">{busy ? 'Publishing…' : 'Publish'}</Button>}>
      <form id="publish-consent" onSubmit={publish} className="space-y-4">
        <Input label="Title shown to drivers" name="title" required maxLength={200} defaultValue={kind.versions[0]?.title ?? kind.label} width="full" />
        <Field id="consent-file" label="PDF file" hint="3 MB maximum."><input id="consent-file" name="file" type="file" accept="application/pdf" required aria-describedby="consent-file-hint"
          className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>
        <Notice message={error} error />
        <PendingHint pending={busy} />
      </form>
    </Dialog>}
  </div>;
}
