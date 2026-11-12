'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FileText, Upload } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, RadioGroup, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { ViewDocumentButton } from '@/features/documents/document-modal';
import { imageForUpload, PhotoError } from '@/features/onboarding/photo';
import { errorMessage, mutate } from '@/lib/client-api';
import { fileToBase64, MAX_PDF_BYTES } from '@/lib/files';
import { useToday } from './driver-documents';
import type { DriverProfile, ReportRow } from './types';

const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;
const pages = (count: number) => `${count} ${count === 1 ? 'page' : 'pages'}`;
// The same limits as other photographed documents: four pages, each small enough that all fit one upload.
const MAX_PAGES = 4, PAGE_BYTES = 760_000, PAGE_SIDE = 1800;

/** One PDF, or photos of up to four pages in order, as the API's ScanUploadDto takes them. Throws a PhotoError to show by the field. */
async function pdfOrPhotos(files: File[]): Promise<{ file: string } | { pages: string[] }> {
  const pdfs = files.filter(file => file.type === 'application/pdf');
  if (!files.length) throw new PhotoError('Choose a PDF, or photos of each page.');
  if (pdfs.length && files.length > 1) throw new PhotoError('Choose one PDF, or photos only.');
  if (pdfs.length) { if (pdfs[0].size > MAX_PDF_BYTES) throw new PhotoError('The PDF is larger than 3 MB.'); return { file: await fileToBase64(pdfs[0]) }; }
  if (files.length > MAX_PAGES) throw new PhotoError(`Choose at most ${MAX_PAGES} photos, one per page, or upload a PDF.`);
  const out: string[] = [];
  // One photo at a time: decoding several full-size photos at once can exhaust a phone's memory.
  for (const file of files) out.push(await imageForUpload(file, { maxSide: PAGE_SIDE, maxBytes: PAGE_BYTES }));
  return { pages: out };
}

/**
 * The PSP report (section 39, PspUploadScreen, PspNoConsentScreen): FMCSA's crash and inspection report for CDL drivers and
 * anyone who once held a CDL. Shown as a row like the MVR; `canUpload` may add or replace it. Without the driver's signed PSP
 * consent the dialog asks to confirm a signed paper form first.
 */
export function PspRow({ driver, report, canUpload }: { driver: DriverProfile; report: ReportRow | null; canUpload: boolean }) {
  const [open, setOpen] = useState(false);
  const name = `${driver.firstName} ${driver.lastName}`;
  return <li className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
    <FileText aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1 text-sm">
      <p className="font-medium">PSP report</p>
      <p className="text-[13px] text-muted-foreground">{report ? reportMeta(report) : 'Crashes (5 years) and inspections (3 years) from FMCSA. Pulled only after the driver signed the PSP consent.'}</p>
    </div>
    <span className="flex gap-1">
      {report && <ViewDocumentButton documents={[{ url: `/api/backend/safety/drivers/${driver.id}/reports/${report.id}/file`, title: `PSP report · ${name}`, meta: pages(report.pageCount) }]}>View<span className="sr-only"> the PSP report</span></ViewDocumentButton>}
      {canUpload && <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Upload aria-hidden="true" className="size-4" />{report ? 'Replace' : 'Upload'}<span className="sr-only"> the PSP report</span></Button>}
    </span>
    {open && <PspDialog driver={driver} replacing={!!report} onClose={() => setOpen(false)} />}
  </li>;
}
/** "Pulled Nov 2, 2026 · 2 pages · uploaded by Lena Lead" for a report row. */
export const reportMeta = (report: ReportRow) => <>Pulled {day(report.pulledOn)} · {pages(report.pageCount)} · uploaded by {report.uploadedBy ?? 'a former account'}</>;

