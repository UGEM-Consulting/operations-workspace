'use client';
import { useCallback, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/field';
import type { SavedSignature } from '@/features/auth/saved-signature';
import { SignaturePad, type SignatureMethod } from '@/features/onboarding/signature-pad';
import { DocumentModal } from './document-modal';
import { FieldMark, fieldText, type DocumentField } from './fields';
import { PdfPages, usePdf } from './pdf';

const LATIN_NAME = /^[A-Za-z][A-Za-z .,'-]+$/, LATIN_TITLE = /^[A-Za-z0-9][A-Za-z0-9 .,'&/-]*$/;
/**
 * The manager reads the signed NDA and countersigns beside it. Their name, title and date fill in on the page as they go; nothing is
 * recorded here. It's sent with the approval, in the decision's transaction.
 */
export function CountersignModal({ url, title, meta, statement, fields, savedSignature, useSaved, onUseSaved, name, onName, signature, onSignature, jobTitle, onJobTitle, onDone, onClose }: {
  url: string; title: string; meta: string; statement: string; fields: DocumentField[]; savedSignature: SavedSignature | null; useSaved: boolean; onUseSaved: (value: boolean) => void; name: string; onName: (value: string) => void;
  signature: { image: string; method: SignatureMethod } | null; onSignature: (image: string | null, method: SignatureMethod) => void; jobTitle: string; onJobTitle: (value: string) => void; onDone: () => void; onClose: () => void;
}) {
  const source = useMemo(() => ({ url, fallbackName: 'nda-signed.pdf' }), [url]), { file, failure, reload } = usePdf(source), now = useMemo(() => new Date(), []);
  const [zoom, setZoom] = useState(1), [agreed, setAgreed] = useState(false), [error, setError] = useState(''), [changing, setChanging] = useState(!signature);
  const company = useMemo(() => fields.filter(field => field.signer === 'COMPANY'), [fields]), needsTitle = company.some(field => field.kind === 'TITLE');
  const shownName = useSaved && savedSignature ? savedSignature.typedName : name.trim(), image = useSaved && savedSignature ? savedSignature.image : signature?.image;
  const first = company[0], focus = useMemo(() => first ? { page: first.page, y: first.y } : null, [first]);
  const overlay = useCallback((number: number, width: number, height: number) => company.filter(field => field.page === number).map((field, index) => {
    if (field.kind === 'SIGNATURE' && image) return <FieldMark key={index} field={field} pageWidth={width} pageHeight={height} image={image} />;
    const text = fieldText(field.kind, { name: shownName, title: jobTitle.trim(), at: now });
    return text ? <FieldMark key={index} field={field} pageWidth={width} pageHeight={height} text={text} /> : <FieldMark key={index} field={field} pageWidth={width} pageHeight={height} label={field.kind === 'SIGNATURE' ? 'Your signature' : field.kind === 'TITLE' ? 'Your title' : 'Your name'} active />;
  }), [company, image, shownName, jobTitle, now]);
  // Coming back to a signature already made shows it. An adopted one is the typed name in a script, so a different name needs adopting again.
  function changeName(value: string) {
    onName(value);
    if (!changing && signature?.method === 'TYPED' && value.trim() !== name.trim()) { setChanging(true); onSignature(null, 'TYPED'); }
  }
  function finish() {
    if (!useSaved && !LATIN_NAME.test(name.trim())) { setError('Type your full legal name in Latin letters.'); return; }
    if (!image) { setError('Draw or adopt your signature.'); return; }
    if (needsTitle && !LATIN_TITLE.test(jobTitle.trim())) { setError('Type your job title in Latin letters.'); return; }
    if (!agreed) { setError('Confirm the statement.'); return; }
    onDone();
  }
  const panel = <>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 lg:p-5">
      <h3 className="text-[17px] font-semibold leading-6">Countersign for UGEM</h3>
      <Checkbox checked={agreed} onChange={event => setAgreed(event.target.checked)} label={statement} />
      {useSaved && savedSignature ? <div className="space-y-2"><p className="text-sm font-medium">Your saved signature</p>
        <div className="grid h-24 place-items-center rounded-md border border-input bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- server-provided data URL */}
          <img src={savedSignature.image} alt={`Your saved signature for ${savedSignature.typedName}`} className="max-h-full max-w-full object-contain" /></div>
        <p className="text-sm">Signing as <span className="font-medium">{savedSignature.typedName}</span></p>
        <Button type="button" variant="outline" size="sm" onClick={() => onUseSaved(false)}>Sign here instead</Button></div>
        : <><Input label="Your full legal name" hint="Latin letters, as on your ID." value={name} onChange={event => changeName(event.target.value)} maxLength={100} autoComplete="name" width="full" />
          {signature && !changing ? <div className="space-y-2"><p className="text-sm font-medium">Your signature</p>
            <div className="grid h-24 place-items-center rounded-md border border-input bg-white p-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL the signer just made */}
              <img src={signature.image} alt="Your signature" className="max-h-full max-w-full object-contain" /></div>
            <Button type="button" variant="outline" size="sm" onClick={() => { setChanging(true); onSignature(null, signature.method); }}>Change signature</Button></div>
            : <SignaturePad label="Your signature" onChange={onSignature} allowTyped typedName={name} />}
          {savedSignature ? <Button type="button" variant="outline" size="sm" onClick={() => onUseSaved(true)}>Use my saved signature</Button>
            : <p className="text-[13px] leading-5 text-muted-foreground">Tip: save your signature on <a className="text-primary underline" href="/account/security">Account security</a> to skip this next time.</p>}</>}
      {needsTitle && <Input label="Title" hint="Remembered for your next approval." value={jobTitle} onChange={event => onJobTitle(event.target.value)} maxLength={100} width="full" />}
      <dl className="rounded-md bg-muted px-4 py-3 text-[13px] leading-5"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Date</dt><dd className="font-medium">{fieldText('DATE', { at: now })}</dd></div></dl>
    </div>
    <div className="shrink-0 space-y-3 border-t p-4 lg:px-5"><Notice message={error} error /><Button type="button" size="lg" className="w-full" onClick={finish}><Check aria-hidden="true" className="size-4" />Use this countersignature</Button>
      <p className="text-xs leading-[18px] text-muted-foreground">Nothing is final until you approve the application.</p></div>
  </>;
  return <DocumentModal title={title} meta={meta} file={file} failure={failure} reload={reload} zoom={zoom} onZoom={setZoom} onClose={onClose} panel={panel} panelGrows
    pages={file && <PdfPages file={file} zoom={zoom} overlay={overlay} focus={focus} className="flex-1" />} />;
}
