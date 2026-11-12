'use client';
import { useRouter } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { BadgeCheck, Check, FileText } from 'lucide-react';
import { ViewDocumentButton } from '@/features/documents/document-modal';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { DOCUMENT_KINDS, documentLabels, NOT_RECHECKED, RENEWAL_KINDS, workAuthorizationTypes, type DriverDocumentRow, type DriverProfile, type RenewalKind, type RenewalScan } from './types';
import { latestReminder } from './reminder-words';

const date = (value: string | null) => value ? <LocalTime iso={`${value}T12:00:00Z`} format="date" /> : null;
const pages = (count: number) => `${count} ${count === 1 ? 'page' : 'pages'}`;
// Today's US date, read only in the browser: the server renders no Expired badge, so the first render matches it whatever
// its clock says. Eastern (the default) is the day the API checks entered dates and expiry against; a waiting period ends
// only once the Pacific date reaches it (usDay in screening-rules.ts), so the decision card asks for that one.
const noSubscription = () => () => undefined;
export const useToday = (timeZone: 'America/New_York' | 'America/Los_Angeles' = 'America/New_York') =>
  useSyncExternalStore(noSubscription, () => new Date().toLocaleDateString('en-CA', { timeZone }), () => null);

/** What the Documents card asks the page to open for a license or medical card renewal (the dialogs live on the page). */
export interface RenewalActions { renew: (kind: RenewalKind) => void; check: (kind: RenewalKind, scan: RenewalScan) => void; cancelLink: (kind: RenewalKind) => void }

/**
 * The driver's scanned documents (each one PDF, opened in a new tab) and Safety's check of each: a person reads the
 * document and records its expiry date and, except for work authorization, its number. Screeners and the driver's owner
 * verify once the driver submits. Once the driver is approved, licenses and medical cards are renewed here (`renewals`,
 * designed as RenewDriverPageScreen): Renew, a link out, or a scan the driver sent waiting for its check. The API records
 * every time someone opens a scan.
 */
