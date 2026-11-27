'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Input, RadioGroup, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import type { Choice, MemberCorrection, MemberProfile } from './types';

/**
 * Changing a dispatcher's name (Design System section 45, approved 2026-11-27: ChangeNameMenuScreen, ChangeNameScreen,
 * ChangeNameFixScreen, MoveNewNameAskScreen, MoveNewNameScreen, RehireNewNameScreen, SupportNewNameScreen, NameChangedProfileScreen).
 * Dispatch managers and administrators change the American name of anyone who hasn't left. A new name keeps the old one as an
 * other name where it was used; a fixed mistake keeps nothing. The application and signed documents keep the original.
 */
const LATIN = "[A-Za-z][A-Za-z .,'\\-]*";
const OTHER = 'OTHER';
const NAME_FIELDS = ['preferredAmericanFirstName', 'preferredAmericanLastName', 'firstName', 'lastName'];

/** The latest name change (a new name or a fix), from the corrections the profile sends; older corrections of the name count too. */
export function lastNameChange(member: MemberProfile): (MemberCorrection & { was: string }) | null {
  const change = (member.corrections ?? []).find(item => item.kind === 'NEW_NAME' || item.kind === 'NAME_FIX' || (!item.kind && item.changes.some(entry => NAME_FIELDS.includes(entry.field))));
  if (!change) return null;
  const part = (fields: string[], fallback: string) => change.changes.find(entry => fields.includes(entry.field))?.from ?? fallback;
  const was = `${part(['preferredAmericanFirstName', 'firstName'], member.firstName)} ${part(['preferredAmericanLastName', 'lastName'], member.lastName)}`.trim();
  return { ...change, was };
}

/** Whether they'll use a new name, with the new name: asked of a dispatcher when the MC changes, offered to a support or updater. */
export interface NewName { answer: '' | 'no' | 'yes'; firstName: string; lastName: string }
export const noNewName: NewName = { answer: '', firstName: '', lastName: '' };
/** What the API takes: the new name, or nothing. */
export const newNamePayload = (value: NewName) => value.answer === 'yes' ? { newName: { firstName: value.firstName.trim(), lastName: value.lastName.trim() } } : {};
/** The problem to show before sending, or ''. A dispatcher must say No or Yes. */
export function newNameProblem(value: NewName, required: boolean, mc: string) {
  if (required && !value.answer) return `Say whether they’ll use a new name at ${mc}.`;
  if (value.answer === 'yes' && (!value.firstName.trim() || !value.lastName.trim())) return 'Enter the new American first and last name.';
  return '';
}

/** The question in Move, Rehire and Change who they assist (MoveNewNameScreen, SupportNewNameScreen). */
export function NewNameQuestion({ value, onChange, oldName, mc, fromMc, optional = false }: { value: NewName; onChange: (value: NewName) => void; oldName: string; mc: string; fromMc: string | null; optional?: boolean }) {
  const set = (patch: Partial<NewName>) => onChange({ ...value, ...patch });
  const fields = value.answer === 'yes' && <div className="grid gap-4 rounded-md border border-border p-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <Input label="American first name" value={value.firstName} onChange={event => set({ firstName: event.target.value })} required maxLength={100} pattern={LATIN} autoComplete="off" width="full" />
      <Input label="American last name" value={value.lastName} onChange={event => set({ lastName: event.target.value })} required maxLength={100} pattern={LATIN} autoComplete="off" width="full" />
    </div>
    <p className="text-[13px] text-muted-foreground">{oldName} is kept as an other name{fromMc ? ` at ${fromMc}` : ''}. Latin letters only.</p>
  </div>;
  return <div className="grid gap-3">
    {optional ? <Checkbox label={`They’ll use a new name at ${mc}`} description="Optional for supports and updaters." checked={value.answer === 'yes'} onChange={event => set({ answer: event.target.checked ? 'yes' : 'no' })} />
      : <RadioGroup name="newNameAnswer" label={`Will they use a new name at ${mc}?`} value={value.answer} onChange={answer => set({ answer: answer as NewName['answer'] })}
        options={[{ value: 'no', label: `No, they keep ${oldName}` }, { value: 'yes', label: 'Yes, a new name' }]} />}
    {fields}
  </div>;
}

