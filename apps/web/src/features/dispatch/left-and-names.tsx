'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { Input, RadioGroup, Select, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import type { Choice, MemberProfile } from './types';

// People who left and other names (Design System section 33, approved 2026-11-13).
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
/** Added as Left from a file, with no last day yet: their leftAt only holds the day they were added and is never shown. */
export const lastDayMissing = (member: MemberProfile) => member.status === 'LEFT' && member.existing?.leftDateKnown === false;
/** Someone added by hand as Left: IT may be asked to close the accounts their record lists, once. */
export const canAskItToClose = (member: MemberProfile) => member.status === 'LEFT' && !!member.existing && !member.removal
  && !!(member.existing.companyEmail || member.existing.ringCentralNumber || member.existing.datEmail || member.existing.truckstopEmail);
const legalName = (member: MemberProfile) => [member.existing?.legalFirstName, member.existing?.legalLastName].filter(Boolean).join(' ');

/** For someone added as Left (LeftRecordScreen): where they came from, that nothing was sent, and what can still be done. */
export function AddedAsLeftAlert({ member }: { member: MemberProfile }) {
  const existing = member.existing!;
  return <Alert tone="neutral" title="Added as someone who already left">
    <p>{member.firstName} was {existing.sourceName ? `in ${existing.sourceName}` : 'added'} as Left. Nothing was sent to anyone{member.removal ? '.' : ', and IT wasn’t asked to do anything.'}
      {canAskItToClose(member) ? ' If their accounts might still be open, use Ask IT to close their accounts.' : ''}</p>
  </Alert>;
}

/** Names (OtherNamesProfileScreen): the legal name of someone added by hand, and other names with where they were used. */
export function NamesCard({ member, onEdit }: { member: MemberProfile; onEdit?: () => void }) {
  const others = member.otherNames ?? [], handAdded = !!member.existing;
  if (!handAdded && !others.length && !onEdit) return null;
  return <Card><CardHeader title="Names" actions={onEdit && <Button size="sm" variant="ghost" onClick={onEdit}><Pencil aria-hidden="true" className="size-4" />Edit names</Button>} />
    <CardBody><DescriptionList layout="rows" items={[
      { label: 'American name', value: `${member.firstName} ${member.lastName}` },
      ...(handAdded ? [{ label: 'Legal name', value: legalName(member) || null, emptyLabel: 'Not recorded' }] : []),
      { label: 'Other names', value: others.length ? <ul className="grid gap-1.5">{others.map(item => <li key={item.id} className="flex flex-wrap items-baseline gap-x-2"><span>{item.name}</span><span className="text-[13px] text-muted-foreground">{item.mc ?? 'earlier name'}</span></li>)}</ul> : null, emptyLabel: 'None recorded' }]} />
    </CardBody></Card>;
}

