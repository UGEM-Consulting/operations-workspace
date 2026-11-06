'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, Link2 } from 'lucide-react';
import { ViewDocumentButton } from '@/features/documents/document-modal';
import { imageForUpload, PhotoError } from '@/features/onboarding/photo';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { LocalTime } from '@/components/ui/local-time';
import { DescriptionList } from '@/components/ui/description-list';
import { Checkbox, Field, Input, RadioGroup } from '@/components/ui/field';
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { fileToBase64, MAX_PDF_BYTES } from '@/lib/files';
import { OneTimeLinkDialog } from './one-time-link-dialog';
import { useToday } from './driver-documents';
import type { RenewalKind, RenewalLink, RenewalScan } from './types';

/** The driver a renewal is for: enough to name them and write against their version. */
export interface RenewalDriver { id: string; firstName: string; email: string | null; version: number }
export const renewalWords: Record<RenewalKind, string> = { LICENSE: 'driver’s license', MEDICAL_CARD: 'medical card' };
const titleWords: Record<RenewalKind, string> = { LICENSE: 'Driver’s license', MEDICAL_CARD: 'Medical card' };
// The same limits as the driver's own scanner: four pages, each small enough that all fit one upload.
const MAX_PAGES = 4, PAGE_BYTES = 760_000, PAGE_SIDE = 1800;
const possessive = (name: string) => `${name}’${name.endsWith('s') ? '' : 's'}`;

/**
 * Renewing a license or medical card (designed as RenewUploadScreen and RenewLinkScreen): with the document in hand,
 * upload it (a PDF or photos of each page), type the date printed on it and confirm it's the driver's, which saves it
 * checked and lifts the hold; or create a link for the driver to scan only that document, shown once
 * (RenewLinkReadyScreen). The API decides who may (Safety leads, the Safety manager, administrators, the owner). Either
 * way a link already out for this document stops working (`openLink`), so the dialog says so first.
 */
export function RenewDialog({ driver, kind, expired = false, openLink = null, initialHow = 'upload', onClose }: { driver: RenewalDriver; kind: RenewalKind; expired?: boolean;
  openLink?: RenewalLink | null; initialHow?: 'upload' | 'link'; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [how, setHow] = useState<'upload' | 'link'>(driver.email ? initialHow : 'upload');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(''), [fileError, setFileError] = useState('');
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const name = driver.firstName || 'the driver', words = renewalWords[kind];
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true); setError(''); setFileError('');
    try {
      if (how === 'link') {
        const result = await mutate<{ url: string; expiresAt: string }>(`safety/drivers/${driver.id}/renewals`, 'POST', { version: driver.version, kind });
        setLink(result); router.refresh();
        return;
      }
      const files = (form.getAll('file') as File[]).filter(file => file.size > 0);
      const pdfs = files.filter(file => file.type === 'application/pdf');
      if (!files.length) { setFileError('Choose a PDF, or photos of each page.'); return; }
      if (pdfs.length && files.length > 1) { setFileError('Choose one PDF, or photos only.'); return; }
      if (pdfs.length && pdfs[0].size > MAX_PDF_BYTES) { setFileError('The PDF is larger than 3 MB.'); return; }
      if (files.length > MAX_PAGES) { setFileError(`Choose at most ${MAX_PAGES} photos, one per page.`); return; }
      // One photo at a time: decoding several full-size photos at once can exhaust a phone's memory.
      const pages: string[] = [];
      if (!pdfs.length) for (const file of files) pages.push(await imageForUpload(file, { maxSide: PAGE_SIDE, maxBytes: PAGE_BYTES }));
      const number = String(form.get('number') ?? '').trim();
      await mutate(`safety/drivers/${driver.id}/documents/renew`, 'POST', { version: driver.version, kind, ...(pdfs.length ? { file: await fileToBase64(pdfs[0]) } : { pages }),
        expiresOn: form.get('expiresOn'), confirmed: form.get('confirmed') === 'on', ...(number ? { number } : {}) });
      toast({ title: `${titleWords[kind]} renewed`, description: 'It’s checked and counts from now.' });
      onClose(); router.refresh();
    } catch (error) {
      if (error instanceof PhotoError) setFileError(error.message);
      else setError(errorMessage(error, 'Unable to save. Your entries have been kept.'));
    } finally { setPending(false); }
  }
  if (link) return <OneTimeLinkDialog link={link} email={driver.email} title={`Link ready for ${name}`} description={`Copy it and send it to ${name}. You won’t see it again.`} onClose={onClose}>
    <p className="text-sm text-muted-foreground">{name} signs in with a code sent to {driver.email}, scans the {words} and sends it. You get it here to check.</p>
  </OneTimeLinkDialog>;
  return <Dialog open onClose={onClose} busy={pending} title={`Renew ${possessive(name)} ${words}`} description={`The new one replaces the ${expired ? 'expired' : 'current'} ${words}. The old scan stays in their file.`}
    actions={<Button type="submit" form="renew-document" disabled={pending}>{pending ? 'Saving…' : how === 'upload' ? <><Check aria-hidden="true" className="size-4" />Save and lift the hold</> : <><Link2 aria-hidden="true" className="size-4" />Create link</>}</Button>}>
    <form id="renew-document" onSubmit={submit} className="space-y-4">
      {openLink && !openLink.expired && <Alert tone="warning" title={`${name} has a link for this ${words}`}>
        <p>You sent it on <LocalTime iso={openLink.createdAt} format="date" />. Uploading the {words} or creating a new link stops it.</p></Alert>}
      <RadioGroup name="how" label="How" value={how} onChange={value => { setHow(value as 'upload' | 'link'); setError(''); }} options={[
        { value: 'upload', label: 'I have it: upload it now', description: 'A PDF, or photos of each page.' },
        { value: 'link', label: `Send ${name} a link to scan it`, disabled: !driver.email,
          description: driver.email ? 'They sign in with a code sent to their email, scan only this document, and you check it.' : 'Add their email to the record first. The link works only with that address.' }]} />
      {how === 'upload' ? <>
        <Field id="renew-file" label={titleWords[kind]} hint={`PDF or photos, 1 to ${MAX_PAGES} pages, 3 MB maximum.`} error={fileError}>
          <input id="renew-file" name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/heic" multiple required
            aria-invalid={fileError ? true : undefined} aria-describedby={fileError ? 'renew-file-hint renew-file-error' : 'renew-file-hint'} onChange={() => setFileError('')}
            className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>
        <Input label="Expires" name="expiresOn" type="date" required min={today ?? undefined} width="sm" hint={`As printed on the ${words}.`} />
        {kind === 'LICENSE' && <Input label="License number" name="number" optional maxLength={40} autoComplete="off" spellCheck={false} width="md" />}
        <Checkbox name="confirmed" required label={`I checked that this is ${possessive(name)} ${words} and the date matches it.`} />
      </> : driver.email && <>
        <DescriptionList layout="rows" items={[{ label: 'Email', value: driver.email }, { label: 'Works for', value: '7 days, or until they send it' }]} />
        <p className="text-sm text-muted-foreground">You send the link yourself, by text or email. The workspace doesn’t message drivers.</p>
      </>}
      <Notice message={error} error />
      <PendingHint pending={pending} />
    </form>
  </Dialog>;
}

