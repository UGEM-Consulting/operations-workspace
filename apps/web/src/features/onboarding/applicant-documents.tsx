'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { PrivateImage } from '@/components/ui/private-image';
import { mutate } from '@/lib/client-api';
import { photoForUpload } from './photo';
import { SignaturePad } from './signature-pad';
import { ApplicantDocument, ApplicantRecord, inputClass } from './types';
const PHOTOS = [
 { item: 'selfiePhoto', path: 'selfie', key: 'selfie', title: 'Selfie', help: 'A clear, recent photo of your face looking at the camera in good light, without sunglasses or a hat. It becomes your profile photo.' },
 { item: 'idPhoto', path: 'id-selfie', key: 'idSelfie', title: 'Selfie holding your ID', help: 'Hold your government-issued photo ID next to your face so your face, the ID photo and your name are clearly readable. Only your manager and administrators can see this photo; it is checked by a person, never by face recognition.' },
] as const;
/** The "Documents & signatures" step: two required photos, then each company document opened, read and signed. */
export function ApplicantDocuments({ record, onRecord, busy }: { record: ApplicantRecord; onRecord: (record: ApplicantRecord) => void; busy: boolean }) {
 const docs = record.documents;
 const [working, setWorking] = useState(''), [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
 const [consent, setConsent] = useState(false), [photoVersion, setPhotoVersion] = useState(0);
 const disabled = busy || !!working;
 async function upload(photo: typeof PHOTOS[number], file: File | undefined) {
  if (!file) return;
  setWorking(photo.item); setMessage(''); setFailed(false);
  try {
   const image = await photoForUpload(file);
   onRecord(await mutate(`applicant/photos/${photo.path}`, 'POST', { image }));
   setPhotoVersion(version => version + 1); setMessage(`${photo.title} uploaded.`);
  } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : 'Upload failed. Please try again.'); }
  finally { setWorking(''); }
 }
 if (!docs.required) return <p className="text-sm text-muted-foreground">No photos or documents are required.</p>;
 const canSign = record.editableFields.includes('documents');
 return <div className="space-y-8">
  <section className="space-y-4" aria-labelledby="photos-heading">
   <div><h3 id="photos-heading" className="font-semibold">Photos *</h3><p className="text-sm text-muted-foreground">Both photos are required. Use your phone camera or choose an existing photo.</p></div>
   <div className="grid gap-4 sm:grid-cols-2">{PHOTOS.map(photo => {
    const uploaded = docs.photos[photo.key], editable = record.editableFields.includes(photo.item);
    return <div key={photo.item} className={`space-y-3 rounded-lg border p-4 ${record.correction?.requestedFields.includes(photo.item) ? 'border-warning/50' : 'border-border'}`}>
     <p className="font-medium">{photo.title}</p><p className="text-sm text-muted-foreground">{photo.help}</p>
     {uploaded ? <PrivateImage src={`/api/backend/applicant/photos/${photo.path}?v=${photoVersion}-${uploaded}`} alt={`Your ${photo.title.toLowerCase()}`} className="max-h-60 rounded-md border object-contain"/>
      : <p className="text-sm text-warning">Not uploaded yet.</p>}
     {editable && <label className="block text-sm"><span className="sr-only">{uploaded ? `Replace ${photo.title}` : `Upload ${photo.title}`}</span>
      <input type="file" accept="image/*" capture="user" disabled={disabled} onChange={event => { void upload(photo, event.target.files?.[0]); event.target.value = ''; }} className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-border file:bg-background file:px-4"/></label>}
     {working === photo.item && <p role="status" className="text-sm">Uploading…</p>}
    </div>;
   })}</div>
  </section>
  {docs.items.length > 0 && <section className="space-y-4" aria-labelledby="documents-heading">
   <div><h3 id="documents-heading" className="font-semibold">Documents *</h3><p className="text-sm text-muted-foreground">Open and read each document in full, then sign or acknowledge it. You can download a signed copy afterwards.</p></div>
   {docs.items.some(doc => !doc.signed) && canSign && <label className="flex items-start gap-3 rounded-lg border border-border p-4 text-sm"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} className="mt-1"/><span><span className="block font-medium">Consent to sign electronically</span>{docs.consent.text}<span lang="ru" className="mt-2 block text-muted-foreground">{docs.consent.translation}</span></span></label>}
   {docs.items.map(doc => <DocumentCard key={doc.id} doc={doc} consent={consent} canSign={canSign} disabled={disabled} onRecord={onRecord} setWorking={setWorking}/>)}
  </section>}
  <Notice message={message} error={failed}/>
 </div>;
}
function DocumentCard({ doc, consent, canSign, disabled, onRecord, setWorking }: { doc: ApplicantDocument; consent: boolean; canSign: boolean; disabled: boolean; onRecord: (record: ApplicantRecord) => void; setWorking: (value: string) => void }) {
 const [opened, setOpened] = useState(doc.viewed), [agreed, setAgreed] = useState(false), [name, setName] = useState(''), [signature, setSignature] = useState<string | null>(null);
 const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
 const current = doc.signed?.documentId === doc.id;
 const ready = opened && consent && agreed && /^[A-Za-z][A-Za-z .,'-]+$/.test(name.trim()) && (!doc.requiresSignature || !!signature);
 async function sign() {
  setBusy(true); setWorking(doc.id); setError('');
  try { onRecord(await mutate(`applicant/documents/${doc.id}/sign`, 'POST', { typedName: name, consent, agreed, ...(doc.requiresSignature ? { signature } : {}) })); setConfirming(false); }
  catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to sign. Please try again.'); setConfirming(false); }
  finally { setBusy(false); setWorking(''); }
 }
 return <article className="space-y-4 rounded-lg border border-border p-4">
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-medium">{doc.title}</h4><p className="text-xs text-muted-foreground">{doc.label} · version {doc.version} · {doc.pageCount} {doc.pageCount === 1 ? 'page' : 'pages'}</p></div>
   <a href={`/api/backend/applicant/documents/${doc.id}/file`} target="_blank" rel="noopener" onClick={() => setOpened(true)} className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm hover:bg-accent">Open document</a></div>
  {doc.signed && <p className="text-sm text-success">{doc.requiresSignature ? 'Signed' : 'Acknowledged'} {new Date(doc.signed.signedAt).toLocaleString()}{current ? '' : ` (version ${doc.signed.version})`} · <a className="underline" href={`/api/backend/applicant/documents/${doc.signed.documentId}/signed`} target="_blank" rel="noopener">Download signed copy</a></p>}
  {!current && canSign && <div className="space-y-4 border-t border-border pt-4">
   {doc.signed && <p className="text-sm text-warning">A newer version was published. Review and sign version {doc.version}.</p>}
   {!opened && <p className="text-sm text-muted-foreground">Open the document first. It opens in a new tab.</p>}
   <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={agreed} disabled={!opened} onChange={event => setAgreed(event.target.checked)} className="mt-1"/><span>{doc.statement}<span lang="ru" className="mt-2 block text-muted-foreground">{doc.translatedStatement}</span><span className="mt-1 block text-xs text-muted-foreground">The Russian translation is for convenience; the English text governs.</span></span></label>
   <label className="block text-sm">Full legal name (Latin letters, as on your ID) *<input value={name} onChange={event => setName(event.target.value)} maxLength={100} autoComplete="name" className={inputClass}/></label>
   {doc.requiresSignature && <SignaturePad label="Draw your signature *" onChange={setSignature} disabled={disabled}/>}
   {error && <Notice message={error} error/>}
   <Button type="button" disabled={!ready || disabled} onClick={() => setConfirming(true)}>{doc.requiresSignature ? 'Sign document' : 'Acknowledge'}</Button>
   {!consent && <p className="text-xs text-muted-foreground">Agree to sign electronically above to continue.</p>}
  </div>}
  {confirming && <Dialog open title={doc.requiresSignature ? `Sign ${doc.title}?` : `Acknowledge ${doc.title}?`} description="Your electronic signature is legally binding, the same as a handwritten one. It is recorded with the date, time, your IP address and browser, and cannot be withdrawn here." onClose={() => setConfirming(false)} busy={busy} protectChanges={false} closeLabel="Go back"
   actions={<Button type="button" onClick={() => void sign()}>{busy ? 'Signing…' : doc.requiresSignature ? 'Yes, sign' : 'Yes, acknowledge'}</Button>}>
   <p className="text-sm">Signing as <strong>{name.trim()}</strong>.</p>
  </Dialog>}
 </article>;
}