/** More actions › Change name (ChangeNameScreen, ChangeNameFixScreen). */
export function ChangeNameDialog({ member, mcs, onClose }: { member: MemberProfile; mcs: Choice[]; onClose: () => void }) {
  const router = useRouter(), toast = useToast(), oldName = `${member.firstName} ${member.lastName}`.trim();
  const [kind, setKind] = useState<'NEW' | 'FIX'>('NEW');
  const [first, setFirst] = useState(member.firstName), [last, setLast] = useState(member.lastName);
  // Where the old name was used: starts at the MC they're on now; '' is Place not recorded, OTHER another company typed in.
  // A support or updater works under the MC of whoever they help (their own current has no MC), so that MC is where it starts.
  const nowMc = member.current?.mcId ?? mcs.find(mc => mc.name === member.supportOf?.mc)?.id ?? '';
  const [usedAt, setUsedAt] = useState(nowMc), [company, setCompany] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const newName = `${first.trim()} ${last.trim()}`;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    if (newName === oldName) { setError('That’s the name they have now.'); return; }
    if (kind === 'NEW' && usedAt === OTHER && !company.trim()) { setError('Enter the company’s name, or choose where the name was used.'); return; }
    setBusy(true); setError('');
    try {
      await mutate(`dispatch/members/${member.id}/name`, 'POST', { version: member.version, kind, firstName: first.trim(), lastName: last.trim(), reason: form.reason,
        ...(kind === 'NEW' && usedAt && usedAt !== OTHER ? { mcId: usedAt } : {}), ...(kind === 'NEW' && usedAt === OTHER ? { companyName: company.trim() } : {}) });
      toast({ title: kind === 'NEW' ? `${newName} is their name now` : 'Name corrected' }); onClose(); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to change the name. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  // Their MC now is offered even when it's archived and the list sent only active ones.
  const current = member.current?.mcId && !mcs.some(mc => mc.id === member.current?.mcId) && member.current.mc ? [{ value: member.current.mcId, label: `${member.current.mc} (archived)` }] : [];
  const places = [...current, ...mcs.map(mc => ({ value: mc.id, label: mc.archived ? `${mc.name} (archived)` : mc.name })), { value: '', label: 'Place not recorded' }, { value: OTHER, label: 'Another company…' }];
  return <Dialog open onClose={onClose} busy={busy} size="lg" title={`Change ${oldName}’s name`} description="The American name is what the workspace calls them. Nobody is messaged."
    actions={<Button type="submit" form="change-name" disabled={busy}>{busy ? 'Saving…' : 'Change name'}</Button>}>
    <form id="change-name" onSubmit={submit} className="space-y-4"><fieldset disabled={busy} className="min-w-0 space-y-4">
      <RadioGroup name="kind" label="What is this?" cards value={kind} onChange={value => setKind(value as 'NEW' | 'FIX')} options={[
        { value: 'NEW', label: 'A new name', description: `They’ll go by a different name from now on, for example at a new MC. ${oldName} is kept as an other name.` },
        { value: 'FIX', label: 'Fixing a mistake', description: 'The name was recorded wrong. The old spelling isn’t kept as an other name.' }]} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="American first name" value={first} onChange={event => setFirst(event.target.value)} required maxLength={100} pattern={LATIN} autoComplete="off" width="full" />
        <Input label="American last name" value={last} onChange={event => setLast(event.target.value)} required maxLength={100} pattern={LATIN} autoComplete="off" width="full" />
      </div>
      {kind === 'NEW' && <>
        <Select label={`Where ${oldName} was used`} value={usedAt} onChange={event => setUsedAt(event.target.value)} options={places} width="full" hint="Starts at the MC they’re on now. Shown on their page as an other name." />
        {usedAt === OTHER && <Input label="Company name" value={company} onChange={event => setCompany(event.target.value)} required maxLength={100} hint="A company that isn’t one of our MCs." width="full" />}
      </>}
      <Textarea label="Reason" name="reason" required maxLength={500} rows={2} hint="Kept in their History. Staff only: never health, family or other private details." />
      <Alert tone="info" title="What changes"><ul className="list-disc space-y-1 pl-5">
        <li>Their page, Dispatchers, search and team pages show {first.trim() || last.trim() ? newName : 'the new name'}.</li>
        <li>IT sees the new name on any setup, removal or leave checklist still open.</li>
        <li>Their application, legal name and signed documents keep the name they were signed with.</li></ul></Alert>
      <Notice message={error} error />
    </fieldset></form>
  </Dialog>;
}
