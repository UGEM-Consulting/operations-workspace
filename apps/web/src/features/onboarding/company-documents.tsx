'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/field';
import { Badge } from '@/components/ui/status-badge';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { fileToBase64, MAX_PDF_BYTES as MAX_BYTES } from '@/lib/files';
import { readApi } from './types';
type Kind = 'NDA'|'SOP'|'CONTACT_LIST';
interface Version { id:string;kind:Kind;version:number;title:string;sha256:string;byteSize:number;pageCount:number;createdAt:string;uploadedBy:{firstName:string;lastName:string}; }
interface DocumentList { storageEnabled:boolean;kinds:{kind:Kind;label:string;signature:boolean;countersign:boolean;versions:Version[]}[]; }
const requirement = (signature: boolean, countersign: boolean) => signature ? `Typed name and a drawn or typed signature${countersign ? '; the approving manager countersigns' : ''}` : 'Read acknowledgement';
/** Company-wide onboarding documents. Each upload publishes a new version; earlier signatures keep the version that was signed. */
export function CompanyDocuments({ initial }: { initial: DocumentList }) {
 const [data, setData] = useState(initial), [publishing, setPublishing] = useState<Kind | null>(null), [busy, setBusy] = useState(false);
 const [error, setError] = useState(''), toast = useToast();
 async function publish(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (!publishing || busy) return;
  const form = new FormData(event.currentTarget), file = form.get('file');
  if (!(file instanceof File) || file.type !== 'application/pdf') { setError('Choose a PDF file.'); return; }
  if (file.size > MAX_BYTES) { setError('The PDF must be 3 MB or smaller. Compress it and try again.'); return; }
  setBusy(true); setError('');
  try {
   const published = await mutate<Version>('documents', 'POST', { kind: publishing, title: String(form.get('title') ?? ''), file: await fileToBase64(file) });
   setPublishing(null); toast({ title: 'Document published', description: `${published.title} is now version ${published.version}.` });
   // The publish succeeded even if the list cannot refresh; the page can be reloaded.
   try { setData(await readApi<DocumentList>('documents')); } catch { toast({ tone: 'danger', title: 'List not refreshed', description: 'Reload the page to see the new version.' }); }
  } catch (failure) { setError(errorMessage(failure, 'Unable to publish. Please try again.')); }
  finally { setBusy(false); }
 }
 return <div className="space-y-6">
  <PageHeader eyebrow="Dispatcher onboarding" title="Documents" description="Company-wide documents every new hire reads and signs before submitting an application. Publishing a new version affects applicants who have not signed yet; signed copies always keep the version that was signed."/>
  {!data.storageEnabled && <Alert tone="warning" title="Document storage is not configured"><p>Documents cannot be published and applicants are not asked to sign.</p></Alert>}
  {data.kinds.map(kind => { const current = kind.versions[0]; return <Card key={kind.kind}>
   <CardHeader title={kind.label} description={requirement(kind.signature, kind.countersign)} actions={<Button size="sm" variant={current ? 'outline' : 'default'} disabled={!data.storageEnabled} onClick={() => { setPublishing(kind.kind); setError(''); }}>{current ? 'Publish new version' : 'Publish'}</Button>} />
   <div className="p-4 sm:px-5 sm:pb-5">{current ? <ol className="space-y-2">{kind.versions.map((version, index) => <li key={version.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-2 text-sm">
    <span><a className="text-primary underline" href={`/api/backend/documents/${version.id}/file`} target="_blank" rel="noopener">{version.title}</a> · version {version.version}{index === 0 && <span className="ml-2"><Badge label="Current" tone="success" /></span>}</span>
    <span className="text-muted-foreground">{version.pageCount} {version.pageCount === 1 ? 'page' : 'pages'} · {version.uploadedBy.firstName} {version.uploadedBy.lastName} · <LocalTime iso={version.createdAt} format="date" /></span>
    <span className="w-full break-all font-mono text-xs text-muted-foreground">SHA-256 {version.sha256}</span></li>)}</ol>
    : <p className="text-sm text-muted-foreground">Not published. Applicants are not asked to sign it until a version is published.</p>}</div>
  </Card>; })}
  {publishing && <Dialog open title={`Publish ${data.kinds.find(kind => kind.kind === publishing)?.label}`} description="Upload the final PDF (3 MB maximum). It cannot be edited or deleted after publishing; upload a new version instead." onClose={() => setPublishing(null)} busy={busy}
   actions={<Button form="publish-document" type="submit">{busy ? 'Publishing…' : 'Publish'}</Button>}>
   <form id="publish-document" onSubmit={publish} className="space-y-4">
    <Input label="Title shown to applicants" name="title" required maxLength={200} defaultValue={data.kinds.find(kind => kind.kind === publishing)?.versions[0]?.title ?? ''} width="full"/>
    <Field id="document-file" label="PDF file" hint="3 MB maximum."><input id="document-file" name="file" type="file" accept="application/pdf" required aria-describedby="document-file-hint" className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent"/></Field>
    <Notice message={error} error/>
    <PendingHint pending={busy} />
   </form>
  </Dialog>}
 </div>;
}
