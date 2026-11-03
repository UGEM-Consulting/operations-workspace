'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { LocalTime } from '@/components/ui/local-time';
import { ApiError } from '@/lib/client-api';
import { DocumentViewer } from '@/features/documents/document-modal';
import type { DocumentField } from '@/features/documents/fields';
import { emptyMemory, SigningModal, type SignableDocument, type SigningMemory } from '@/features/documents/signing-modal';
import type { DriverApplicationView } from './driver-application';

export interface ConsentItem { id: string; kind: string; label: string; title: string; version: number; pageCount: number; requiresSignature: boolean; statement: string; viewed: boolean; fields?: DocumentField[];
  signed: { documentId: string; version: number; signedAt: string } | null; current: boolean }
export const consentSectionId = 'consent-forms';

/**
 * The consent forms Safety published, each read and signed in a modal: the e-sign consent once, the statement, the legal name and, for
 * the authorization and Clearinghouse consent, a drawn or adopted signature. The legal text is the PDF's.
 */
export function ConsentSigning({ view, onSaved, onEnded, editable }: { view: DriverApplicationView; onSaved: (view: DriverApplicationView) => void; onEnded: (message: string) => void; editable: boolean }) {
  const consents = view.consents!;
  const [memory, setMemory] = useState<SigningMemory>(emptyMemory), [openId, setOpenId] = useState(''), [viewingId, setViewingId] = useState('');
  const signable: SignableDocument[] = consents.items.map(item => ({ id: item.id, title: item.title, short: item.label, pageCount: item.pageCount, requiresSignature: item.requiresSignature, statement: item.statement, fields: item.fields ?? [],
    fileUrl: `/api/backend/driver/consents/${item.id}/file`, signedUrl: `/api/backend/driver/consents/${item.id}/signed`, viewPath: `driver/consents/${item.id}/view`, signPath: `driver/consents/${item.id}/sign`,
    state: item.current ? 'done' : 'todo', fallbackName: `${item.kind.toLowerCase()}.pdf` }));
  const nextId = editable ? signable.find(item => item.state === 'todo')?.id : undefined, open = signable.find(item => item.id === openId), viewing = consents.items.find(item => item.signed?.documentId === viewingId);
  return <div className="space-y-3">
    {consents.items.map(item => <article key={item.id} className={`flex items-center gap-3 rounded-md border bg-card p-4 ${nextId === item.id ? 'border-primary' : 'border-border'}`}>
      <div className="min-w-0 flex-1"><h3 className="text-[15px] font-semibold leading-[22px]">{item.title}</h3>
        <p className="text-[13px] leading-5 text-muted-foreground">{item.signed ? <>{item.requiresSignature ? 'Signed' : 'Acknowledged'} <LocalTime iso={item.signed.signedAt} format="date" />{item.current ? '' : ` (version ${item.signed.version})`}</> : item.requiresSignature ? 'To sign' : 'To read and confirm'} · {item.pageCount} {item.pageCount === 1 ? 'page' : 'pages'}</p>
        {item.signed && !item.current && <p className="text-[13px] leading-5 text-warning">Safety published a newer version. Your earlier signature doesn’t cover it.</p>}</div>
      {!item.current && editable ? <Button type="button" size="sm" variant={nextId === item.id ? 'default' : 'outline'} onClick={() => setOpenId(item.id)}>{item.requiresSignature ? 'Read and sign' : 'Read'}<span className="sr-only"> {item.title}</span></Button>
        : item.signed && <Button type="button" size="sm" variant="ghost" onClick={() => setViewingId(item.signed!.documentId)}>View<span className="sr-only"> {item.title}</span></Button>}
    </article>)}
    {open && <SigningModal key={open.id} doc={open} documents={signable} consent={consents.consent} memory={memory} onMemory={setMemory} nameHint="as on your license"
      onSigned={result => onSaved(result as DriverApplicationView)} onNext={next => setOpenId(next.id)} onClose={() => setOpenId('')}
      onFailure={failure => { if (failure instanceof ApiError && failure.kind === 'applicant-session') { onEnded(failure.message); return true; } return false; }} />}
    {viewing?.signed && <DocumentViewer documents={[{ url: `/api/backend/driver/consents/${viewing.signed.documentId}/signed`, title: viewing.title, meta: <>Signed <LocalTime iso={viewing.signed.signedAt} format="date" /></> }]} onClose={() => setViewingId('')} />}
  </div>;
}
