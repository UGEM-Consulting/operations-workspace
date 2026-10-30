'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { CircleCheck, CornerUpLeft, FileWarning, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Checkbox, Input, Textarea } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { statusLabel } from '@/components/ui/status-badge';
import { Timeline } from '@/components/ui/timeline';
import { useToast } from '@/components/ui/toast';
import { ApiError, errorMessage, mutate } from '@/lib/client-api';
import { useToday } from './driver-documents';
import type { DriverProfile, DriverReviewRow } from './types';

type Decision = 'APPROVE' | 'MORE_INFO' | 'PRE_ADVERSE' | 'REJECT';
const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;
const actions: Record<string, { title: string; tone?: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  SENT_FOR_DECISION: { title: 'Sent to the Safety manager' }, APPROVED: { title: 'Approved', tone: 'success' }, MORE_INFO: { title: 'Sent back to screening', tone: 'neutral' },
  PRE_ADVERSE: { title: 'Pre-adverse notice sent', tone: 'warning' }, REJECTED: { title: 'Rejected: final notice sent', tone: 'danger' },
};
const dialogs: Record<Decision, { title: (name: string) => string; description: string; button: string; done: string }> = {
  APPROVE: { title: name => `Approve ${name}?`, description: 'The Safety lead then assigns a safety staff owner, who runs the clearance checklist.', button: 'Approve', done: 'Driver approved' },
  MORE_INFO: { title: () => 'Send back to screening?', description: 'The Safety lead looks into what you ask and sends the driver to you again.', button: 'Send back', done: 'Sent back to screening' },
  PRE_ADVERSE: { title: () => 'Record the pre-adverse notice', button: 'Record notice', done: 'Pre-adverse notice recorded',
    description: 'Before rejecting a driver because of their MVR or another background report, send them a pre-adverse notice with a copy of the report and “A Summary of Your Rights Under the Fair Credit Reporting Act”. They then have 5 business days to respond. The workspace doesn’t send it for you. After you record it, this card shows the first day the rejection can be final.' },
  REJECT: { title: name => `Reject ${name}?`, button: 'Reject', done: 'Driver rejected',
    description: 'The waiting period is over. Send the driver the final adverse action notice, then record it here. The record is closed and kept.' },
};

/** A decision's details: the reason or summary, conditions and the date a notice was sent. Safety-only; never shown to the driver. */
function details(row: DriverReviewRow) {
  return <div className="space-y-1">
    {row.note && <p className="whitespace-pre-wrap">{row.note}</p>}
    {row.conditions && <p><span className="font-medium">Conditions:</span> {row.conditions}</p>}
    {row.noticeSentOn && <p className="text-muted-foreground">Notice sent {day(row.noticeSentOn)}</p>}
  </div>;
}

/**
 * The Safety manager's decision on a screened driver and every decision so far. Deciders (the Safety manager and
 * administrators) approve, optionally with conditions, send the driver back to screening, or reject in two recorded steps:
 * the pre-adverse notice and, once the waiting period is over, the final notice. Safety sends both notices itself.
 */
