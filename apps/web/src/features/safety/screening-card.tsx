'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { CircleCheck, CircleDashed, FileText, Send, TriangleAlert, Undo2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Checkbox, Field, Input, RadioGroup, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { ApiError, errorMessage, mutate } from '@/lib/client-api';
import { fileToBase64, MAX_PDF_BYTES } from '@/lib/files';
import { useToday } from './driver-documents';
import { OneTimeLinkDialog } from './one-time-link-dialog';
import { gapLabel, screeningChecks, type DriverProfile, type ScreeningCheck, type ScreeningCheckKey } from './types';

const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;
type Action = { kind: 'check'; key: ScreeningCheckKey } | { kind: 'mvr' } | { kind: 'corrections' } | { kind: 'send' };

/**
 * The Safety lead's screening of a submitted application: the checklist (each check passed or noted as a concern for the
 * Safety manager), the driver's MVR, sending the application back to the driver for corrections, and the hand-off to the
 * Safety manager once nothing is missing. `screener` may act while the driver is in screening; everyone else reads.
 */
export function ScreeningCard({ driver, screener }: { driver: DriverProfile; screener: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [action, setAction] = useState<Action | null>(null);
  const [result, setResult] = useState<'PASS' | 'CONCERN'>('PASS');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [fileError, setFileError] = useState('');
  const [clearing, setClearing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const screening = driver.screening!, active = screener && driver.status === 'SCREENING';
  const checkOf = (key: ScreeningCheckKey) => screening.checks.find(check => check.key === key);
  // The Safety manager's latest request, while the driver is back in screening because of it.
  const askedBack = driver.status === 'SCREENING' && screening.reviews[0]?.action === 'MORE_INFO' ? screening.reviews[0] : null;
  function start(next: Action) {
    setAction(next); setError(''); setConflict(false); setFileError(''); setClearing(false);
    if (next.kind === 'check') setResult(checkOf(next.key)?.result ?? 'PASS');
  }
  async function run(work: () => Promise<void>) {
    if (pending) return;
    setPending(true); setError(''); setConflict(false);
    try { await work(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); setConflict(failure instanceof ApiError && failure.kind === 'conflict'); }
    finally { setPending(false); }
  }
  /** After a saved action: refresh, and bring keyboard focus back to the card (the button that started it may be gone). */
  function done() {
    setAction(null); router.refresh();
    requestAnimationFrame(() => heading.current?.focus());
  }
  // A conflict keeps the dialog and its entries; refreshing loads the current version, so they can be saved again.
  function reload() { setError(''); setConflict(false); router.refresh(); }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) return;
    const form = new FormData(event.currentTarget), text = (name: string) => String(form.get(name) ?? '').trim();
    void run(async () => {
      if (action.kind === 'check') {
        await mutate(`safety/drivers/${driver.id}/checks/${action.key}`, 'POST', { version: driver.version, result, ...(text('note') ? { note: text('note') } : {}) });
        toast({ title: 'Check recorded' });
      } else if (action.kind === 'mvr') {
        await mutate(`safety/drivers/${driver.id}/mvr`, 'POST', { version: driver.version, file: await fileToBase64(form.get('file') as File), pulledOn: text('pulledOn'),
          ...(form.get('paperAuthorization') === 'on' ? { paperAuthorization: true } : {}) });
        toast({ title: 'MVR uploaded' });
      } else if (action.kind === 'corrections') {
        setLink(await mutate<{ url: string; expiresAt: string }>(`safety/drivers/${driver.id}/corrections`, 'POST', { version: driver.version, message: text('message') }));
        setAction(null); router.refresh();
        return;
      } else {
        await mutate(`safety/drivers/${driver.id}/send-for-decision`, 'POST', { version: driver.version, ...(text('note') ? { note: text('note') } : {}) });
        toast({ title: 'Sent to the Safety manager' });
      }
      done();
    });
  }
  // The file is checked in the browser first, for a specific message instead of the API's refusal.
  function submitMvr(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('file');
    const problem = !(file instanceof File) || file.type !== 'application/pdf' ? 'Choose the MVR as a PDF file.' : file.size > MAX_PDF_BYTES ? 'The PDF must be 3 MB or smaller.' : '';
    setFileError(problem);
    if (problem) document.getElementById('mvr-file')?.focus();
    else submit(event);
  }
  async function clearCheck(key: ScreeningCheckKey) {
    await run(async () => {
      await mutate(`safety/drivers/${driver.id}/checks/${key}`, 'POST', { version: driver.version, result: null });
      toast({ title: 'Check cleared' }); done();
    });
  }
  const current = action?.kind === 'check' ? checkOf(action.key) : undefined;
  const title = !action ? '' : action.kind === 'check' ? screeningChecks.find(check => check.key === action.key)!.label : action.kind === 'mvr' ? (screening.mvr ? 'Replace the MVR' : 'Upload the MVR')
    : action.kind === 'corrections' ? 'Send the application back to the driver?' : 'Send to the Safety manager?';
  return <Card id="screening" className="scroll-mt-20">
    <CardHeader title="Screening" headingRef={heading} description={driver.status === 'SCREENING' ? 'Work through each check, upload the MVR and verify the scans, then send the driver to the Safety manager.' : 'The Safety lead’s checks before the decision.'} />
    {askedBack && <div className="px-4 py-3 sm:px-5"><Alert tone="warning" title="The Safety manager sent this driver back">
      <p className="whitespace-pre-wrap">{askedBack.note}</p>
      <p className="mt-1 text-[13px]">{askedBack.actor ?? 'A former account'} · <LocalTime iso={askedBack.createdAt} /></p>
    </Alert></div>}
    <ul className="divide-y divide-border border-t border-border">
      {screeningChecks.map(item => <CheckRow key={item.key} label={item.label} hint={item.hint} check={checkOf(item.key)}
        action={active && <Button size="sm" variant="outline" onClick={() => start({ kind: 'check', key: item.key })}>{checkOf(item.key) ? 'Change' : 'Record'}<span className="sr-only"> {item.label.toLowerCase()}</span></Button>} />)}
      <li className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
        <FileText aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Motor vehicle record (MVR)</p>
          <p className="text-[13px] text-muted-foreground">{screening.mvr ? <>Pulled {day(screening.mvr.pulledOn)} · {screening.mvr.pageCount} {screening.mvr.pageCount === 1 ? 'page' : 'pages'} · uploaded by {screening.mvr.uploadedBy ?? 'a former account'}</> : 'Not uploaded yet. Safety leads and managers upload it; every Safety role can open it.'}</p>
        </div>
        <span className="flex gap-1">
          {screening.mvr && <Button asChild size="sm" variant="ghost"><a href={`/api/backend/safety/drivers/${driver.id}/reports/${screening.mvr.id}/file`} target="_blank" rel="noopener">View<span className="sr-only"> the MVR</span></a></Button>}
          {active && <Button size="sm" variant="outline" onClick={() => start({ kind: 'mvr' })}><Upload aria-hidden="true" className="size-4" />{screening.mvr ? 'Replace' : 'Upload'}</Button>}
        </span>
      </li>
    </ul>
    {active && <CardBody className="space-y-4 border-t border-border">
      {screening.missing.length > 0 && <div className="text-sm">
        <p className="font-medium">Before you send this driver to the Safety manager</p>
        <ul id="screening-gaps" className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">{screening.missing.map(code => <li key={code}>
          {code.startsWith('document:') ? <a href="#documents" className="underline underline-offset-2 hover:text-foreground">{gapLabel(code)}</a> : gapLabel(code)}</li>)}</ul>
      </div>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={screening.missing.length > 0} aria-describedby={screening.missing.length ? 'screening-gaps' : undefined} onClick={() => start({ kind: 'send' })}><Send aria-hidden="true" className="size-4" />Send for decision</Button>
        <Button variant="outline" disabled={!driver.email} onClick={() => start({ kind: 'corrections' })}><Undo2 aria-hidden="true" className="size-4" />Ask driver to correct</Button>
      </div>
      {!action && <Notice message={error} error />}
    </CardBody>}
    {action && <Dialog open onClose={() => setAction(null)} busy={pending} title={title} tone={action.kind === 'corrections' ? 'warning' : undefined}
      description={action.kind === 'check' ? screeningChecks.find(check => check.key === action.key)!.hint
        : action.kind === 'mvr' ? 'The PDF from the state or your MVR provider, 3 MB maximum. An earlier MVR is kept in the record.'
        : action.kind === 'corrections' ? 'It goes back to the driver as a draft with your message, through a new link you send them. Their answers, SSN and scans are kept; screening checks stay as they are.'
        : 'The Safety manager approves, asks for more, or rejects. Screening is closed while they decide.'}
      actions={<>
        {current && (clearing
          ? <Button type="button" variant="destructive" disabled={pending} onClick={() => void clearCheck(current.key)}>Confirm: clear check</Button>
          : <Button type="button" variant="ghost" disabled={pending} onClick={() => setClearing(true)}>Clear check</Button>)}
        <Button type="submit" form="screening-action">{pending ? 'Saving…' : action.kind === 'check' ? 'Save' : action.kind === 'mvr' ? 'Upload' : action.kind === 'corrections' ? 'Create link' : 'Send'}</Button>
      </>}>
      <form id="screening-action" onSubmit={action.kind === 'mvr' ? submitMvr : submit} className="space-y-4">
        {action.kind === 'check' && <>
          <RadioGroup name="result" label="Result" value={result} onChange={value => setResult(value as 'PASS' | 'CONCERN')} options={[
            { value: 'PASS', label: 'Passed' }, { value: 'CONCERN', label: 'Concern', description: 'The Safety manager sees your note before deciding.' }]} />
          <Textarea label={result === 'CONCERN' ? 'What the concern is' : 'Note'} name="note" optional={result === 'PASS'} required={result === 'CONCERN'} maxLength={1000} rows={3}
            defaultValue={current?.note ?? ''} hint="Never write SSNs, medical or drug test details here." />
        </>}
        {action.kind === 'mvr' && <>
          <Field id="mvr-file" label="MVR (PDF)" hint="3 MB maximum." error={fileError}><input id="mvr-file" name="file" type="file" accept="application/pdf" required
            aria-invalid={fileError ? true : undefined} aria-describedby={fileError ? 'mvr-file-hint mvr-file-error' : 'mvr-file-hint'} onChange={() => setFileError('')}
            className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>
          <Input label="Date pulled" name="pulledOn" type="date" required defaultValue={today ?? ''} max={today ?? undefined} width="md" hint="As shown on the report." />
          {/* The driver's written authorization comes first: signed in the application, or on paper and confirmed here. */}
          {driver.consents && (driver.consents.authorizationSigned
            ? <p className="text-sm text-muted-foreground">The driver signed the background check authorization in their application.</p>
            : <Checkbox name="paperAuthorization" required label="The driver signed a paper background check authorization, and it’s on file."
              description="They haven’t signed it in their application. Without a signed authorization, don’t pull or upload an MVR." />)}
        </>}
        {action.kind === 'corrections' && <Textarea label="Message to the driver" name="message" required maxLength={1000} rows={4}
          hint="The driver sees this when they open the new link, for example: “Your ZIP code doesn’t match your city.” Don’t mention MVR or background report details." />}
        {action.kind === 'send' && <Textarea label="Summary for the Safety manager" name="note" optional maxLength={2000} rows={4}
          hint="Anything they should know beyond the checks. Never write SSNs, medical or drug test details." />}
        <Notice message={error} error />
        {conflict && <Button type="button" size="sm" variant="outline" onClick={reload}>Reload the latest version</Button>}
        <PendingHint pending={pending} />
      </form>
    </Dialog>}
    {link && <OneTimeLinkDialog link={link} email={driver.email} onClose={() => setLink(null)} title="Send the driver this link"
      description="It’s shown only now: if it’s lost, create a new one from the Application card.">
      <Alert tone="info"><p>The workspace doesn’t message the driver. Send the link yourself by text or email, and tell them what to correct.</p></Alert>
    </OneTimeLinkDialog>}
  </Card>;
}

function CheckRow({ label, hint, check, action }: { label: string; hint: string; check: ScreeningCheck | undefined; action: React.ReactNode }) {
  const Icon = !check ? CircleDashed : check.result === 'PASS' ? CircleCheck : TriangleAlert;
  return <li className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
    <Icon aria-hidden="true" className={`size-5 shrink-0 ${!check ? 'text-muted-foreground' : check.result === 'PASS' ? 'text-success' : 'text-warning'}`} />
    <div className="min-w-0 flex-1 text-sm">
      <p className="font-medium">{label}</p>
      <p className="text-[13px] text-muted-foreground">{check ? <>{check.checkedBy ?? 'A former account'} · <LocalTime iso={check.checkedAt} format="date" /></> : hint}</p>
      {check?.note && <p className="mt-1 whitespace-pre-wrap">{check.note}</p>}
    </div>
    <Badge label={!check ? 'Not done' : check.result === 'PASS' ? 'Passed' : 'Concern'} tone={!check ? 'neutral' : check.result === 'PASS' ? 'success' : 'warning'} />
    {action}
  </li>;
}
