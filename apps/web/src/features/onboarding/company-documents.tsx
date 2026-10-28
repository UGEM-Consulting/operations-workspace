'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { PageHeader } from '@/components/workspace-ui';
import { mutate } from '@/lib/client-api';
import { inputClass, readApi } from './types';
type Kind = 'NDA'|'SOP'|'CONTACT_LIST';
interface Version { id:string;kind:Kind;version:number;title:string;sha256:string;byteSize:number;pageCount:number;createdAt:string;uploadedBy:{firstName:string;lastName:string}; }
interface DocumentList { storageEnabled:boolean;kinds:{kind:Kind;label:string;signature:boolean;countersign:boolean;versions:Version[]}[]; }
const MAX_BYTES = 3_000_000;
const requirement = (signature: boolean, countersign: boolean) => signature ? `Typed name and drawn signature${countersign ? '; the approving manager countersigns' : ''}` : 'Read acknowledgement';
/** Company-wide onboarding documents. Each upload publishes a new version; earlier signatures keep the version that was signed. */
export function CompanyDocuments({ initial }: { initial: DocumentList }) {
 const [data, setData] = useState(initial), [publishing, setPublishing] = useState<Kind | null>(null), [busy, setBusy] = useState(false);
 const [error, setError] = useState(''), [message, setMessage] = useState('');
 async function publish(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (!publishing || busy) return;
  const form = new FormData(event.currentTarget), file = form.get('file');
  if (!(file instanceof File) || file.type !== 'application/pdf') { setError('Choose a PDF file.'); return; }
  if (file.size > MAX_BYTES) { setError('The PDF must be 3 MB or smaller. Compress it and try again.'); return; }
  setBusy(true); setError('');
  try {
   const bytes = new Uint8Array(await file.arrayBuffer());
   let binary = '';
   for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
   const published: Version = await mutate('documents', 'POST', { kind: publishing, title: String(form.get('title') ?? ''), file: btoa(binary) });
   setData(await readApi<DocumentList>('documents')); setPublishing(null); setMessage(`Published ${published.title} as version ${published.version}.`);
  } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to publish. Please try again.'); }
  finally { setBusy(false); }
 }
 return <div className="space-y-6">
  <PageHeader eyebrow="Dispatcher onboarding" title="Documents" description="Company-wide documents every new hire reads and signs before submitting an application. Publishing a new version affects applicants who have not signed yet; signed copies always keep the version that was signed."/>
  {!data.storageEnabled && <Notice message="Document storage is not configured, so documents cannot be published and applicants are not asked to sign." error/>}
  <Notice message={message}/>
  {data.kinds.map(kind => { const current = kind.versions[0]; return <Card key={kind.kind} className="space-y-4 p-6">
   <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">{kind.label}</h2><p className="text-sm text-muted-foreground">{requirement(kind.signature, kind.countersign)}</p></div>
    <Button disabled={!data.storageEnabled} onClick={() => { setPublishing(kind.kind); setError(''); setMessage(''); }}>{current ? 'Publish new version' : 'Publish'}</Button></div>
   {current ? <ol className="space-y-2">{kind.versions.map((version, index) => <li key={version.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-2 text-sm">
    <span><a className="text-primary underline" href={`/api/backend/documents/${version.id}/file`} target="_blank" rel="noopener">{version.title}</a> · version {version.version}{index === 0 && <span className="ml-2 rounded bg-accent px-2 py-0.5 text-xs">Current</span>}</span>
    <span className="text-muted-foreground">{version.pageCount} {version.pageCount === 1 ? 'page' : 'pages'} · {version.uploadedBy.firstName} {version.uploadedBy.lastName} · {new Date(version.createdAt).toLocaleDateString()}</span>
    <span className="w-full break-all font-mono text-xs text-muted-foreground">SHA-256 {version.sha256}</span></li>)}</ol>
    : <p className="text-sm text-muted-foreground">Not published. Applicants are not asked to sign it until a version is published.</p>}
  </Card>; })}
  {publishing && <Dialog open title={`Publish ${data.kinds.find(kind => kind.kind === publishing)?.label}`} description="Upload the final PDF (3 MB maximum). It cannot be edited or deleted after publishing; upload a new version instead." onClose={() => setPublishing(null)} busy={busy}
   actions={<Button form="publish-document" type="submit">{busy ? 'Publishing…' : 'Publish'}</Button>}>
   <form id="publish-document" onSubmit={publish} className="space-y-4">
    <label className="block text-sm">Title shown to applicants *<input name="title" required maxLength={200} defaultValue={data.kinds.find(kind => kind.kind === publishing)?.versions[0]?.title ?? ''} className={inputClass}/></label>
    <label className="block text-sm">PDF file *<input name="file" type="file" accept="application/pdf" required className="mt-2 block w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-border file:bg-background file:px-4"/></label>
    <Notice message={error} error/>
   </form>
  </Dialog>}
 </div>;
}
