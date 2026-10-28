'use client';
import { useCallback, useId, useRef, useState } from 'react';
import { Check, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { LocalTime } from '@/components/ui/local-time';
import { PrivateImage } from '@/components/ui/private-image';
import { ApiError, mutate } from '@/lib/client-api';
import { photoForUpload } from './photo';
import { SignaturePad, type SignatureMethod } from './signature-pad';
import { ApplicantDocument, ApplicantRecord, inputClass } from './types';
const PHOTOS = [
 { item: 'selfiePhoto', path: 'selfie', key: 'selfie', title: 'Selfie', help: 'A clear, recent photo of your face looking at the camera in good light, without sunglasses or a hat. It becomes your profile photo.' },
 { item: 'idPhoto', path: 'id-selfie', key: 'idSelfie', title: 'Selfie holding your ID', help: 'Hold your government-issued photo ID next to your face so your face, the ID photo and your name are clearly readable. Only your manager and administrators can see this photo; it is checked by a person, never by face recognition.' },
] as const;
const LATIN_NAME = /^[A-Za-z][A-Za-z .,'-]+$/;
type Photo = typeof PHOTOS[number];
/** The "Documents & signatures" step: two required photos, then each company document opened, read and signed. */
export function ApplicantDocuments({ record, onRecord, busy }: { record: ApplicantRecord; onRecord: (record: ApplicantRecord) => void; busy: boolean }) {
 const docs = record.documents;
 const [working, setWorking] = useState(''), [consent, setConsent] = useState(false), [photoVersion, setPhotoVersion] = useState(0);
 const disabled = busy || !!working;
 if (!docs.required) return <p className="text-sm text-muted-foreground">No photos or documents are required.</p>;
 const canSign = record.editableFields.includes('documents');
 return <div className="space-y-8">
  <section className="space-y-4" aria-labelledby="photos-heading">
   <div><h3 id="photos-heading" className="font-semibold">Photos *</h3><p className="text-sm text-muted-foreground">Both photos are required. Take a photo with your camera or choose one you already have.</p></div>
   <div className="grid gap-4 sm:grid-cols-2">{PHOTOS.map(photo => <PhotoCard key={photo.item} photo={photo} record={record} onRecord={onRecord} disabled={disabled} setWorking={setWorking}
    version={photoVersion} onUploaded={() => setPhotoVersion(version => version + 1)}/>)}</div>
  </section>
  {docs.items.length > 0 && <section className="space-y-4" aria-labelledby="documents-heading">
   <div><h3 id="documents-heading" className="font-semibold">Documents *</h3><p className="text-sm text-muted-foreground">Open and read each document in full, then sign or acknowledge it. You can download a signed copy afterwards.</p></div>
   {docs.items.some(doc => doc.signed?.documentId !== doc.id) && canSign && <label className="flex items-start gap-3 rounded-md border border-border p-4 text-sm"><input id="esign-consent" type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} className="mt-1 size-5"/><span><span className="block font-medium">Consent to sign electronically</span>{docs.consent.text}<span lang="ru" className="mt-2 block text-muted-foreground">{docs.consent.translation}</span></span></label>}
   {docs.items.map(doc => <DocumentCard key={doc.id} doc={doc} consent={consent} canSign={canSign} disabled={disabled} onRecord={onRecord} setWorking={setWorking}/>)}
  </section>}
 </div>;
}
function PhotoCard({ photo, record, onRecord, disabled, setWorking, version, onUploaded }: { photo: Photo; record: ApplicantRecord; onRecord: (record: ApplicantRecord) => void; disabled: boolean; setWorking: (value: string) => void; version: number; onUploaded: () => void }) {
 const camera = useRef<HTMLInputElement>(null), library = useRef<HTMLInputElement>(null), id = useId();
 const [state, setState] = useState<{ message: string; failed: boolean; uploading: boolean }>({ message: '', failed: false, uploading: false });
 const uploaded = record.documents.photos[photo.key], editable = record.editableFields.includes(photo.item);
 async function upload(file: File | undefined) {
  if (!file) return;
  setWorking(photo.item); setState({ message: 'Uploading…', failed: false, uploading: true });
  try {
   const image = await photoForUpload(file);
   onRecord(await mutate(`applicant/photos/${photo.path}`, 'POST', { image }));
   onUploaded(); setState({ message: `${photo.title} uploaded.`, failed: false, uploading: false });
  } catch (error) { setState({ message: error instanceof Error ? error.message : 'Upload failed. Please try again.', failed: true, uploading: false }); }
  finally { setWorking(''); }
 }
 const pick = (event: React.ChangeEvent<HTMLInputElement>) => { void upload(event.target.files?.[0]); event.target.value = ''; };
 return <div role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} className={`space-y-3 rounded-md border p-4 ${record.correction?.requestedFields.includes(photo.item) ? 'border-warning/50' : 'border-border'}`}>
  <p id={`${id}-title`} className="font-medium">{photo.title}</p><p id={`${id}-help`} className="text-sm text-muted-foreground">{photo.help}</p>
  {uploaded ? <PrivateImage src={`/api/backend/applicant/photos/${photo.path}?v=${version}-${uploaded}`} alt={`Your ${photo.title.toLowerCase()}`} className="max-h-60 rounded-md border object-contain"/>
   : <p className="text-sm text-warning">Not uploaded yet.</p>}
  {editable && <>
   {/* Both photos show the person's face, so the camera button opens the front camera; the library button never forces a camera. */}
   <input ref={camera} type="file" accept="image/*" capture="user" className="hidden" tabIndex={-1} aria-hidden="true" onChange={pick}/>
   <input ref={library} type="file" accept="image/*" className="hidden" tabIndex={-1} aria-hidden="true" onChange={pick}/>
   <div className="flex flex-wrap gap-2">
    <Button type="button" size="lg" disabled={disabled} aria-describedby={`${id}-help`} onClick={() => camera.current?.click()}>{uploaded ? 'Retake photo' : 'Take photo'}<span className="sr-only">: {photo.title.toLowerCase()}, with the camera</span></Button>
    <Button type="button" size="lg" variant="outline" disabled={disabled} aria-describedby={`${id}-help`} onClick={() => library.current?.click()}>Choose photo<span className="sr-only">: {photo.title.toLowerCase()}, from your photos</span></Button>
   </div>
  </>}
  <p role={state.failed ? 'alert' : 'status'} className={`text-sm ${state.failed ? 'text-danger' : state.uploading ? '' : 'text-success'}`}>{state.message}</p>
 </div>;
}
function DocumentCard({ doc, consent, canSign, disabled, onRecord, setWorking }: { doc: ApplicantDocument; consent: boolean; canSign: boolean; disabled: boolean; onRecord: (record: ApplicantRecord) => void; setWorking: (value: string) => void }) {
 const [opened, setOpened] = useState(doc.viewed), [agreed, setAgreed] = useState(false), [name, setName] = useState('');
 const [signature, setSignature] = useState<{ image: string; method: SignatureMethod } | null>(null);
 const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [attempted, setAttempted] = useState(false), [nameTouched, setNameTouched] = useState(false);
 const id = useId(), nameInput = useRef<HTMLInputElement>(null);
 const onSignature = useCallback((image: string | null, method: SignatureMethod) => setSignature(image ? { image, method } : null), []);
 const current = doc.signed?.documentId === doc.id;
 const nameValid = LATIN_NAME.test(name.trim());
 const nameError = (attempted || nameTouched) && !nameValid ? (name.trim() ? 'Use Latin letters (A–Z) only, as on your ID.' : 'Type your full legal name.') : '';
 const steps = [
  { done: opened, label: 'Open the full document' },
  { done: consent, label: 'Consent to sign electronically (above)' },
  { done: agreed, label: 'Tick the statement' },
  { done: nameValid, label: 'Type your full legal name in Latin letters' },
  ...(doc.requiresSignature ? [{ done: !!signature, label: 'Draw or adopt your signature' }] : []),
 ];
 const ready = steps.every(step => step.done);
 async function open() {
  setError('');
  // Signing evidence is recorded by this explicit request, not by fetching the file.
  try { await mutate(`applicant/documents/${doc.id}/view`, 'POST'); setOpened(true); }
  catch (failure) {
   // An API from before this request existed records the view when the file is fetched (deploys put web first).
   if (failure instanceof ApiError && failure.status === 404) { setOpened(true); return; }
   setError(failure instanceof Error ? `We could not record that you opened the document: ${failure.message}` : 'We could not record that you opened the document. Open it again.'); }
 }
 function review() {
  setAttempted(true);
  if (!ready) { if (!nameValid && opened && consent && agreed) nameInput.current?.focus(); return; }
  setConfirming(true);
 }
 async function sign() {
  setBusy(true); setWorking(doc.id); setError('');
  try { onRecord(await mutate(`applicant/documents/${doc.id}/sign`, 'POST', { typedName: name, consent, agreed, ...(doc.requiresSignature && signature ? { signature: signature.image, signatureMethod: signature.method } : {}) })); setConfirming(false); }
  catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to sign. Please try again.'); setConfirming(false); }
  finally { setBusy(false); setWorking(''); }
 }
 return <article className="space-y-4 rounded-md border border-border p-4" aria-labelledby={`${id}-title`}>
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 id={`${id}-title`} className="font-medium">{doc.title}</h4><p className="text-xs text-muted-foreground">{doc.label} · version {doc.version} · {doc.pageCount} {doc.pageCount === 1 ? 'page' : 'pages'}</p></div>
   <a href={`/api/backend/applicant/documents/${doc.id}/file`} target="_blank" rel="noopener" onClick={() => void open()} className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm hover:bg-accent">Open document<span className="sr-only"> {doc.title} (opens in a new tab)</span></a></div>
  {doc.signed && <p className="text-sm text-success">{doc.requiresSignature ? 'Signed' : 'Acknowledged'} <LocalTime iso={doc.signed.signedAt}/>{current ? '' : ` (version ${doc.signed.version})`} · <a className="underline" href={`/api/backend/applicant/documents/${doc.signed.documentId}/signed`} target="_blank" rel="noopener">Download signed copy</a></p>}
  {!current && canSign && <div className="space-y-4 border-t border-border pt-4">
   {doc.signed && <p className="text-sm text-warning">A newer version was published. Open, review and sign version {doc.version}; your earlier signature does not cover it.</p>}
   {!opened && <p className="text-sm text-muted-foreground">Open the document first. It opens in a new tab.</p>}
   <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={agreed} disabled={!opened} onChange={event => setAgreed(event.target.checked)} className="mt-1 size-5"/><span>{doc.statement}<span lang="ru" className="mt-2 block text-muted-foreground">{doc.translatedStatement}</span><span className="mt-1 block text-xs text-muted-foreground">The Russian translation is for convenience; the English text governs.</span></span></label>
   <div className="text-sm"><label htmlFor={`${id}-name`}>Full legal name (Latin letters, as on your ID) *</label>
    <input ref={nameInput} id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} onBlur={() => setNameTouched(true)} maxLength={100} autoComplete="name"
     aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? `${id}-name-error` : undefined} className={inputClass}/>
    {nameError && <p id={`${id}-name-error`} className="mt-1 text-[13px] leading-5 text-danger">{nameError}</p>}</div>
   {doc.requiresSignature && <SignaturePad label="Your signature *" onChange={onSignature} disabled={disabled} allowTyped typedName={name} touch/>}
   <div className="space-y-2">
    <p id={`${id}-steps`} className="text-sm font-medium">{ready ? 'Ready to sign.' : 'Before you can sign:'}</p>
    <ul className="space-y-1 text-sm" aria-labelledby={`${id}-steps`}>{steps.map(step => <li key={step.label} className={`flex items-center gap-2 ${step.done ? 'text-success' : attempted ? 'text-danger' : 'text-muted-foreground'}`}>
     {step.done ? <Check aria-hidden="true" className="size-4"/> : <Circle aria-hidden="true" className="size-4"/>}{step.label}<span className="sr-only">{step.done ? ' (done)' : ' (still needed)'}</span></li>)}</ul>
    {attempted && !ready && <p role="alert" className="text-sm text-danger">Complete the steps marked above, then try again.</p>}
   </div>
   {error && <Notice message={error} error/>}
   <Button type="button" size="lg" disabled={disabled} onClick={review}>{doc.requiresSignature ? 'Sign document' : 'Acknowledge'}</Button>
  </div>}
  {!(!current && canSign) && error && <Notice message={error} error/>}
  {confirming && <Dialog open title={doc.requiresSignature ? `Sign ${doc.title}?` : `Acknowledge ${doc.title}?`} description="Your electronic signature is legally binding, the same as a handwritten one. It is recorded with the date, time, your IP address and browser, and cannot be withdrawn here." onClose={() => setConfirming(false)} busy={busy} protectChanges={false} closeLabel="Go back"
   actions={<Button type="button" onClick={() => void sign()}>{busy ? 'Signing…' : doc.requiresSignature ? 'Yes, sign' : 'Yes, acknowledge'}</Button>}>
   <p className="text-sm">Signing as <strong>{name.trim()}</strong>{signature?.method === 'TYPED' ? ' with your adopted typed signature' : ''}.</p>
  </Dialog>}
 </article>;
}
