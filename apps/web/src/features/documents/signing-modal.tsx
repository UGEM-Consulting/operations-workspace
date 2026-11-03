'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, CircleCheck, Download, PenLine } from 'lucide-react';
import { Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/field';
import { Badge } from '@/components/ui/status-badge';
import { ApiError, errorMessage, mutate } from '@/lib/client-api';
import { SignaturePad, type SignatureMethod } from '@/features/onboarding/signature-pad';
import { DocumentModal } from './document-modal';
import { FieldMark, fieldText, type DocumentField } from './fields';
import { downloadBlob, PdfPages, PrintButton, usePdf } from './pdf';

export interface SignableDocument {
  id: string; title: string; short: string; pageCount: number; requiresSignature: boolean; statement: string; translatedStatement?: string | null; fields: DocumentField[];
  fileUrl: string; signedUrl: string; viewPath: string; signPath: string; /** Read with one button: nothing to tick, type or sign. */ acknowledgePath?: string;
  state: 'done' | 'todo'; fallbackName: string;
}
export interface SigningMemory { consented: boolean; name: string; signature: { image: string; method: SignatureMethod } | null; read: string[] }
export const emptyMemory: SigningMemory = { consented: false, name: '', signature: null, read: [] };
const LATIN_NAME = /^[A-Za-z][A-Za-z .,'-]+$/;
type Step = 'read' | 'agree' | 'sign' | 'done';

const markLabel = (field: DocumentField) => field.signer === 'COMPANY' ? ({ SIGNATURE: 'Your manager signs at approval', NAME: 'Manager’s name', TITLE: 'Manager’s title', DATE: 'Date of approval' } as Record<string, string>)[field.kind] ?? 'At approval'
  : ({ SIGNATURE: 'Your signature', NAME: 'Your full legal name', DATE: 'Filled in when you sign', DAY: 'Day', MONTH: 'Month', YEAR: 'Yr' } as Record<string, string>)[field.kind] ?? '';

const Dots = ({ at }: { at: number }) => <div className="shrink-0 border-b px-4 py-3 lg:px-5 lg:py-4"><p className="text-[13px] font-medium leading-5 text-muted-foreground">Step {at + 1} of 3: <span className="font-semibold text-foreground">{['Read', 'Agree', 'Sign'][at]}</span></p>
  <div aria-hidden="true" className="mt-2 flex gap-2">{[0, 1, 2].map(index => <span key={index} className={`h-1 flex-1 rounded-full ${index <= at ? 'bg-primary' : 'bg-border'}`} />)}</div></div>;

/**
 * Read → agree → sign → done, all over the page. What the signer has given (consent, name, signature) stays in `memory` while the
 * page is open, so the next document only asks for what's new, and closing never loses it. Signing still needs the recorded view, the
 * unticked statement and every other check on the API; reaching the last page is checked here.
 */
export function SigningModal({ doc, documents, consent, consentTranslation, memory, onMemory, nameHint, onSigned, onNext, onClose, onFailure }: {
  doc: SignableDocument; documents: SignableDocument[]; consent: string; consentTranslation?: string | null; memory: SigningMemory; onMemory: (memory: SigningMemory) => void; nameHint: string;
  onSigned: (result: unknown) => void; onNext: (doc: SignableDocument) => void; onClose: () => void; onFailure?: (failure: unknown) => boolean;
}) {
  const alreadyRead = memory.read.includes(doc.id);
  const [step, setStep] = useState<Step>(alreadyRead && !doc.acknowledgePath ? 'agree' : 'read'), [viewed, setViewed] = useState(false), [atEnd, setAtEnd] = useState(alreadyRead), [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1), [agreed, setAgreed] = useState(false), [consented, setConsented] = useState(memory.consented), [name, setName] = useState(memory.name), [changing, setChanging] = useState(!memory.signature);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [attempted, setAttempted] = useState(false), [signedDoc, setSignedDoc] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null), signature = memory.signature, now = useMemo(() => new Date(), []);
  const source = useMemo(() => ({ url: signedDoc ? doc.signedUrl : doc.fileUrl, fallbackName: doc.fallbackName }), [signedDoc, doc.signedUrl, doc.fileUrl, doc.fallbackName]);
  const { file, failure, reload } = usePdf(source);
  function failed(cause: unknown, fallback: string) { if (!onFailure?.(cause)) setError(errorMessage(cause, fallback)); }
  // Signing evidence is this request, sent when the document opens; fetching the file records nothing.
  useEffect(() => {
    if (!file || viewed || signedDoc) return;
    mutate(doc.viewPath, 'POST').then(() => setViewed(true)).catch((cause: unknown) => {
      // An API from before this request existed records the view when the file is fetched.
      if (cause instanceof ApiError && cause.status === 404) { setViewed(true); return; }
      failed(cause, 'We couldn’t record that you opened this. Close it and open it again.');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per document
  }, [file, viewed, signedDoc, doc.viewPath]);
  const onProgress = useCallback((current: number, end: boolean) => { setPage(current); if (end) setAtEnd(true); }, []);
  const readDone = atEnd && viewed;
  const remember = (next: Partial<SigningMemory>) => onMemory({ ...memory, ...next });
  const onSignature = useCallback((image: string | null, method: SignatureMethod) => onMemory({ ...memory, name, signature: image ? { image, method } : null }), [memory, name, onMemory]);
  const nameValid = LATIN_NAME.test(name.trim());
  const nameError = attempted && !nameValid ? (name.trim() ? `Use Latin letters (A–Z) only, ${nameHint}.` : 'Type your full legal name.') : '';
  // An adopted signature is the typed name in a script: a different name needs adopting again.
  function changeName(value: string) {
    setName(value);
    if (signature?.method === 'TYPED' && memory.name && value.trim() !== memory.name.trim()) { setChanging(true); onMemory({ ...memory, name: value, signature: null }); }
  }
  const firstSignature = doc.fields.find(field => field.signer === 'SIGNER' && field.kind === 'SIGNATURE') ?? doc.fields.find(field => field.signer === 'SIGNER');
  const focus = useMemo(() => step === 'read' || !firstSignature ? null : { page: firstSignature.page, y: firstSignature.y }, [step, firstSignature]);
  const overlay = (number: number, width: number, height: number) => step === 'done' ? null : doc.fields.filter(field => field.page === number).map((field, index) => {
    const mine = field.signer === 'SIGNER' && step === 'sign';
    if (mine && field.kind === 'SIGNATURE' && signature) return <FieldMark key={index} field={field} pageWidth={width} pageHeight={height} image={signature.image} />;
    if (mine && field.kind !== 'SIGNATURE') { const text = fieldText(field.kind, { name: name.trim(), at: now }); if (text) return <FieldMark key={index} field={field} pageWidth={width} pageHeight={height} text={text} />; }
    return <FieldMark key={index} field={field} pageWidth={width} pageHeight={height} label={markLabel(field)} active={step === 'sign' && field.signer === 'SIGNER' && field.kind === 'SIGNATURE'} />;
  });
  const signerFields = doc.fields.filter(field => field.signer === 'SIGNER'), pagesWithFields = [...new Set(signerFields.map(field => field.page))];
  const remaining = documents.filter(item => item.id !== doc.id && item.state === 'todo'), next = remaining[0];
  async function sign() {
    setAttempted(true); setError('');
    if (!nameValid) { nameInput.current?.focus(); return; }
    if (doc.requiresSignature && !signature) { setError('Draw or adopt your signature first.'); return; }
    setBusy(true);
    try {
      onSigned(await mutate(doc.signPath, 'POST', { typedName: name.trim(), consent: consented, agreed, ...(doc.requiresSignature && signature ? { signature: signature.image, signatureMethod: signature.method } : {}) }));
      onMemory({ ...memory, consented: true, name: name.trim(), read: [...memory.read, doc.id] });
      setSignedDoc(true); setStep('done'); setError('');
    } catch (cause) { failed(cause, 'Unable to sign. Your entries have been kept. Please try again.'); }
    finally { setBusy(false); }
  }
  async function acknowledge() {
    setBusy(true); setError('');
    try { onSigned(await mutate(doc.acknowledgePath!, 'POST')); onMemory({ ...memory, read: [...memory.read, doc.id] }); setStep('done'); }
    catch (cause) { failed(cause, 'Unable to save that. Please try again.'); }
    finally { setBusy(false); }
  }
  const body = 'min-h-0 flex-1 space-y-4 overflow-y-auto p-4 lg:p-5', foot = 'shrink-0 space-y-3 border-t bg-card p-4 lg:px-5';
  const progress = !file ? 'Opening the document…' : atEnd ? 'You’ve reached the end.' : `Page ${page} of ${file.sizes.length}. Keep scrolling to the last page.`;
  const panel = step === 'read' ? (doc.acknowledgePath ? <>
    <div className={foot}><p aria-live="polite" className="text-[13px] leading-5 text-muted-foreground">{progress}</p><Notice message={error} error /><Button type="button" size="lg" className="w-full" disabled={!readDone || busy} onClick={() => void acknowledge()}><Check aria-hidden="true" className="size-4" />{busy ? 'Saving…' : 'I’ve read this'}</Button></div>
  </> : <>
    <div className="hidden lg:block"><Dots at={0} /></div>
    <div className={`${body} hidden lg:block`}><h3 className="text-[17px] font-semibold leading-6">Read the whole document</h3>
      <p className="text-sm leading-[22px] text-muted-foreground">Scroll through to the last page. You can close this and come back.</p>
      {signerFields.length > 0 && <p className="text-sm leading-[22px] text-muted-foreground">The marked spaces are filled in for you when you sign. You only type your name and sign once.</p>}</div>
    <div className={foot}><p aria-live="polite" className="text-[13px] leading-5 text-muted-foreground">{progress}</p><Notice message={error} error /><Button type="button" size="lg" className="w-full" disabled={!readDone} onClick={() => { remember({ read: [...new Set([...memory.read, doc.id])] }); setStep('agree'); }}>Next: agree<ArrowRight aria-hidden="true" className="size-4" /></Button></div>
  </>) : step === 'agree' ? <>
    <Dots at={1} />
    <div className={body}><h3 className="text-[17px] font-semibold leading-6">Do you agree?</h3>
      {!memory.consented && <Checkbox checked={consented} onChange={event => setConsented(event.target.checked)} label={consent} description={consentTranslation ? <span lang="ru">{consentTranslation}</span> : undefined} />}
      <Checkbox checked={agreed} onChange={event => setAgreed(event.target.checked)} label={doc.statement} description={doc.translatedStatement ? <span lang="ru">{doc.translatedStatement}</span> : undefined} />
      {(doc.translatedStatement || consentTranslation) && <p className="text-xs leading-[18px] text-muted-foreground">The Russian translation is for convenience. The English text governs.</p>}</div>
    <div className={foot}><Button type="button" size="lg" className="w-full" disabled={!agreed || !consented} onClick={() => { setStep('sign'); setAttempted(false); }}>Next: {doc.requiresSignature ? 'sign' : 'confirm'}<ArrowRight aria-hidden="true" className="size-4" /></Button>
      <Button type="button" size="lg" variant="ghost" className="w-full" onClick={() => setStep('read')}>Back to reading</Button></div>
  </> : step === 'sign' ? <>
    <Dots at={2} />
    <div className={body}><h3 className="text-[17px] font-semibold leading-6">{doc.requiresSignature ? `Sign the ${doc.short}` : `Confirm the ${doc.short}`}</h3>
      <Input ref={nameInput} label="Full legal name" hint={memory.name ? `Filled in from your last document. Latin letters, ${nameHint}.` : `Latin letters, ${nameHint}.`} value={name} onChange={event => changeName(event.target.value)} error={nameError} maxLength={100} autoComplete="name" width="full" />
      {doc.requiresSignature && (signature && !changing ? <div className="space-y-2"><p className="text-sm font-medium">Your signature</p>
        <div className="relative grid h-28 place-items-center rounded-md border border-input bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL the signer just made */}
          <img src={signature.image} alt="Your signature" className="max-h-full max-w-full object-contain" /></div>
        <Button type="button" size="lg" variant="outline" onClick={() => { setChanging(true); onMemory({ ...memory, name, signature: null }); }}>Change signature</Button></div>
        : <SignaturePad label="Your signature" onChange={onSignature} disabled={busy} allowTyped typedName={name} touch />)}
      <dl className="space-y-2 rounded-md bg-muted px-4 py-3 text-[13px] leading-5"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Date</dt><dd className="font-medium">{fieldText('DATE', { at: now })}</dd></div>
        {signerFields.length > 0 && <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Places filled in</dt><dd className="text-right font-medium">{signerFields.length}, on {pagesWithFields.length === 1 ? 'page' : 'pages'} {pagesWithFields.join(' and ')}</dd></div>}</dl></div>
    <div className={foot}><p className="text-xs leading-[18px] text-muted-foreground">Your electronic signature is legally binding, the same as a handwritten one. We record the date, time, your IP address and browser.</p>
      <Notice message={error} error /><Button type="button" size="lg" className="w-full" disabled={busy} onClick={() => void sign()}><PenLine aria-hidden="true" className="size-4" />{busy ? 'Signing…' : `${doc.requiresSignature ? 'Sign' : 'Confirm'} ${doc.short}`}</Button></div>
  </> : <>
    <div className={body}><span className="grid size-11 place-items-center rounded-full bg-success-background text-success"><CircleCheck aria-hidden="true" className="size-6" /></span>
      <h3 role="status" className="text-[17px] font-semibold leading-6">{doc.acknowledgePath ? `${doc.short} read` : `${doc.short} ${doc.requiresSignature ? 'signed' : 'confirmed'}`}</h3>
      {!doc.acknowledgePath && <><p className="text-sm leading-[22px] text-muted-foreground">{name.trim() ? `Thank you, ${name.trim().split(' ')[0]}. ` : ''}Signed {fieldText('DATE', { at: now })}.{doc.fields.some(field => field.signer === 'COMPANY') ? ' UGEM adds its signature when your manager approves.' : ''}</p>
        <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!file} onClick={() => file && downloadBlob(file.blob, file.filename)}><Download aria-hidden="true" className="size-4" />Download my copy</Button>
          <PrintButton file={file} variant="outline" size="default" className="max-lg:hidden" /></div></>}
      <ul className="space-y-2 text-sm">{documents.map(item => { const done = item.id === doc.id || item.state === 'done'; return <li key={item.id} className="flex items-center justify-between gap-3">{item.short}{done ? <Badge label={item.acknowledgePath ? 'Read' : 'Signed'} tone="success" /> : <Badge label={item.acknowledgePath ? 'To read' : 'To sign'} tone="warning" />}</li>; })}</ul></div>
    <div className={foot}>{next && <Button type="button" size="lg" className="w-full" onClick={() => onNext(next)}>Next: {next.short}<ArrowRight aria-hidden="true" className="size-4" /></Button>}
      <Button type="button" size="lg" variant={next ? 'ghost' : 'default'} className="w-full" onClick={onClose}>Back to my application</Button></div>
  </>;
  const pages = `${doc.pageCount} ${doc.pageCount === 1 ? 'page' : 'pages'}`;
  return <DocumentModal title={doc.short} meta={step === 'done' ? `${doc.acknowledgePath ? 'Read' : doc.requiresSignature ? 'Signed' : 'Confirmed'} ${fieldText('DATE', { at: now })} · ${pages}` : `${doc.short === doc.title ? '' : `${doc.title} · `}${pages}`} file={file} failure={failure} reload={reload} zoom={zoom} onZoom={setZoom} onClose={onClose} busy={busy} closeLabel={`Close ${doc.short}`}
    panel={panel} panelGrows={step !== 'read'} pages={file && <PdfPages file={file} zoom={zoom} overlay={overlay} onProgress={onProgress} focus={focus} className="flex-1" />} />;
}