/** Uploading or replacing the PSP report. The driver's signed PSP consent, or a confirmed paper copy, comes first. */
export function PspDialog({ driver, replacing, onClose }: { driver: DriverProfile; replacing: boolean; onClose: () => void }) {
  const router = useRouter(), toast = useToast(), today = useToday();
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [fileError, setFileError] = useState('');
  const [paper, setPaper] = useState(false);
  const name = `${driver.firstName} ${driver.lastName}`;
  const consentSigned = !!driver.consents?.signatures.some(row => row.kind === 'PSP_AUTHORIZATION');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget), file = form.get('file');
    const problem = !(file instanceof File) || file.type !== 'application/pdf' ? 'Choose the PSP report as a PDF file.' : file.size > MAX_PDF_BYTES ? 'The PDF must be 3 MB or smaller.' : '';
    setFileError(problem);
    if (problem) { document.getElementById('psp-file')?.focus(); return; }
    setPending(true); setError('');
    try {
      await mutate(`safety/drivers/${driver.id}/psp`, 'POST', { version: driver.version, file: await fileToBase64(file as File), pulledOn: String(form.get('pulledOn') ?? ''), ...(paper ? { paperAuthorization: true } : {}) });
      toast({ title: replacing ? 'PSP report replaced' : 'PSP report uploaded' });
      onClose(); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to upload. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <Dialog open onClose={onClose} busy={pending} title={replacing ? 'Replace PSP report' : 'Upload PSP report'} description={`${name} · ${driver.licenseType ? driver.licenseType.replace('CDL_', 'CDL Class ') : 'license'}`}
      actions={<Button type="submit" form="psp-form" disabled={pending || (!consentSigned && !paper)}><Upload aria-hidden="true" className="size-4" />{pending ? 'Uploading…' : 'Upload report'}</Button>}>
      <form id="psp-form" onSubmit={submit} className="space-y-4">
        {consentSigned ? <Alert tone="success" title="PSP consent signed">{name} signed the PSP disclosure and authorization in their application.</Alert>
          : <><Alert tone="warning" title="No PSP consent yet">FMCSA requires the driver’s written consent before a PSP report is pulled. Ask {driver.firstName} to sign the PSP form in their application, or confirm a signed paper copy.</Alert>
            <Checkbox name="paper" checked={paper} onChange={event => setPaper(event.target.checked)} label={`${driver.firstName} signed the paper PSP disclosure and authorization, and it’s in their file`} description="The stand-alone FMCSA form, signed before the report is pulled." /></>}
        <Field id="psp-file" label="PSP report (PDF)" hint="3 MB maximum. The report as FMCSA’s PSP site gives it." error={fileError}>
          <input id="psp-file" name="file" type="file" accept="application/pdf" required disabled={!consentSigned && !paper} aria-invalid={fileError ? true : undefined} aria-describedby={fileError ? 'psp-file-hint psp-file-error' : 'psp-file-hint'} onChange={() => setFileError('')}
            className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>
        <Input label="Pulled on" name="pulledOn" type="date" required width="sm" max={today ?? undefined} defaultValue={today ?? undefined} hint="Not before the consent was signed." />
        <p className="text-[13px] leading-5 text-muted-foreground">Every Safety role can open it; each view is recorded. A rejection based on it starts with the pre-adverse notice, like the MVR.</p>
        <Notice message={error} error /><PendingHint pending={pending} />
      </form>
    </Dialog>;
}

