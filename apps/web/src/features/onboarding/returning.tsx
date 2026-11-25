'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Clock, Ellipsis, RotateCcw } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
import { Checkbox, RadioGroup } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import type { ReturningStatus } from './returning-words';

/**
 * Returning applicants (section 42: ReturningAccessScreen, GiveMoreTimeScreen, ResetCodeLimitScreen; approved 2026-11-24):
 * the card on the application page, and Give more time and Reset code limit. Nobody is messaged.
 */
type Action = 'time' | 'reset' | null;
// A sentence may start with their name, or with 'the applicant' for an application not sent yet.
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
// Their first name, or the whole wording when it isn't a name.
const firstOf = (name: string) => name.startsWith('the ') ? name : name.split(' ')[0] || name;
const untilDay = (days: number) => new Date(Date.now() + days * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

/** The alert at the top when something stops them returning, saying what to do. */
export function ReturningAlert({ status, name }: { status: ReturningStatus; name: string }) {
  // An application waiting for review is often past its time, which is normal: the alert is only where they need to come back.
  if (status.revoked) return <Alert tone="warning" title={`${cap(name)} can’t get back into their application`}><p>Their invitation was revoked, so they can’t return to it.</p></Alert>;
  if ((!status.ended && !status.limited) || !['DRAFT', 'CHANGES_REQUESTED'].includes(status.status)) return null;
  const why = [status.ended && <>their time to finish ended <LocalTime iso={status.accessUntil} format="date" /></>, status.limited && <>their email has had {status.codes} codes in the last 24 hours</>].filter(Boolean);
  const todo = status.ended ? <>{status.canGiveTime ? 'Give them more time' : 'Only an application not sent yet, or one with changes requested, can get more time'}{status.limited ? ', then reset the code limit if they still need a code today.' : '.'}</>
    : status.canReset ? 'Reset the code limit if they need a code today.' : <>{status.admin ? '' : 'An administrator can reset the code limit, or '}{status.admin ? 'They' : 'they'} get a code again after <LocalTime iso={status.nextCodeAt!} />.</>;
  return <Alert tone="warning" title={`${cap(name)} can’t get back into their application`}><p>{why.map((part, index) => <span key={index}>{index === 0 ? 'Since ' : ', and '}{part}</span>)}. {todo}</p></Alert>;
}

/** The main button and More actions in the page header. */
export function ReturningActions({ status, name }: { status: ReturningStatus; name: string }) {
  const [action, setAction] = useState<Action>(null);
  if (!status.canGiveTime && !status.canReset) return null;
  return <>
    {status.canGiveTime && <Button variant={status.ended ? 'default' : 'outline'} onClick={() => setAction('time')}><Clock aria-hidden="true" className="size-4" />Give more time</Button>}
    {status.canReset && <DropdownMenu label="More actions" triggerIcon={Ellipsis} align="end" items={[{ label: 'Reset code limit', icon: RotateCcw, onSelect: () => setAction('reset') }]} />}
    <ReturningDialogs status={status} name={name} action={action} onClose={() => setAction(null)} />
  </>;
}

/** Returning to their application (ReturningAccessScreen's rail card). */
export function ReturningCard({ status, name, actions = true }: { status: ReturningStatus; name: string; actions?: boolean }) {
  const [action, setAction] = useState<Action>(null);
  return <Card><CardHeader title="Returning to their application" description="They come back with their reference and a code sent to their email." />
    <CardBody className="space-y-4"><DescriptionList layout="rows" items={[
      { label: 'Email', value: <span className="break-all">{status.email}</span> },
      // The link they come back through, for anyone who can open the application to send with the reference (on the first web address).
      { label: 'Returning link', value: <span className="inline-flex flex-wrap items-center gap-1"><span className="break-all font-mono text-[13px]">{status.returnLink ?? '/apply/resume'}</span><CopyButton text={status.returnLink ?? '/apply/resume'} label="Copy link" size="sm" variant="ghost" /></span> },
      { label: 'Can return until', value: <span className="inline-flex flex-wrap items-center gap-2"><LocalTime iso={status.accessUntil} format="date" />{status.ended && <Badge label="Ended" tone="danger" />}</span> },
      // 4: every request counts, sent or not, for 24 hours from the first.
      { label: 'Code requests', value: <span className="inline-flex flex-wrap items-center gap-2">{status.codes} of {status.limit}{status.limited && <Badge label="Limit reached" tone="warning" />}</span> },
      ...(status.nextCodeAt ? [{ label: 'Next code possible', value: <LocalTime iso={status.nextCodeAt} /> }] : status.countResetsAt ? [{ label: 'Count starts again', value: <LocalTime iso={status.countResetsAt} /> }] : [])]} />
      {actions && (status.canGiveTime || status.canReset) && <div className="grid gap-2">
        {status.canGiveTime && <Button variant={status.ended ? 'default' : 'outline'} onClick={() => setAction('time')}><Clock aria-hidden="true" className="size-4" />Give more time</Button>}
        {status.canReset && <Button variant="outline" onClick={() => setAction('reset')}><RotateCcw aria-hidden="true" className="size-4" />Reset code limit</Button>}
      </div>}
      {!status.canReset && status.limited && <p className="text-[13px] leading-5 text-muted-foreground">{status.admin ? status.resetWhy ?? '' : 'Reset code limit is for administrators.'}</p>}
    </CardBody>
    <ReturningDialogs status={status} name={name} action={action} onClose={() => setAction(null)} /></Card>;
}

function ReturningDialogs({ status, name, action, onClose }: { status: ReturningStatus; name: string; action: Action; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [days, setDays] = useState(String(status.moreTimeDays[0] ?? 7)), [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const first = firstOf(name);
  // Closing forgets the confirmation, so the next reset is confirmed again.
  const close = () => { setConfirmed(false); setError(''); onClose(); };
  async function run() {
    if (pending) return;
    if (action === 'reset' && !confirmed) { setError('Confirm they asked you for a new code.'); return; }
    setPending(true); setError('');
    try {
      const given = action === 'time' ? await mutate<{ accessUntil: string; changed: boolean }>(`onboarding/applications/${status.applicationId}/more-time`, 'POST', { days: Number(days) })
        : (await mutate(`onboarding/applications/${status.applicationId}/reset-code-limit`, 'POST', { confirmed: true }), null);
      const until = given ? new Date(given.accessUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : '';
      toast(given ? { title: given.changed ? `${cap(first)} has more time` : `${cap(first)} already had longer`, description: `Until ${until}. Send them the link and reference.` } : { title: 'Code limit reset', description: `${cap(first)} can ask for a code now.` });
      close(); router.refresh();
    } catch (caught) { setError(errorMessage(caught, 'Unable to save. Reload the page and try again.')); }
    finally { setPending(false); }
  }
  if (action === 'time') return <Dialog open onClose={close} title={`Give ${name} more time`} busy={pending} description={`From today. They come back with their reference and a code sent to ${status.email}.`}
    actions={<Button onClick={() => void run()}><Clock aria-hidden="true" className="size-4" />{pending ? 'Saving…' : `Give ${days} days`}</Button>}>
    <div className="space-y-4">
      <RadioGroup name="days" label="How long" cards value={days} onChange={setDays} options={status.moreTimeDays.map(count => ({ value: String(count), label: `${count} days`, description: `Until ${untilDay(count)}` }))} />
      <Card><CardHeader title={`Send ${first} these yourself`} description={`${cap(first)} isn’t messaged.`} /><CardBody className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2"><span className="break-all font-mono text-[13px]">{status.returnLink ?? '/apply/resume'}</span><CopyButton text={status.returnLink ?? '/apply/resume'} label="Copy link" size="sm" variant="ghost" /></div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2"><span className="break-all font-mono text-[13px]">{status.applicationId}</span><CopyButton text={status.applicationId} label="Copy reference" size="sm" variant="ghost" /></div>
      </CardBody></Card>
      <p className="text-[13px] leading-5 text-muted-foreground">Recorded in the activity. Their saved answers stay as they are.</p>
      <Notice message={error} error /><PendingHint pending={pending} />
    </div></Dialog>;
  if (action === 'reset') return <Dialog open onClose={close} title={`Reset ${name}’s code limit`} busy={pending}
    description={`Each email gets at most ${status.limit} codes in 24 hours, so nobody who knows a reference can flood an inbox. Resetting lets ${status.email} get codes again now.`}
    actions={<Button onClick={() => void run()}><RotateCcw aria-hidden="true" className="size-4" />{pending ? 'Resetting…' : 'Reset code limit'}</Button>}>
    <div className="space-y-4">
      <DescriptionList layout="rows" items={[{ label: 'Codes asked for', value: `${status.codes} in the last 24 hours` },
        ...(status.nextCodeAt ? [{ label: 'Without a reset', value: <>Next code possible <LocalTime iso={status.nextCodeAt} /></> }] : []),
        { label: 'Can return until', value: <LocalTime iso={status.accessUntil} format="date" /> }]} />
      <Alert tone="info" title={`Reset only after ${first} asked you`}><p>Tell them to ask for one code, wait a few minutes, check spam, and use the newest code.</p></Alert>
      <Checkbox label={`${cap(first)} asked me for a new code.`} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
      <p className="text-[13px] leading-5 text-muted-foreground">Administrators only. Recorded in the activity with your name. Their codes still go only to their email.</p>
      <Notice message={error} error /><PendingHint pending={pending} />
    </div></Dialog>;
  return null;
}
