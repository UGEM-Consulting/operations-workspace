'use client';
import { useRouter } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { BadgeCheck, ExternalLink, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/feedback';
import { Input } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { documentLabels, workAuthorizationTypes, type DriverDocumentRow, type DriverProfile } from './types';

const date = (value: string | null) => value ? <LocalTime iso={`${value}T12:00:00Z`} format="date" /> : null;
// Today in the viewer's time zone, read only in the browser: the server renders no Expired badge, so the first render
// matches it whatever its clock says.
const noSubscription = () => () => undefined;
const useToday = () => useSyncExternalStore(noSubscription, () => new Date().toLocaleDateString('en-CA'), () => null);

/**
 * The driver's scanned documents (each one PDF, opened in a new tab) and Safety's check of each: a person reads the
 * document and records its expiry date and, except for work authorization, its number. Screeners and the driver's owner
 * verify once the driver submits. The API records every time someone opens a scan.
 */
export function DriverDocuments({ driver, canVerify }: { driver: DriverProfile; canVerify: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [verifying, setVerifying] = useState<DriverDocumentRow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const documents = driver.documents ?? [], submitted = driver.application?.status === 'SUBMITTED';
  const fileUrl = (document: DriverDocumentRow) => `/api/backend/safety/drivers/${driver.id}/documents/${document.id}/file`;
  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!verifying || pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    try {
      await mutate(`safety/drivers/${driver.id}/documents/${verifying.id}/verify`, 'POST', { version: verifying.version, expiresOn: String(form.get('expiresOn') ?? ''),
        ...(verifying.kind === 'WORK_AUTHORIZATION' ? {} : { number: String(form.get('number') ?? '').trim() }) });
      toast({ title: `${documentLabels[verifying.kind]} verified` }); setVerifying(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <Card>
    <CardHeader title="Documents" description={submitted ? 'Scanned by the driver with their phone. Open each one and record what it shows.' : 'Scanned by the driver with their phone. You can verify them once the driver submits.'} />
    {documents.length ? <ul className="mt-3 divide-y divide-border border-t border-border">{documents.map(document => {
      const expired = !!(today && document.expiresOn && document.expiresOn < today);
      return <li key={document.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
        <FileText aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{documentLabels[document.kind]}{document.subtype ? <span className="font-normal text-muted-foreground"> · {workAuthorizationTypes[document.subtype] ?? document.subtype}</span> : null}</p>
          <p className="text-[13px] text-muted-foreground">{document.pageCount} {document.pageCount === 1 ? 'page' : 'pages'} · scanned <LocalTime iso={document.createdAt} format="date" />
            {document.verifiedAt && <> · {document.number ? <>No. <span className="font-mono">{document.number}</span> · </> : null}{document.expiresOn ? <>expires {date(document.expiresOn)} · </> : null}verified by {document.verifiedBy ?? 'a former account'}</>}</p>
        </div>
        {document.verifiedAt ? <Badge label={expired ? 'Expired' : 'Verified'} tone={expired ? 'danger' : 'success'} /> : <Badge label="Not verified" tone="neutral" />}
        <span className="flex gap-1">
          <Button asChild size="sm" variant="ghost"><a href={fileUrl(document)} target="_blank" rel="noopener">View<span className="sr-only"> {documentLabels[document.kind]}</span></a></Button>
          {canVerify && submitted && <Button size="sm" variant="outline" onClick={() => { setVerifying(document); setError(''); }}><BadgeCheck aria-hidden="true" className="size-4" />{document.verifiedAt ? 'Edit' : 'Verify'}<span className="sr-only"> {documentLabels[document.kind]}</span></Button>}
        </span>
      </li>;
    })}</ul> : <CardBody><EmptyState compact title="No documents yet" description="The driver scans them while filling in their application." /></CardBody>}
    {verifying && <Dialog open onClose={() => setVerifying(null)} busy={pending} title={`Verify ${documentLabels[verifying.kind].toLowerCase()}`}
      description="Open the document, check it’s readable and belongs to this driver, then record what it shows."
      actions={<Button type="submit" form="verify-document" disabled={pending}>{pending ? 'Saving…' : 'Mark as verified'}</Button>}>
      <form id="verify-document" onSubmit={verify} className="space-y-4">
        <a className="inline-flex items-center gap-1.5 text-sm text-primary underline" href={fileUrl(verifying)} target="_blank" rel="noopener">
          <ExternalLink aria-hidden="true" className="size-4" />Open the {documentLabels[verifying.kind].toLowerCase()} in a new tab</a>
        {verifying.kind === 'WORK_AUTHORIZATION'
          ? <Input label="Expiration date" name="expiresOn" type="date" optional defaultValue={verifying.expiresOn ?? ''} width="md"
            hint="Leave it empty if the document doesn’t expire. Don’t record passport, card or A-numbers." />
          : <>
            <Input label="Document number" name="number" optional defaultValue={verifying.number ?? ''} maxLength={40} autoComplete="off" spellCheck={false} width="full" />
            <Input label="Expiration date" name="expiresOn" type="date" required defaultValue={verifying.expiresOn ?? ''} width="md" hint="As printed on the document. Reminders before it expires come in a later update." />
          </>}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </Card>;
}
