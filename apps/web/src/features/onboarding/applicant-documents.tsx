'use client';
import { useId, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocalTime } from '@/components/ui/local-time';
import { PrivateImage } from '@/components/ui/private-image';
import { mutate } from '@/lib/client-api';
import { DocumentViewer, type ViewableDocument } from '@/features/documents/document-modal';
import { downloadBlob } from '@/features/documents/pdf';
import { PhotoButton, type ViewablePhoto } from '@/features/documents/photo-modal';
import { emptyMemory, SigningModal, type SignableDocument, type SigningMemory } from '@/features/documents/signing-modal';
import { photoForUpload } from './photo';
import { ApplicantRecord } from './types';
const PHOTOS = [
 { item: 'selfiePhoto', path: 'selfie', key: 'selfie', title: 'Selfie', help: 'A clear, recent photo of your face looking at the camera in good light, without sunglasses or a hat. It becomes your profile photo.' },
 { item: 'idPhoto', path: 'id-selfie', key: 'idSelfie', title: 'Selfie holding your ID', help: 'Hold your government-issued photo ID next to your face so your face, the ID photo and your name are clearly readable. Only your manager and administrators can see this photo; it is checked by a person, never by face recognition.' },
] as const;
type Photo = typeof PHOTOS[number];
/** The "Documents & signatures" step: two required photos, then each company document read and signed in a modal. */
export function ApplicantDocuments({ record, onRecord, busy }: { record: ApplicantRecord; onRecord: (record: ApplicantRecord) => void; busy: boolean }) {
 const docs = record.documents;
 const [working, setWorking] = useState(''), [photoVersion, setPhotoVersion] = useState(0);
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
   <h3 id="documents-heading" className="font-semibold">Documents *</h3>
   <DocumentRows record={record} onRecord={onRecord} disabled={disabled} canSign={canSign}/>
  </section>}
 </div>;
}
/** What they've signed or read, as they'll be sent. */
const signedCopies = (items: ApplicantRecord['documents']['items']): ViewableDocument[] => items.filter(doc => doc.signed).map(doc => ({ url: doc.requiresSignature ? `/api/backend/applicant/documents/${doc.signed!.documentId}/signed` : `/api/backend/applicant/documents/${doc.signed!.documentId}/file`, title: doc.title, certificate: doc.requiresSignature, meta: <>{doc.requiresSignature ? 'Signed' : 'Read'} <LocalTime iso={doc.signed!.signedAt} format="date"/></> }));
const ownPhotos = (record: ApplicantRecord): (ViewablePhoto & { label: string })[] => PHOTOS.filter(photo => record.documents.photos[photo.key]).map(photo => ({ src: `/api/backend/applicant/photos/${photo.path}?v=${record.documents.photos[photo.key]}`, title: photo.title, label: photo.title, alt: `Your ${photo.title.toLowerCase()}` }));
/** The contact list itself, with no certificate page, for keeping on their phone. */
function SaveContactList({ doc }: { doc: ApplicantRecord['documents']['items'][number] }) {
 const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
 async function save() {
  setBusy(true); setFailed(false);
  try {
   const response = await fetch(`/api/backend/applicant/documents/${doc.id}/file`, { credentials: 'same-origin' });
   if (!response.ok) throw new Error('not saved');
   downloadBlob(await response.blob(), 'quick-contact-list.pdf');
  } catch { setFailed(true); } finally { setBusy(false); }
 }
 return <><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save()}><Download aria-hidden="true" className="size-4"/>Save<span className="sr-only"> the contact list</span></Button>
  {failed && <span role="alert" className="text-[13px] text-danger">Couldn’t save it. Please try again.</span>}</>;
}
/** The last step shows what's being sent: their photos and documents, each opening over the page. */
export function ReviewAttachments({ record }: { record: ApplicantRecord }) {
 const [viewing, setViewing] = useState(-1);
 const photos = ownPhotos(record), signed = record.documents.items.filter(doc => doc.signed), copies = signedCopies(record.documents.items);
 if (!photos.length && !signed.length) return null;
 return <div className="space-y-5 border-t border-border pt-5">
  {photos.length > 0 && <section className="space-y-2" aria-labelledby="review-photos"><h3 id="review-photos" className="text-[15px] font-semibold">Your photos</h3>
   <div className="grid max-w-md grid-cols-2 gap-3">{photos.map(photo => <figure key={photo.src} className="min-w-0 space-y-1"><PhotoButton photos={photos} src={photo.src} label={`Open ${photo.alt.toLowerCase()}`} className="w-full"><PrivateImage src={photo.src} alt={photo.alt} className="aspect-[4/5] w-full rounded-md border bg-muted object-cover"/></PhotoButton><figcaption className="text-[13px] font-medium leading-5">{photo.label}</figcaption></figure>)}</div></section>}
  {signed.length > 0 && <section className="space-y-2" aria-labelledby="review-documents"><h3 id="review-documents" className="text-[15px] font-semibold">Your documents</h3>
   {signed.map((doc, index) => { const contactList = doc.kind === 'CONTACT_LIST', current = doc.signed!.documentId === doc.id; return <article key={doc.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card p-3 sm:px-4">
    <div className="min-w-0 flex-1"><h4 className="text-sm font-semibold">{contactList ? 'Quick Contact List' : doc.kind}</h4><p className="text-[13px] leading-5 text-muted-foreground">{doc.requiresSignature ? 'Signed' : 'Read'} <LocalTime iso={doc.signed!.signedAt} format="date"/>{current ? '' : ' (an earlier version)'}{contactList && current ? '. Keep a copy on your phone.' : ''}</p></div>
    <div className="flex items-center gap-2">{contactList && current && <SaveContactList doc={doc}/>}<Button type="button" size="sm" variant={contactList ? 'ghost' : 'outline'} onClick={() => setViewing(index)}>View<span className="sr-only"> {contactList ? 'Quick Contact List' : doc.kind}</span></Button></div>
   </article>; })}</section>}
  {viewing >= 0 && <DocumentViewer documents={copies} index={viewing} onClose={() => setViewing(-1)}/>}
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
  {uploaded ? <PhotoButton photos={ownPhotos(record).map(item => item.title === photo.title ? { ...item, src: `/api/backend/applicant/photos/${photo.path}?v=${version}-${uploaded}` } : item)} src={`/api/backend/applicant/photos/${photo.path}?v=${version}-${uploaded}`} label={`Open your ${photo.title.toLowerCase()}`}><PrivateImage src={`/api/backend/applicant/photos/${photo.path}?v=${version}-${uploaded}`} alt={`Your ${photo.title.toLowerCase()}`} className="max-h-60 rounded-md border object-contain"/></PhotoButton>
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
/** One row per document and one clear next action. Everything happens in the modal, with nothing to come back to. */
function DocumentRows({ record, onRecord, disabled, canSign }: { record: ApplicantRecord; onRecord: (record: ApplicantRecord) => void; disabled: boolean; canSign: boolean }) {
 const docs = record.documents;
 const [memory, setMemory] = useState<SigningMemory>(emptyMemory), [openId, setOpenId] = useState(''), [viewing, setViewing] = useState(-1);
 const signable: SignableDocument[] = docs.items.map(doc => ({ id: doc.id, title: doc.title, short: doc.kind === 'CONTACT_LIST' ? 'Quick Contact List' : doc.kind, pageCount: doc.pageCount, requiresSignature: doc.requiresSignature, statement: doc.statement, translatedStatement: doc.translatedStatement,
  fields: doc.fields ?? [], fileUrl: `/api/backend/applicant/documents/${doc.id}/file`, signedUrl: `/api/backend/applicant/documents/${doc.id}/signed`, viewPath: `applicant/documents/${doc.id}/view`, signPath: `applicant/documents/${doc.id}/sign`,
  ...(doc.requiresSignature ? {} : { acknowledgePath: `applicant/documents/${doc.id}/acknowledge` }), state: doc.signed?.documentId === doc.id ? 'done' : 'todo', fallbackName: `${doc.kind.toLowerCase()}.pdf` }));
 const nextId = canSign ? signable.find(doc => doc.state === 'todo')?.id : undefined, open = signable.find(doc => doc.id === openId);
 const signedItems = docs.items.filter(doc => doc.signed);
 const copies = signedCopies(docs.items);
 const done = signable.filter(doc => doc.state === 'done').length;
 return <>
  <p className="text-sm text-muted-foreground">{done} of {signable.length} done. Everything happens on this page.</p>
  {docs.items.map((doc, index) => { const item = signable[index], current = item.state === 'done', copy = signedItems.indexOf(doc);
   return <article key={doc.id} className={`flex items-center gap-3 rounded-md border bg-card p-4 ${nextId === doc.id ? 'border-primary' : 'border-border'}`}>
    <div className="min-w-0 flex-1"><h4 className="text-[15px] font-semibold leading-[22px]">{item.short}</h4>
     <p className="text-[13px] leading-5 text-muted-foreground">{doc.signed ? <>{doc.requiresSignature ? 'Signed' : 'Read'} <LocalTime iso={doc.signed.signedAt} format="date"/>{current ? '' : ' (an earlier version)'}</> : doc.requiresSignature ? 'To sign' : 'To read'} · {doc.pageCount} {doc.pageCount === 1 ? 'page' : 'pages'}</p>
     {doc.signed && !current && <p className="text-[13px] leading-5 text-warning">A newer version was published. Your earlier signature doesn’t cover it.</p>}</div>
    {current ? <div className="flex items-center gap-2">{doc.kind === 'CONTACT_LIST' && <SaveContactList doc={doc}/>}<Button type="button" size="sm" variant="ghost" onClick={() => setViewing(copy)}>View<span className="sr-only"> {item.short}</span></Button></div>
     : canSign ? <div className="flex flex-wrap justify-end gap-2">{doc.signed && <Button type="button" size="sm" variant="ghost" onClick={() => setViewing(copy)}>{doc.requiresSignature ? 'View signed copy' : 'View'}<span className="sr-only"> {item.short}, earlier version</span></Button>}<Button type="button" size="sm" variant={nextId === doc.id ? 'default' : 'outline'} disabled={disabled} onClick={() => setOpenId(doc.id)}>{doc.requiresSignature ? 'Read and sign' : 'Read'}<span className="sr-only"> {item.short}</span></Button></div>
      : doc.signed && <Button type="button" size="sm" variant="ghost" onClick={() => setViewing(copy)}>View<span className="sr-only"> {item.short}</span></Button>}
   </article>; })}
  {open && <SigningModal key={open.id} doc={open} documents={signable} consent={docs.consent.text} consentTranslation={docs.consent.translation} memory={memory} onMemory={setMemory} nameHint="as on your ID"
   onSigned={result => onRecord(result as ApplicantRecord)} onNext={next => setOpenId(next.id)} onClose={() => setOpenId('')}/>}
  {viewing >= 0 && <DocumentViewer documents={copies} index={viewing} onClose={() => setViewing(-1)}/>}
 </>;
}