/** Edit names (OtherNamesEditScreen): legal name for someone added by hand, and the whole list of other names. */
export function NamesDialog({ member, mcs, onClose }: { member: MemberProfile; mcs: Choice[]; onClose: () => void }) {
  const router = useRouter(), toast = useToast(), handAdded = !!member.existing;
  const [names, setNames] = useState(() => (member.otherNames ?? []).map(item => ({ name: item.name, mcId: item.mcId ?? '' })));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const change = (index: number, patch: Partial<{ name: string; mcId: string }>) => setNames(list => list.map((item, at) => at === index ? { ...item, ...patch } : item));
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setBusy(true); setError('');
    try {
      await mutate(`dispatch/members/${member.id}/names`, 'POST', { version: member.version, ...(handAdded ? { legalFirstName: form.legalFirstName ?? '', legalLastName: form.legalLastName ?? '' } : {}),
        otherNames: names.filter(item => item.name.trim()).map(item => ({ name: item.name.trim(), ...(item.mcId ? { mcId: item.mcId } : {}) })) });
      toast({ title: 'Names saved' }); onClose(); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to save the names. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  const usedAt = [{ value: '', label: 'Not known' }, ...mcs.map(mc => ({ value: mc.id, label: mc.archived ? `${mc.name} (archived)` : mc.name }))];
  return <Dialog open onClose={onClose} busy={busy} size="lg" title={`Edit ${member.firstName} ${member.lastName}’s names`} description="What you know now. Nobody is messaged."
    actions={<Button type="submit" form="member-names" disabled={busy}>{busy ? 'Saving…' : 'Save names'}</Button>}>
    <form id="member-names" onSubmit={submit} className="space-y-4"><fieldset disabled={busy} className="min-w-0 space-y-4">
      {handAdded ? <><div className="grid gap-4 sm:grid-cols-2"><Input name="legalFirstName" label="Legal first name" optional maxLength={100} defaultValue={member.existing?.legalFirstName ?? ''} width="full" /><Input name="legalLastName" label="Legal last name" optional maxLength={100} defaultValue={member.existing?.legalLastName ?? ''} width="full" /></div>
        <p className="text-[13px] text-muted-foreground">{member.firstName} was added by hand, so the legal name is edited here. For someone who came through onboarding it comes from their application, and only an administrator changes it, with Correct details and a reason.</p></>
        : <p className="text-[13px] text-muted-foreground">Their legal name comes from their application. An administrator changes it with Correct details, with a reason.</p>}
      <Card><CardHeader title="Other names" description="Other American names they use or used, so search finds them." />
        <ul className="mt-3 divide-y divide-border border-t border-border">
          {names.map((item, index) => <li key={index} className="flex flex-wrap items-end gap-3 px-4 py-3 sm:px-5">
            <Input label="Name" value={item.name} maxLength={100} required onChange={event => change(index, { name: event.target.value })} width="full" className="min-w-0 flex-[2_1_200px]" />
            <Select label="Used at" value={item.mcId} onChange={event => change(index, { mcId: event.target.value })} options={usedAt} width="full" className="min-w-0 flex-[1_1_160px]" />
            <Button type="button" size="sm" variant="ghost" onClick={() => setNames(list => list.filter((_, at) => at !== index))}><X aria-hidden="true" className="size-4" />Remove<span className="sr-only"> {item.name}</span></Button>
          </li>)}
          <li className="px-4 py-3 sm:px-5"><Button type="button" size="sm" variant="outline" disabled={names.length >= 10} onClick={() => setNames(list => [...list, { name: '', mcId: '' }])}><Plus aria-hidden="true" className="size-4" />Add another name</Button></li>
        </ul></Card>
      <p className="text-[13px] text-muted-foreground">Latin letters only. A change is recorded with who made it, never in alerts.</p>
      <Notice message={error} error />
    </fieldset></form>
  </Dialog>;
}

/** Add last day (LeftAddLastDayScreen): their last working day, between when they started and today. */
export function LeftDayDialog({ member, onClose }: { member: MemberProfile; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const started = member.existing?.startDateKnown !== false ? member.joinedAt.slice(0, 10) : undefined;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setBusy(true); setError('');
    try {
      await mutate(`dispatch/members/${member.id}/left-day`, 'POST', { version: member.version, leftOn: form.leftOn, ...(form.reason?.trim() ? { reason: form.reason.trim() } : {}) });
      toast({ title: 'Last day saved' }); onClose(); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to save the last day. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  return <Dialog open onClose={onClose} busy={busy} title={`Add ${member.firstName} ${member.lastName}’s last day`} description="Their last working day. Nobody is messaged."
    actions={<Button type="submit" form="left-day" disabled={busy}>{busy ? 'Saving…' : 'Save last day'}</Button>}>
    <form id="left-day" onSubmit={submit} className="space-y-4"><fieldset disabled={busy} className="min-w-0 space-y-4">
      <Input name="leftOn" label="Last day" type="date" required min={started} max={today()} width="sm"
        hint={started ? <>Between <LocalTime iso={member.joinedAt} format="date" />, when they started, and today.</> : 'Today or earlier.'} />
      <Textarea name="reason" label="Why they left" optional maxLength={500} rows={2} defaultValue={member.leftReason ?? ''} hint="Staff only. Never health, family or other private details." />
      <Notice message={error} error />
    </fieldset></form>
  </Dialog>;
}

/** Ask IT to close their accounts (LeftAskItScreen): a removal checklist due today from what's recorded. */
export function CloseAccountsDialog({ member, onClose }: { member: MemberProfile; onClose: () => void }) {
  const router = useRouter(), toast = useToast(), existing = member.existing!;
  const [emailAfter, setEmailAfter] = useState<'FORWARD' | 'SUSPEND'>('SUSPEND'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setBusy(true); setError('');
    try {
      await mutate(`dispatch/members/${member.id}/close-accounts`, 'POST', { version: member.version, emailAfter: existing.companyEmail ? emailAfter : 'SUSPEND', ...(form.note?.trim() ? { note: form.note.trim() } : {}) });
      toast({ title: 'Sent to IT', description: 'You get a notice when they finish.' }); onClose(); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to ask IT. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  const signIns = [existing.datEmail, existing.truckstopEmail].filter(Boolean).join(', ');
  return <Dialog open onClose={onClose} busy={busy} title={`Ask IT to close ${member.firstName} ${member.lastName}’s accounts`} description="IT gets a removal checklist, due today, and you get a portal notice when it’s done."
    actions={<Button type="submit" form="close-accounts" disabled={busy}>{busy ? 'Sending…' : 'Ask IT'}</Button>}>
    <form id="close-accounts" onSubmit={submit} className="space-y-4"><fieldset disabled={busy} className="min-w-0 space-y-4">
      <DescriptionList layout="rows" items={[{ label: 'Company email', value: existing.companyEmail, emptyLabel: 'Not recorded' }, { label: 'RingCentral number', value: existing.ringCentralNumber, mono: true, emptyLabel: 'Not recorded' },
        { label: 'Load board sign-ins', value: signIns || null, emptyLabel: 'None recorded' }]} />
      {existing.companyEmail && <RadioGroup name="emailAfter" label="New email to their company email" value={emailAfter} onChange={value => setEmailAfter(value as 'FORWARD' | 'SUSPEND')}
        options={[{ value: 'SUSPEND', label: 'Nothing forwarded', description: 'The account is suspended.' }, { value: 'FORWARD', label: 'Forward new email to me for 30 days' }]} />}
      <Textarea name="note" label="Note for IT" optional maxLength={500} rows={2} hint="Never passwords." />
      <Notice message={error} error />
    </fieldset></form>
  </Dialog>;
}