export function DriverDocuments({ driver, canVerify, renewals }: { driver: DriverProfile; canVerify: boolean; renewals?: RenewalActions }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [verifying, setVerifying] = useState<DriverDocumentRow | null>(null);
  // A work authorization's type, which Safety may correct when checking it (WorkAuthCheckPermitScreen).
  const [subtype, setSubtype] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // Always license, medical card, work authorization, so a renewed one keeps its place.
  // A driver added from a paper file has no application; their catch-up scans are checked like submitted ones (section 34).
  const documents = [...(driver.documents ?? [])].sort((a, b) => DOCUMENT_KINDS.indexOf(a.kind) - DOCUMENT_KINDS.indexOf(b.kind)), submitted = driver.application?.status === 'SUBMITTED' || !!driver.paperFile;
  const fileUrl = (document: DriverDocumentRow) => `/api/backend/safety/drivers/${driver.id}/documents/${document.id}/file`;
  const renewing = (document: DriverDocumentRow) => renewals && (RENEWAL_KINDS as string[]).includes(document.kind) ? driver.renewals?.find(row => row.kind === document.kind) ?? null : null;
  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!verifying || pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    try {
      await mutate(`safety/drivers/${driver.id}/documents/${verifying.id}/verify`, 'POST', { version: verifying.version, expiresOn: String(form.get('expiresOn') ?? ''),
        ...(verifying.kind === 'WORK_AUTHORIZATION' ? (subtype ? { subtype } : {}) : { number: String(form.get('number') ?? '').trim() }) });
      toast({ title: `${documentLabels[verifying.kind]} ${checking ? 'checked' : 'verified'}` }); setVerifying(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  // Once the driver is approved the card says Check and Checked, as the renewal dialogs do; screening says Verify.
  const checking = !!renewals;
  function open(document: DriverDocumentRow) { setVerifying(document); setSubtype(document.subtype ?? ''); setError(''); }
  const description = renewals ?'Licenses and medical cards are renewed here once the driver is cleared. The earlier scan is kept.'
    : submitted ? 'Scanned by the driver with their phone. Open each one and record what it shows.' : 'Scanned by the driver with their phone. You can verify them once the driver submits.';
  return <Card id="documents" className="scroll-mt-20">
    <CardHeader title="Documents" description={description} />
    {documents.length ? <ul className="mt-3 divide-y divide-border border-t border-border">{documents.map(document => {
      const renewal = renewing(document), kind = document.kind as RenewalKind;
      // A catch-up scan waiting for its check: the paper file's date still counts (holds, Expiring documents).
      const paperNote = document.paperDate ? <> · paper file {document.paperDate.expiresOn ? <>date {date(document.paperDate.expiresOn)}</> : 'record'} counts until it’s checked</> : null;
      // A scan the driver sent is the current document until someone checks it; the hold still counts the checked one.
      const scan = renewal?.scan?.id === document.id ? renewal.scan : null;
      const checkedOn = renewal ? renewal.checked?.expiresOn ?? null : document.expiresOn;
      const expired = !!(today && checkedOn && checkedOn < today);
      // A date typed from the paper file has no scan to open.
      const view = document.fromPaper ? null : <ViewDocumentButton documents={[{ url: fileUrl(document), title: documentLabels[document.kind], meta: pages(document.pageCount) }]}>View<span className="sr-only"> {documentLabels[document.kind]}</span></ViewDocumentButton>;
      const size = document.fromPaper ? 'Paper file · no scan yet' : pages(document.pageCount);
      const label = <span className="sr-only"> {documentLabels[document.kind]}</span>;
      let meta: React.ReactNode, badge: React.ReactNode, actions: React.ReactNode;
      // What needs someone first: a scan to check, then a link that is out (also after Not readable), then an unreadable scan.
      if (document.kind === 'RETURN_TO_DUTY') {
        meta = <>{pages(document.pageCount)} · scanned <LocalTime iso={document.createdAt} format="date" /> · for the Safety Director, after a Yes to a DOT question</>;
        badge = <Badge label="Restricted" tone="neutral" />;
        actions = view;
      } else if (renewal && renewals && scan && !scan.unreadable) {
        meta = <>New scan <LocalTime iso={scan.createdAt} format="date" /> · {pages(scan.pageCount)} · waiting for your check{paperNote}</>;
        badge = <Badge label="Waiting for your check" tone="warning" />;
        actions = <>{view}<Button size="sm" onClick={() => renewals.check(kind, scan)}>Check it{label}</Button></>;
      } else if (renewal && renewals && renewal.link) {
        // A link an expiration reminder made says so, with how that reminder went out (a link Safety sent is never replaced by one).
        const reminded = latestReminder(driver, document.kind, checkedOn), link = renewal.link;
        const sentWith = link.fromReminder ? `link sent with the ${reminded?.channel === 'TELEGRAM' ? 'Telegram' : reminded?.channel === 'EMAIL' ? 'email' : 'expiration'} reminder` : 'link sent';
        meta = <>{scan ? 'Last scan not readable' : expired ? 'Expired' : 'Expires'}{scan ? null : <> {date(checkedOn)}</>} · {sentWith} <LocalTime iso={link.createdAt} format="date" />, {link.expired ? 'no longer works' : <>works until <LocalTime iso={link.expiresAt} format="date" /></>}</>;
        badge = <Badge label={renewal.link.expired ? 'Link expired' : 'Link sent'} tone={renewal.link.expired ? 'neutral' : 'info'} />;
        actions = <>{view}{renewal.link.expired ? <Button size="sm" variant={expired ? 'default' : 'outline'} onClick={() => renewals.renew(kind)}>Renew{label}</Button>
          : <Button size="sm" variant="outline" onClick={() => renewals.cancelLink(kind)}>Cancel link{label}</Button>}</>;
      } else if (renewal && renewals && scan) {
        meta = <>New scan <LocalTime iso={scan.createdAt} format="date" /> · {pages(scan.pageCount)} · not readable</>;
        badge = <Badge label="Not readable" tone="danger" />;
        actions = <>{view}<Button size="sm" onClick={() => renewals.renew(kind)}>Renew{label}</Button></>;
      } else if (renewals && document.verifiedAt) {
        // Once the driver is approved: what counts is the date and the page count (RenewDriverPageScreen).
        // A US passport or green card isn't re-checked when it expires (WorkAuthCheckGreenCardScreen).
        const notRechecked = !!document.subtype && NOT_RECHECKED.includes(document.subtype);
        const reminded = latestReminder(driver, document.kind, document.expiresOn);
        meta = <>{notRechecked ? 'Not re-checked when it expires · ' : document.expiresOn ? <>{expired ? 'Expired' : 'Expires'} {date(document.expiresOn)} · </> : null}{size}{document.uploadedBySafety && !document.fromPaper ? ' · uploaded by Safety' : ''}
          {reminded && reminded.status === 'SENT' && <> · reminded by {reminded.channel === 'TELEGRAM' ? 'Telegram' : 'email'} <LocalTime iso={reminded.sentAt ?? reminded.createdAt} format="date" /></>}</>;
        badge = <Badge label={expired && !notRechecked ? 'Expired' : 'Checked'} tone={expired && !notRechecked ? 'danger' : 'success'} />;
        actions = <>{view}{renewal ? <Button size="sm" variant={expired ? 'default' : 'outline'} onClick={() => renewals.renew(kind)}>Renew{label}</Button>
          : canVerify && submitted && !document.fromPaper && <Button size="sm" variant="outline" onClick={() => open(document)}>Edit{label}</Button>}</>;
      } else {
        meta = <>{size}{document.fromPaper ? null : <> · {document.uploadedBySafety ? 'uploaded' : 'scanned'} <LocalTime iso={document.createdAt} format="date" /></>}{paperNote}
          {document.verifiedAt && <> · {document.number ? <>No. <span className="font-mono">{document.number}</span> · </> : null}{document.expiresOn ? <>expires {date(document.expiresOn)} · </> : null}verified by {document.verifiedBy ?? 'a former account'}</>}</>;
        badge = document.verifiedAt ? <Badge label={expired ? 'Expired' : 'Verified'} tone={expired ? 'danger' : 'success'} /> : <Badge label="Not verified" tone="neutral" />;
        actions = <>{view}
          {renewal && renewals ? <Button size="sm" variant={expired ? 'default' : 'outline'} onClick={() => renewals.renew(kind)}>Renew{label}</Button>
            : canVerify && submitted && !document.fromPaper && <Button size="sm" variant="outline" onClick={() => open(document)}><BadgeCheck aria-hidden="true" className="size-4" />{document.verifiedAt ? 'Edit' : checking ? 'Check' : 'Verify'}{label}</Button>}</>;
      }
      return <li key={document.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
        <FileText aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{documentLabels[document.kind]}{document.subtype ? <span className="font-normal text-muted-foreground"> · {workAuthorizationTypes[document.subtype] ?? document.subtype}</span> : null}</p>
          <p className="text-[13px] text-muted-foreground">{meta}</p>
        </div>
        {badge}
        <span className="flex gap-1">{actions}</span>
      </li>;
    })}</ul> : <CardBody><EmptyState compact title="No documents yet" description="The driver scans them while filling in their application." /></CardBody>}
    {verifying && <Dialog open onClose={() => setVerifying(null)} busy={pending} title={`${checking ? 'Check' : 'Verify'} the ${documentLabels[verifying.kind].toLowerCase()}`}
      description={verifying.kind === 'WORK_AUTHORIZATION' ? 'Open it and record what it is. Never record passport, card or A-numbers.' : 'Open the document, check it’s readable and belongs to this driver, then record what it shows.'}
      actions={<Button type="submit" form="verify-document" disabled={pending}>{pending ? 'Saving…' : checking ? <><Check aria-hidden="true" className="size-4" />Checked</> : 'Mark as verified'}</Button>}>
      <form id="verify-document" onSubmit={verify} className="space-y-4">
        <ViewDocumentButton variant="outline" documents={[{ url: fileUrl(verifying), title: documentLabels[verifying.kind], meta: pages(verifying.pageCount) }]}>Open the {documentLabels[verifying.kind].toLowerCase()}</ViewDocumentButton>
        {verifying.kind === 'WORK_AUTHORIZATION'
          ? <>
            {/* The driver chose what to give; Safety corrects the type only if the scan shows another document. */}
            <Select label="Document" value={subtype} onChange={event => setSubtype(event.target.value)} placeholder="Choose a document" width="md" required
              options={Object.entries(workAuthorizationTypes).map(([value, text]) => ({ value, label: text }))}
              hint={verifying.subtype ? `The driver chose ${workAuthorizationTypes[verifying.subtype] ?? 'another document'}. Change it if the scan shows another document.` : undefined} />
            {NOT_RECHECKED.includes(subtype)
              ? <Alert tone="info" title="No expiration date needed"><p>A US passport or green card isn’t re-checked when it expires (Form I-9 rules), so it never shows in Expiring documents.</p></Alert>
              : <Input label="Expires" name="expiresOn" type="date" required={subtype === 'WORK_PERMIT'} optional={subtype !== 'WORK_PERMIT'} defaultValue={verifying.expiresOn ?? ''} width="sm"
                hint={`As printed on the ${subtype === 'WORK_PERMIT' ? 'card' : 'document'}. Expiring documents lists it 60 days before, to re-check it.${subtype === 'WORK_PERMIT' ? '' : ' Leave it empty if it doesn’t expire.'}`} />}
          </>
          : <>
            <Input label="Document number" name="number" optional defaultValue={verifying.number ?? ''} maxLength={40} autoComplete="off" spellCheck={false} width="full" />
            <Input label="Expiration date" name="expiresOn" type="date" required defaultValue={verifying.expiresOn ?? ''} width="md" hint="As printed on the document. Expiring documents lists it 60 days before it expires." />
          </>}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </Card>;
}