/**
 * Checking the scan a driver sent (designed as RenewCheckScreen): open it and type the date printed on it, which lifts the
 * hold, or mark it as not readable and send a new link.
 */
export function CheckRenewalDialog({ driver, kind, scan, onClose, onUnreadable }: { driver: RenewalDriver; kind: RenewalKind; scan: RenewalScan; onClose: () => void; onUnreadable: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState<'check' | 'unreadable' | null>(null);
  const [error, setError] = useState('');
  const words = renewalWords[kind], today = useToday();
  const document = { url: `/api/backend/safety/drivers/${driver.id}/documents/${scan.id}/file`, title: titleWords[kind], meta: `${scan.pageCount} ${scan.pageCount === 1 ? 'page' : 'pages'}` };
  async function check(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending('check'); setError('');
    try {
      await mutate(`safety/drivers/${driver.id}/documents/${scan.id}/verify`, 'POST', { version: scan.version, expiresOn: new FormData(event.currentTarget).get('expiresOn') });
      toast({ title: `${titleWords[kind]} checked`, description: 'It counts from now.' }); onClose(); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(null); }
  }
  async function unreadable() {
    if (pending) return;
    setPending('unreadable'); setError('');
    try {
      await mutate(`safety/drivers/${driver.id}/documents/${scan.id}/unreadable`, 'POST', { version: scan.version });
      toast({ title: 'Marked as not readable' }); router.refresh(); onUnreadable();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Try again.')); }
    finally { setPending(null); }
  }
  return <Dialog open onClose={onClose} busy={!!pending} title={`Check the new ${words}`} description="Open it and type what it shows."
    actions={<>
      <Button type="button" variant="outline" disabled={!!pending} onClick={() => void unreadable()}>{pending === 'unreadable' ? 'Saving…' : 'Not readable'}</Button>
      <Button type="submit" form="check-renewal" disabled={!!pending}>{pending === 'check' ? 'Saving…' : <><Check aria-hidden="true" className="size-4" />Checked</>}</Button>
    </>}>
    <form id="check-renewal" onSubmit={check} className="space-y-4">
      <ViewDocumentButton variant="outline" size="default" documents={[document]}>Open the {words}</ViewDocumentButton>
      {/* A renewal must still be valid: a date that has passed means the old one was photographed, so mark it as not readable. */}
      <Input label="Expires" name="expiresOn" type="date" required min={today ?? undefined} width="sm" hint={`As printed on the ${words}. If it has already passed, choose Not readable.`} />
      <Notice message={error} error />
    </form>
  </Dialog>;
}

/** Stops the open renewal link for one document. */
export async function cancelRenewalLink(driver: RenewalDriver, kind: RenewalKind) {
  await mutate(`safety/drivers/${driver.id}/renewals/cancel`, 'POST', { version: driver.version, kind });
}