/** Recording a DL driver's road test (RoadTestRecordScreen): date, who gave it, the vehicle, the result and the signed certificate. */
export function RoadTestDialog({ driver, storageEnabled, onClose }: { driver: DriverProfile; storageEnabled: boolean; onClose: () => void }) {
  const router = useRouter(), toast = useToast(), today = useToday();
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [fileError, setFileError] = useState(''), [passed, setPassed] = useState('YES');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget), text = (key: string) => String(form.get(key) ?? '').trim();
    setPending(true); setError(''); setFileError('');
    try {
      const upload = storageEnabled ? await pdfOrPhotos((form.getAll('file') as File[]).filter(file => file.size > 0)) : {};
      await mutate(`safety/drivers/${driver.id}/road-test`, 'POST', { version: driver.version, givenOn: text('givenOn'), givenBy: text('givenBy'), vehicle: text('vehicle'), passed: passed === 'YES', ...(text('note') ? { note: text('note') } : {}), ...upload });
      toast({ title: passed === 'YES' ? 'Road test recorded' : 'Road test recorded as not passed' });
      onClose(); router.refresh();
    } catch (failure) {
      if (failure instanceof PhotoError) { setFileError(failure.message); document.getElementById('road-test-file')?.focus(); }
      else setError(errorMessage(failure, 'Unable to save. Your entries have been kept.'));
    } finally { setPending(false); }
  }
  return <Dialog open onClose={onClose} busy={pending} title="Road test" description={`${driver.firstName} ${driver.lastName} · regular license (DL)`}
    actions={<Button type="submit" form="road-test-form" disabled={pending}>{pending ? 'Saving…' : 'Save road test'}</Button>}>
    <form id="road-test-form" onSubmit={submit} className="space-y-4">
      <Input label="Given on" name="givenOn" type="date" required width="sm" max={today ?? undefined} defaultValue={today ?? undefined} />
      <Input label="Given by" name="givenBy" required maxLength={100} width="full" hint="Someone qualified to give it. Their name is on the certificate." />
      <Input label="Vehicle used" name="vehicle" required maxLength={100} width="full" hint="For example: pickup P-12 with a 3-car trailer." />
      {storageEnabled && <Field id="road-test-file" label="Signed road test certificate" hint="One PDF, or photos of up to 4 pages in order. Kept in the driver’s file." error={fileError}>
        <input id="road-test-file" name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/heic" multiple required aria-invalid={fileError ? true : undefined}
          aria-describedby={fileError ? 'road-test-file-hint road-test-file-error' : 'road-test-file-hint'} onChange={() => setFileError('')}
          className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>}
      <RadioGroup name="passed" label="Result" value={passed} onChange={setPassed} options={[{ value: 'YES', label: 'Passed' }, { value: 'NO', label: 'Not passed', description: 'The item stays open; record another test later.' }]} />
      <Textarea label="Note" name="note" optional rows={2} maxLength={500} hint="No medical details." />
      <Notice message={error} error /><PendingHint pending={pending} />
    </form>
  </Dialog>;
}

/** The rail card that says what this license needs (ClearanceCdlScreen, ClearancePickupScreen), so nobody has to remember the rules. */
export function LicenseRulesCard({ driver }: { driver: DriverProfile }) {
  const rules = driver.license;
  // An older API sends no rules, and the card stays out.
  if (!rules) return null;
  const items = rules.cdl
    ? [{ label: 'License', value: driver.licenseType ? driver.licenseType.replace('CDL_', 'CDL Class ') : 'CDL' }, { label: 'Drug test', value: 'DOT (Part 382)' }, { label: 'Clearinghouse', value: 'Full query' },
      { label: 'PSP report', value: 'Needed' }, { label: 'Road test', value: 'CDL accepted' }]
    : [{ label: 'License', value: 'DL (no CDL)' }, { label: 'Drug test', value: 'Non-DOT, company test' }, { label: 'Clearinghouse', value: 'Not needed' },
      { label: 'PSP report', value: rules.psp ? 'Needed: once held a CDL' : 'Only if they once held a CDL' }, { label: 'Medical card', value: 'Needed' }, { label: 'Road test', value: 'Needed' }];
  return <Card>
    <CardHeader title="What this license needs" />
    <CardBody className="space-y-2">
      <DescriptionList layout="rows" items={items} />
      <p className="text-[13px] leading-5 text-muted-foreground">{rules.cdl ? 'Set from the license class. A wrong class is corrected on the driver’s details, never here.'
        : 'Over 10,000 lb in interstate work, so the federal driver rules apply; under 26,001 lb, so no CDL and no DOT drug testing.'}</p>
    </CardBody>
  </Card>;
}
