'use client';
import { useCallback, useId, useRef, useState } from 'react';
import { Check, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { LocalTime } from '@/components/ui/local-time';
import { ApiError, errorMessage, mutate } from '@/lib/client-api';
import { SignaturePad, type SignatureMethod } from '@/features/onboarding/signature-pad';
import { inputClass } from '@/components/ui/field';
import type { DriverApplicationView } from './driver-application';

export interface ConsentItem { id: string; kind: string; label: string; title: string; version: number; pageCount: number; requiresSignature: boolean; statement: string; viewed: boolean;
  signed: { documentId: string; version: number; signedAt: string } | null; current: boolean }
const LATIN_NAME = /^[A-Za-z][A-Za-z .,'-]+$/;
export const consentSectionId = 'consent-forms';

/**
 * The consent forms Safety published: one e-sign consent, then each form opened in full (recorded by an explicit
 * request), its statement ticked, the legal name typed and, for the authorization and Clearinghouse consent, a drawn or
 * adopted signature. The legal text is the PDF's. The cards sit inside the application form, so Enter never submits it.
 */
export function ConsentSigning({ view, onSaved, onEnded, editable }: { view: DriverApplicationView; onSaved: (view: DriverApplicationView) => void; onEnded: (message: string) => void; editable: boolean }) {
  const consents = view.consents!;
  const [consent, setConsent] = useState(false), [working, setWorking] = useState('');
  const unsigned = consents.items.some(item => !item.current);
  return <div className="space-y-4">
    {unsigned && editable && <label className="flex items-start gap-3 rounded-md border border-border p-4 text-sm">
      <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} className="mt-1 size-5" />
      <span><span className="block font-medium">Consent to sign electronically</span>{consents.consent}</span>
    </label>}
    {consents.items.map(item => <ConsentCard key={item.id} item={item} consent={consent} editable={editable} disabled={!!working && working !== item.id}
      onWorking={setWorking} onSaved={onSaved} onEnded={onEnded} />)}
  </div>;
}

function ConsentCard({ item, consent, editable, disabled, onWorking, onSaved, onEnded }: { item: ConsentItem; consent: boolean; editable: boolean; disabled: boolean;
  onWorking: (id: string) => void; onSaved: (view: DriverApplicationView) => void; onEnded: (message: string) => void }) {
  const [opened, setOpened] = useState(item.viewed), [agreed, setAgreed] = useState(false), [name, setName] = useState('');
  const [signature, setSignature] = useState<{ image: string; method: SignatureMethod } | null>(null);
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [attempted, setAttempted] = useState(false);
  const id = useId(), nameInput = useRef<HTMLInputElement>(null);
  const onSignature = useCallback((image: string | null, method: SignatureMethod) => setSignature(image ? { image, method } : null), []);
  const nameValid = LATIN_NAME.test(name.trim());
  const nameError = attempted && !nameValid ? (name.trim() ? 'Use Latin letters (A–Z) only, as on your license.' : 'Type your full legal name.') : '';
  const steps = [
    { done: opened, label: 'Open the full form' },
    { done: consent, label: 'Consent to sign electronically (above)' },
    { done: agreed, label: 'Tick the statement' },
    { done: nameValid, label: 'Type your full legal name' },
    ...(item.requiresSignature ? [{ done: !!signature, label: 'Draw or adopt your signature' }] : []),
  ];
  const ready = steps.every(step => step.done);
  function failed(failure: unknown, fallback: string) {
    if (failure instanceof ApiError && failure.kind === 'applicant-session') { onEnded(failure.message); return; }
    setError(errorMessage(failure, fallback));
  }
  async function open() {
    setError('');
    // The signing evidence is this request, not the file download.
    try { await mutate(`driver/consents/${item.id}/view`, 'POST'); setOpened(true); }
    catch (failure) { failed(failure, 'We couldn’t record that you opened the form. Open it again.'); }
  }
  function review() {
    setAttempted(true);
    if (!ready) { if (!nameValid && opened && consent && agreed) nameInput.current?.focus(); return; }
    setConfirming(true);
  }
  async function sign() {
    setBusy(true); onWorking(item.id); setError('');
    try {
      onSaved(await mutate<DriverApplicationView>(`driver/consents/${item.id}/sign`, 'POST', { typedName: name.trim(), consent, agreed,
        ...(item.requiresSignature && signature ? { signature: signature.image, signatureMethod: signature.method } : {}) }));
      setConfirming(false);
    } catch (failure) { setConfirming(false); failed(failure, 'Unable to sign. Please try again.'); }
    finally { setBusy(false); onWorking(''); }
  }
  return <article className="space-y-4 rounded-md border border-border p-4" aria-labelledby={`${id}-title`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 id={`${id}-title`} className="font-medium">{item.title}</h3><p className="text-xs text-muted-foreground">{item.label} · version {item.version} · {item.pageCount} {item.pageCount === 1 ? 'page' : 'pages'}</p></div>
      <a href={`/api/backend/driver/consents/${item.id}/file`} target="_blank" rel="noopener" onClick={() => void open()} className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm hover:bg-accent">
        Open form<span className="sr-only"> {item.title} (opens in a new tab)</span></a>
    </div>
    {item.signed && <p className="text-sm text-success">{item.requiresSignature ? 'Signed' : 'Acknowledged'} <LocalTime iso={item.signed.signedAt} />{item.current ? '' : ` (version ${item.signed.version})`} ·{' '}
      <a className="underline" href={`/api/backend/driver/consents/${item.signed.documentId}/signed`} target="_blank" rel="noopener">Download signed copy</a></p>}
    {!item.current && editable && <div className="space-y-4 border-t border-border pt-4">
      {item.signed && <p className="text-sm text-warning">Safety published a newer version. Open, review and sign version {item.version}; your earlier signature doesn’t cover it.</p>}
      {!opened && <p className="text-sm text-muted-foreground">Open the form first. It opens in a new tab.</p>}
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={agreed} disabled={!opened} onChange={event => setAgreed(event.target.checked)} className="mt-1 size-5" /><span>{item.statement}</span></label>
      <div className="text-sm"><label htmlFor={`${id}-name`}>Full legal name, as on your license *</label>
        <input ref={nameInput} id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} maxLength={100} autoComplete="name"
          onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }}
          aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? `${id}-name-error` : undefined} className={inputClass} />
        {nameError && <p id={`${id}-name-error`} className="mt-1 text-[13px] leading-5 text-danger">{nameError}</p>}</div>
      {item.requiresSignature && <SignaturePad label="Your signature *" onChange={onSignature} disabled={disabled || busy} allowTyped typedName={name} touch />}
      <div className="space-y-2">
        <p id={`${id}-steps`} className="text-sm font-medium">{ready ? 'Ready to sign.' : 'Before you can sign:'}</p>
        <ul className="space-y-1 text-sm" aria-labelledby={`${id}-steps`}>{steps.map(step => <li key={step.label} className={`flex items-center gap-2 ${step.done ? 'text-success' : attempted ? 'text-danger' : 'text-muted-foreground'}`}>
          {step.done ? <Check aria-hidden="true" className="size-4" /> : <Circle aria-hidden="true" className="size-4" />}{step.label}<span className="sr-only">{step.done ? ' (done)' : ' (still needed)'}</span></li>)}</ul>
        {attempted && !ready && <p role="alert" className="text-sm text-danger">Complete the steps marked above, then try again.</p>}
      </div>
      <Button type="button" size="lg" disabled={disabled || busy} onClick={review}>{item.requiresSignature ? 'Sign form' : 'Acknowledge'}</Button>
    </div>}
    <Notice message={error} error />
    {confirming && <Dialog open title={item.requiresSignature ? `Sign ${item.title}?` : `Acknowledge ${item.title}?`} onClose={() => setConfirming(false)} busy={busy} protectChanges={false} closeLabel="Go back"
      description="Your electronic signature is legally binding, the same as a handwritten one. It’s recorded with the date, time, your IP address and browser, and can’t be withdrawn here."
      actions={<Button type="button" onClick={() => void sign()}>{busy ? 'Signing…' : item.requiresSignature ? 'Yes, sign' : 'Yes, acknowledge'}</Button>}>
      <p className="text-sm">Signing as <strong>{name.trim()}</strong>{signature?.method === 'TYPED' ? ' with your adopted typed signature' : ''}.</p>
    </Dialog>}
  </article>;
}
