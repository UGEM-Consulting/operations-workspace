'use client';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { DocumentViewer } from '@/features/documents/document-modal';
import type { DocumentField } from '@/features/documents/fields';
import { emptyMemory, SigningModal, type SignableDocument, type SigningMemory } from '@/features/documents/signing-modal';
import { ApiError } from '@/lib/client-api';

export interface DriverContractView { role: 'DRIVER' | 'OWNER'; email: string; expiresAt: string; signedAt: string | null; bothSigned: boolean; consent: string; unit: string; company: string; driver: string;
  driverSignedAt: string | null; viewed: boolean; address: string | null; signerName: string | null; signerTitle: string | null;
  document: { id: string; title: string; version: number; pageCount: number; fields: DocumentField[] } }
// The owner's signer fills the places marked for the company: shown to them as theirs, and the driver's as already signed.
const swap = (fields: DocumentField[]) => fields.map(field => ({ ...field, signer: field.signer === 'COMPANY' ? 'SIGNER' as const : 'COMPANY' as const }));

/**
 * The page a contract link opens after the emailed code (AckSignPhoneScreen for the driver, OwnerSignPhoneScreen for the
 * truck owner's signer): the one document, read, agreed and signed. No sign-in to the workspace and nothing else to see.
 */
export function DriverContract({ view: initial, focusHeading, onEnded }: { view: DriverContractView; focusHeading: boolean; onEnded: (end: string | ApiError) => void }) {
  const [view, setView] = useState(initial), [open, setOpen] = useState(false), [viewing, setViewing] = useState(false), [memory, setMemory] = useState<SigningMemory>(emptyMemory);
  const [address, setAddress] = useState(initial.address ?? ''), [title, setTitle] = useState(initial.signerTitle ?? '');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focusHeading || view.signedAt) heading.current?.focus(); }, [focusHeading, view.signedAt]);
  const owner = view.role === 'OWNER', ready = owner ? title.trim().length >= 2 : address.trim().length >= 5;
  const doc: SignableDocument = { id: view.document.id, title: view.document.title, short: view.document.title, pageCount: view.document.pageCount, requiresSignature: true,
    statement: `I have read the ${view.document.title} and I agree to it${owner ? ` for ${view.company}` : ''}.`, fields: owner ? swap(view.document.fields) : view.document.fields,
    fileUrl: '/api/backend/driver/contract/file', signedUrl: '/api/backend/driver/contract/signed', viewPath: 'driver/contract/view', signPath: 'driver/contract/sign', state: view.signedAt ? 'done' : 'todo',
    fallbackName: 'driver-and-contractor-acknowledgement.pdf', extra: owner ? { title: title.trim() } : { address: address.trim() }, otherSigner: owner ? 'Signed by the driver' : `${view.company} signs` };
  if (view.signedAt) return <Card className="space-y-4 p-6 sm:p-8">
    <CheckCircle2 aria-hidden="true" className="size-8 text-success" />
    <h1 ref={heading} tabIndex={-1} className="text-2xl font-normal outline-none">Signed</h1>
    <p className="text-sm text-muted-foreground">Thank you. You signed the {view.document.title} on <LocalTime iso={view.signedAt} format="date" />.
      {view.bothSigned ? ' You can download the signed copy.' : ` ${view.company} signs it next. You can download the signed copy once both have signed.`}</p>
    {view.bothSigned && <Button variant="outline" onClick={() => setViewing(true)}>View the signed copy</Button>}
    {viewing && <DocumentViewer documents={[{ url: '/api/backend/driver/contract/signed', title: view.document.title }]} onClose={() => setViewing(false)} />}
  </Card>;
  return <Card className="space-y-6 p-6 sm:p-8">
    <div className="space-y-2">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-normal outline-none">{owner ? `Sign for ${view.company}` : 'Sign before your first load'}</h1>
      <p className="text-sm text-muted-foreground">{owner ? `${view.driver} will drive your unit ${view.unit} under the carrier’s authority.` : `UGEM Safety sent this for unit ${view.unit}.`} The link works until <LocalTime iso={view.expiresAt} format="date" />.</p>
    </div>
    <section className="space-y-3" aria-labelledby="contract-heading">
      <h2 id="contract-heading" className="text-lg font-medium">{view.document.title}</h2>
      {!owner && <p className="text-sm text-muted-foreground">You drive for {view.company}, which leases unit {view.unit} to the carrier. It says who pays you and who sets your schedule.</p>}
      <p className="text-[13px] text-muted-foreground">Version {view.document.version} · {view.document.pageCount} {view.document.pageCount === 1 ? 'page' : 'pages'}{owner && view.driverSignedAt ? <> · signed by {view.driver} <LocalTime iso={view.driverSignedAt} format="date" /></> : ' · your name and address are filled in'}</p>
      {owner ? <>
        <Input label="Company" value={view.company} readOnly width="full" />
        <Input label="Your title" value={title} onChange={event => setTitle(event.target.value)} required maxLength={100} width="full" hint="For example Owner. It goes on the document." />
      </> : <Input label="Your home address" value={address} onChange={event => setAddress(event.target.value)} required maxLength={300} width="full" hint="Street, city, state and ZIP, in Latin letters. It goes on the document." />}
      <Button size="lg" className="w-full" disabled={!ready} onClick={() => setOpen(true)}>{owner ? 'Read and sign for the company' : 'Read and sign'}</Button>
    </section>
    <p className="text-[13px] text-muted-foreground">{owner ? `Once you sign you can download the signed copy. Safety keeps it in ${view.driver}’s file.` : `${view.company} signs it next. You can download the signed copy once both have signed.`}</p>
    {open && <SigningModal doc={doc} documents={[doc]} consent={view.consent} memory={{ ...memory, name: memory.name || (owner ? view.signerName ?? '' : '') }} onMemory={setMemory} nameHint={owner ? 'your full name' : 'as on your license'}
      onSigned={result => setView(result as DriverContractView)} onNext={() => setOpen(false)} onClose={() => setOpen(false)}
      onFailure={failure => { if (failure instanceof ApiError && failure.kind === 'applicant-session') { onEnded(failure); return true; } return false; }} />}
  </Card>;
}
