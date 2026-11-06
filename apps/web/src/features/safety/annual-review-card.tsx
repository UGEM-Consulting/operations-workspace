'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Checkbox, Field, Input, RadioGroup, Textarea } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { ViewDocumentButton } from '@/features/documents/document-modal';
import { errorMessage, mutate } from '@/lib/client-api';
import { fileToBase64, MAX_PDF_BYTES } from '@/lib/files';
import { useToday } from './driver-documents';
import type { DriverProfile } from './types';

const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;

/**
 * Yearly review of a cleared driver (FMCSA 391.25): a new MVR, a look at the driving record and the outcome. The owner,
 * the Safety manager and administrators record it; every Safety role reads it. Notes never hold medical or drug test details.
 */
export function AnnualReviewCard({ driver, canRecord }: { driver: DriverProfile; canRecord: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<'QUALIFIED' | 'NOT_QUALIFIED'>('QUALIFIED');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const reviews = driver.annualReviews;
  if (!reviews) return null;
  // Without file storage the API refuses an MVR and records the review without one (an older API sends no flag).
  const withMvr = reviews.storageEnabled !== false;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget), file = form.get('file');
    if (withMvr) {
      if (!(file instanceof File) || file.type !== 'application/pdf') { setError('Choose the MVR as a PDF file.'); return; }
      if (file.size > MAX_PDF_BYTES) { setError('The PDF must be 3 MB or smaller.'); return; }
    }
    setPending(true); setError('');
    try {
      const note = String(form.get('note') ?? '').trim();
      await mutate(`safety/drivers/${driver.id}/annual-reviews`, 'POST', { version: driver.version, reviewedOn: form.get('reviewedOn'), outcome, ...(note ? { note } : {}),
        ...(withMvr ? { mvr: { file: await fileToBase64(file as File), pulledOn: form.get('pulledOn'), ...(form.get('paperAuthorization') === 'on' ? { paperAuthorization: true } : {}) } } : {}) });
      toast({ title: 'Yearly review recorded' });
      setOpen(false); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <Card>
    <CardHeader title="Yearly review" description={reviews.dueOn ? <>Next due <strong>{day(reviews.dueOn)}</strong>. Pull a new MVR and review the driving record at least every 12 months.</> : 'Starts once the driver is cleared.'}
      actions={canRecord && <Button size="sm" onClick={() => { setOpen(true); setError(''); setOutcome('QUALIFIED'); }}><CalendarCheck aria-hidden="true" className="size-4" />Record review</Button>} />
    <CardBody>
      {reviews.notQualified && <Notice message="The last review found this driver not qualified. Record a new review when that changes." error />}
      {reviews.items.length === 0 ? <EmptyState compact title="No yearly review yet" /> : <ul className="divide-y divide-border">
        {reviews.items.map(row => <li key={row.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{day(row.reviewedOn)} <Badge label={row.outcome === 'QUALIFIED' ? 'Qualified' : 'Not qualified'} tone={row.outcome === 'QUALIFIED' ? 'success' : 'danger'} /></p>
            <p className="text-[13px] text-muted-foreground">{row.reviewer ? `Reviewed by ${row.reviewer}` : 'Reviewer account removed'}{row.mvr ? <> · MVR pulled {day(row.mvr.pulledOn)}</> : ''}</p>
            {row.note && <p className="mt-1 whitespace-pre-wrap text-sm">{row.note}</p>}</div>
          {row.mvr && <ViewDocumentButton documents={[{ url: `/api/backend/safety/drivers/${driver.id}/reports/${row.mvr.id}/file`, title: `Yearly MVR · ${driver.firstName} ${driver.lastName}`, meta: `${row.mvr.pageCount} ${row.mvr.pageCount === 1 ? 'page' : 'pages'}` }]}>View<span className="sr-only"> the MVR</span></ViewDocumentButton>}
        </li>)}</ul>}
    </CardBody>
    {open && <Dialog open onClose={() => setOpen(false)} busy={pending} title="Record the yearly review" description={`${withMvr ? 'Attach the MVR you pulled, then record' : 'Record'} what the review found. Never write medical or drug test details.`}
      actions={<Button type="submit" form="annual-review">{pending ? 'Saving…' : 'Record review'}</Button>}>
      <form id="annual-review" onSubmit={submit} className="space-y-4">
        <Input label="Date of the review" name="reviewedOn" type="date" required defaultValue={today ?? ''} max={today ?? undefined} width="md" />
        {withMvr ? <>
          <Field id="annual-mvr" label="New MVR (PDF)" hint="3 MB maximum, pulled in the last 90 days."><input id="annual-mvr" name="file" type="file" accept="application/pdf" required
            className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>
          <Input label="Date pulled" name="pulledOn" type="date" required defaultValue={today ?? ''} max={today ?? undefined} width="md" />
          {driver.consents && !driver.consents.authorizationSigned && <Checkbox name="paperAuthorization" required label="The driver signed a paper background check authorization, and it’s on file." />}
        </> : <p className="text-sm text-muted-foreground">File storage isn’t set up here, so no MVR is attached.</p>}
        <RadioGroup name="outcome" label="Outcome" value={outcome} onChange={value => setOutcome(value as 'QUALIFIED' | 'NOT_QUALIFIED')} options={[
          { value: 'QUALIFIED', label: 'Qualified to keep driving' }, { value: 'NOT_QUALIFIED', label: 'Not qualified', description: 'A note is required. The driver stays on the due list.' }]} />
        <Textarea label={outcome === 'NOT_QUALIFIED' ? 'What the review found' : 'Note'} name="note" optional={outcome === 'QUALIFIED'} required={outcome === 'NOT_QUALIFIED'} maxLength={1000} rows={3} />
        <Notice message={error} error />
      </form>
    </Dialog>}
  </Card>;
}