export function DecisionCard({ driver, decider }: { driver: DriverProfile; decider: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const screening = driver.screening!, name = `${driver.firstName} ${driver.lastName}`.trim();
  const awaiting = driver.status === 'AWAITING_DECISION', noticeOut = driver.status === 'PRE_ADVERSE', finalFrom = screening.finalRejectionFrom;
  const notice = screening.reviews.find(row => row.action === 'PRE_ADVERSE');
  // The browser's date decides only whether the button is offered; the API checks the waiting period again.
  const canReject = !!(finalFrom && today && today >= finalFrom);
  const concerns = screening.checks.filter(check => check.result === 'CONCERN').length;
  function start(next: Decision) { setDecision(next); setError(''); setConflict(false); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!decision || pending) return;
    const form = new FormData(event.currentTarget), text = (key: string) => String(form.get(key) ?? '').trim();
    setPending(true); setError(''); setConflict(false);
    try {
      await mutate(`safety/drivers/${driver.id}/decision`, 'POST', { version: driver.version, decision,
        ...(text('note') ? { note: text('note') } : {}), ...(text('conditions') ? { conditions: text('conditions') } : {}),
        ...(decision === 'PRE_ADVERSE' || decision === 'REJECT' ? { noticeSentOn: text('noticeSentOn'), noticeSent: form.get('noticeSent') === 'on' } : {}) });
      toast({ title: dialogs[decision].done }); setDecision(null); router.refresh();
      // The decision buttons are gone now; keyboard focus returns to the card.
      requestAnimationFrame(() => heading.current?.focus());
    } catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); setConflict(failure instanceof ApiError && failure.kind === 'conflict'); }
    finally { setPending(false); }
  }
  return <Card>
    <CardHeader title="Decision" headingRef={heading} description={awaiting ? (decider ? 'Review the screening, the scans and the MVR, then decide.' : 'Waiting for the Safety manager’s decision.')
      : noticeOut ? 'A pre-adverse notice is out. The driver may respond before the rejection is final.' : 'What the Safety manager decided, newest first.'} />
    <CardBody className="space-y-4">
      {noticeOut && notice?.noticeSentOn && finalFrom && <Alert tone="warning" title="Pre-adverse notice out">
        <p>Sent {day(notice.noticeSentOn)}. Final rejection opens on {day(finalFrom)} (5 weekdays after the notice). If the driver disputes the report and it changes your view, approve them or send them back to screening instead.</p>
      </Alert>}
      {decider && (awaiting || noticeOut) && <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => start('APPROVE')}><CircleCheck aria-hidden="true" className="size-4" />Approve</Button>
        <Button variant="outline" onClick={() => start('MORE_INFO')}><CornerUpLeft aria-hidden="true" className="size-4" />Back to screening</Button>
        {awaiting && <Button variant="outline" className="text-danger" onClick={() => start('PRE_ADVERSE')}><FileWarning aria-hidden="true" className="size-4" />Pre-adverse notice</Button>}
        {/* Focusable while waiting (aria-disabled), so keyboard and screen reader users hear why it isn't available yet. */}
        {noticeOut && <Button variant="outline" className="text-danger aria-disabled:cursor-not-allowed aria-disabled:opacity-60" aria-disabled={!canReject || undefined}
          aria-describedby={canReject ? undefined : 'final-wait'} onClick={() => { if (canReject) start('REJECT'); }}><XCircle aria-hidden="true" className="size-4" />Final rejection</Button>}
        {noticeOut && !canReject && finalFrom && <span id="final-wait" className="sr-only">Not available until {day(finalFrom)}.</span>}
        {concerns > 0 && <a href="#screening" className="text-[13px] text-warning underline underline-offset-2">{concerns} {concerns === 1 ? 'concern' : 'concerns'} noted in screening</a>}
      </div>}
      {screening.reviews.length ? <Timeline items={screening.reviews.map(row => ({ id: row.id, title: actions[row.action]?.title ?? statusLabel(row.action), tone: actions[row.action]?.tone ?? 'neutral',
        meta: <>{row.actor ?? 'A former account'} · <LocalTime iso={row.createdAt} /></>, body: row.note || row.conditions || row.noticeSentOn ? details(row) : undefined }))} />
        : <EmptyState compact title="No decisions yet" description="The Safety lead sends the driver here after screening." />}
    </CardBody>
    {decision && <Dialog open onClose={() => setDecision(null)} busy={pending} title={dialogs[decision].title(name)} description={dialogs[decision].description}
      tone={decision === 'PRE_ADVERSE' || decision === 'REJECT' ? 'danger' : undefined}
      actions={<Button type="submit" form="driver-decision" variant={decision === 'PRE_ADVERSE' || decision === 'REJECT' ? 'destructive' : 'default'}>{pending ? 'Saving…' : dialogs[decision].button}</Button>}>
      <form id="driver-decision" onSubmit={submit} className="space-y-4">
        {decision === 'APPROVE' && <>
          <Textarea label="Conditions" name="conditions" optional maxLength={1000} rows={3} hint="For example: road test before the first load. Leave empty for a plain approval." />
          <Checkbox name="confirmed" required label="I confirm this approval. It can’t be undone." />
        </>}
        {decision === 'MORE_INFO' && <Textarea label="What the Safety lead should look into" name="note" required maxLength={2000} rows={4} />}
        {(decision === 'PRE_ADVERSE' || decision === 'REJECT') && <>
          <Textarea label="Reason" name="note" required maxLength={2000} rows={4} defaultValue={decision === 'REJECT' ? notice?.note ?? '' : ''}
            hint={decision === 'REJECT' ? 'Filled in from the pre-adverse notice; change it if your reason changed. Safety only.' : 'Safety only. Never write SSNs, medical or drug test details.'} />
          <Input label="Date the notice was sent" name="noticeSentOn" type="date" required width="md" defaultValue={today ?? ''} max={today ?? undefined}
            min={decision === 'REJECT' ? finalFrom ?? undefined : undefined} />
          <Checkbox name="noticeSent" required label={decision === 'PRE_ADVERSE' ? 'I sent the driver the pre-adverse notice, a copy of the report and the summary of rights.' : 'I sent the driver the final adverse action notice.'} />
        </>}
        <Notice message={error} error />
        {conflict && <Button type="button" size="sm" variant="outline" onClick={() => { setError(''); setConflict(false); router.refresh(); }}>Reload the latest version</Button>}
        <PendingHint pending={pending} />
      </form>
    </Dialog>}
  </Card>;
}
