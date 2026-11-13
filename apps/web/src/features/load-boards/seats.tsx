'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ellipsis, Pause, Pencil, Play, Plus, Route, Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { DropdownMenu, type MenuEntry } from '@/components/ui/dropdown-menu';
import { Notice } from '@/components/ui/alert';
import { Input, RadioGroup, Select } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';

// Load board seats (Design System section 33, Company accounts and load boards, approved 2026-11-13).
export type Provider = 'DAT' | 'TRUCKSTOP';
export const PROVIDER: Record<Provider, string> = { DAT: 'DAT', TRUCKSTOP: 'Truckstop' };
export interface Seat { id: string; accountId: string; account: string; provider: Provider; placeholder: boolean; signInEmail: string; status: 'ACTIVE' | 'SUSPENDED' | 'ENDED';
  startedAt: string; suspendedAt: string | null; endedAt: string | null; endedHow: string | null; version: number; sharedWith: { id: string; name: string }[] }
export interface LoadBoardAccount { id: string; name: string; provider: Provider; placeholder: boolean; archived: boolean }
export type SeatAction = 'SUSPEND' | 'RESUME' | 'MOVE' | 'END' | 'EMAIL';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export function SeatBadge({ status }: { status: Seat['status'] }) {
  return <Badge label={status === 'ACTIVE' ? 'Active' : status === 'SUSPENDED' ? 'Suspended' : 'Ended'} tone={status === 'ACTIVE' ? 'success' : status === 'SUSPENDED' ? 'warning' : 'neutral'} />;
}
/** "Since Feb 1, 2025", "Mar 4, 2024 – Jan 31, 2025" for an ended seat. */
export function SeatDates({ seat }: { seat: Pick<Seat, 'startedAt' | 'endedAt' | 'status'> }) {
  return seat.status === 'ENDED' && seat.endedAt ? <><LocalTime iso={seat.startedAt} format="date" /> – <LocalTime iso={seat.endedAt} format="date" /></> : <LocalTime iso={seat.startedAt} format="date" />;
}
/** What happened to an ended seat, or who else uses the sign-in of an open one. */
export function seatNote(seat: Pick<Seat, 'status' | 'endedHow' | 'placeholder'> & { sharedWith: ({ name: string } | string)[] }) {
  if (seat.status === 'ENDED') return seat.endedHow === 'MOVED' ? 'Moved to another account' : seat.endedHow === 'LEFT' ? 'Ended when they left' : 'Ended';
  const names = seat.sharedWith.map(item => typeof item === 'string' ? item : item.name);
  return [names.length ? `Also used by ${names.join(', ')}` : '', seat.placeholder ? 'Move it to its real account' : ''].filter(Boolean).join('. ');
}
/** The actions a seat offers: change the sign-in, suspend or resume, move, end. Ended seats offer none. */
export function seatMenu(seat: Pick<Seat, 'status'>, open: (action: SeatAction) => void): MenuEntry[] {
  if (seat.status === 'ENDED') return [];
  return [{ label: 'Change sign-in email', icon: Pencil, onSelect: () => open('EMAIL') },
    seat.status === 'ACTIVE' ? { label: 'Suspend', icon: Pause, onSelect: () => open('SUSPEND') } : { label: 'Resume', icon: Play, onSelect: () => open('RESUME') },
    { label: 'Move to another account', icon: Route, onSelect: () => open('MOVE') }, { separator: true }, { label: 'End seat', icon: Ban, onSelect: () => open('END') }];
}

/**
 * Load boards on a dispatcher's page (CompanyAccountsProfileScreen): which DAT and Truckstop accounts they use, with the sign-in
 * and who else shares it. Administrators add and change seats here (CompanyAccountsAdminScreen); everyone else reads.
 */
export function LoadBoardsCard({ memberId, name, seats, accounts, companyEmails, canChange }: { memberId: string; name: string; seats: Seat[]; accounts: LoadBoardAccount[]; companyEmails: string[]; canChange: boolean }) {
  const [adding, setAdding] = useState(false), [changing, setChanging] = useState<{ seat: Seat; action: SeatAction } | null>(null);
  if (!seats.length && !canChange) return null;
  return <Card>
    <CardHeader title="Load boards" description="Which DAT and Truckstop accounts they use." actions={canChange && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus aria-hidden="true" className="size-4" />Add seat</Button>} />
    <Table caption="Load board seats" className="mt-3 border-t border-border" rows={seats} rowKey={seat => seat.id} columns={[
      { key: 'account', label: 'Account and sign-in', primary: true, cell: seat => <span className="block min-w-0"><span className="block">{seat.account}</span><span className="block break-all text-[13px] text-muted-foreground">{seat.signInEmail}</span></span> },
      { key: 'status', label: 'Status', cell: seat => <SeatBadge status={seat.status} /> },
      { key: 'since', label: 'Since', nowrap: true, muted: true, hideBelow: 'md', cell: seat => <SeatDates seat={seat} /> },
      { key: 'note', label: 'Note', muted: true, hideBelow: 'lg', cell: seat => seatNote(seat) },
      ...(canChange ? [{ key: 'actions', label: 'Actions', srOnly: true, action: true, align: 'right' as const, cell: (seat: Seat) => seat.status === 'ENDED' ? null
        : <DropdownMenu label={`Seat actions for ${seat.account}`} triggerIcon={Ellipsis} triggerVariant="ghost" align="end" items={seatMenu(seat, action => setChanging({ seat, action }))} /> }] : [])]}
      empty={<p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">No load board seats recorded.</p>} />
    {adding && <AddSeatDialog people={[{ id: memberId, name, companyEmail: companyEmails[0] ?? null }]} memberId={memberId} accounts={accounts} companyEmails={companyEmails} onClose={() => setAdding(false)} />}
    {changing && <ChangeSeatDialog seat={changing.seat} action={changing.action} who={name} accounts={accounts} companyEmails={companyEmails} onClose={() => setChanging(null)} />}
  </Card>;
}

export interface SeatPerson { id: string; name: string; companyEmail: string | null }
/** Add a seat (LoadBoardSeatAddScreen): the account picked from the list, never typed; the sign-in offers company emails first. */
export function AddSeatDialog({ people, memberId: fixed, accountId: fixedAccount, accounts, companyEmails, onClose }: { people: SeatPerson[]; memberId?: string; accountId?: string; accounts: LoadBoardAccount[]; companyEmails?: string[]; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [memberId, setMemberId] = useState(fixed ?? ''), person = people.find(item => item.id === memberId);
  const offered = [...new Set([...(companyEmails ?? []), ...(person?.companyEmail ? [person.companyEmail] : [])])];
  const [pick, setPick] = useState(offered[0] ?? 'other'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const usable = accounts.filter(account => !account.placeholder && !account.archived);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setBusy(true); setError('');
    try {
      await mutate('load-board-seats', 'POST', { memberId, accountId: fixedAccount ?? form.accountId, signInEmail: pick === 'other' ? form.otherEmail : pick, startedOn: form.startedOn });
      toast({ title: 'Seat added' }); onClose(); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to add the seat. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  const choices = [...offered.map(email => ({ value: email, label: email, description: 'Company email' })), { value: 'other', label: 'Another email' }];
  return <Dialog open onClose={onClose} busy={busy} title="Add a load board seat" description={`${person?.name ?? 'Choose who uses it'}. Nobody is messaged.`}
    actions={<Button type="submit" form="add-seat" disabled={busy || !memberId}>{busy ? 'Adding…' : 'Add seat'}</Button>}>
    <form id="add-seat" onSubmit={submit} className="space-y-4"><fieldset disabled={busy} className="min-w-0 space-y-4">
      {!fixed && <Select label="Person" name="memberId" required width="full" placeholder="Choose a person" value={memberId} onChange={event => { setMemberId(event.target.value); setPick('other'); }}
        options={people.map(item => ({ value: item.id, label: item.name }))} />}
      {!fixedAccount && <Select label="Load board account" name="accountId" required width="full" placeholder="Choose an account" options={usable.map(account => ({ value: account.id, label: `${account.name} · ${PROVIDER[account.provider]}` }))} />}
      <RadioGroup name="pick" label="Sign-in email" value={pick} onChange={setPick} options={choices} />
      {pick === 'other' && <Input label="Sign-in email" name="otherEmail" type="email" required maxLength={254} width="full" autoComplete="off" />}
      <Input label="Started on" name="startedOn" type="date" required defaultValue={today()} max={today()} min="1980-01-01" width="sm" />
      <p className="text-[13px] leading-5 text-muted-foreground">The email only. Never a password, here or in notes. Sharing a sign-in is allowed and shown.</p>
      <Notice message={error} error />
    </fieldset></form>
  </Dialog>;
}

const TITLES: Record<SeatAction, string> = { EMAIL: 'Change the sign-in email', SUSPEND: 'Suspend the seat', RESUME: 'Resume the seat', MOVE: 'Move to another account', END: 'End the seat' };
/** Change a seat (LoadBoardSeatChangeScreen): each change keeps the seat's history. */
export function ChangeSeatDialog({ seat, action, who, accounts, companyEmails, onClose }: { seat: Pick<Seat, 'id' | 'account' | 'accountId' | 'provider' | 'signInEmail' | 'version' | 'startedAt'>; action: SeatAction; who: string; accounts: LoadBoardAccount[]; companyEmails?: string[]; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const targets = accounts.filter(account => !account.placeholder && !account.archived && account.id !== seat.accountId);
  const emails = [...new Set([seat.signInEmail, ...(companyEmails ?? [])])];
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setBusy(true); setError('');
    try {
      await mutate(`load-board-seats/${seat.id}`, 'POST', { version: seat.version, action, ...(form.on ? { on: form.on } : {}), ...(form.accountId ? { accountId: form.accountId } : {}), ...(form.signInEmail ? { signInEmail: form.signInEmail } : {}) });
      toast({ title: action === 'MOVE' ? 'Seat moved' : action === 'END' ? 'Seat ended' : action === 'SUSPEND' ? 'Seat suspended' : action === 'RESUME' ? 'Seat resumed' : 'Sign-in changed' }); onClose(); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to change the seat. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  const dated = action === 'SUSPEND' || action === 'MOVE' || action === 'END';
  return <Dialog open onClose={onClose} busy={busy} tone={action === 'END' ? 'danger' : undefined} title={`${TITLES[action]}: ${who}’s ${seat.account}`} description={`Sign-in ${seat.signInEmail}.`}
    actions={<Button type="submit" form="change-seat" variant={action === 'END' ? 'destructive' : 'default'} disabled={busy}>{busy ? 'Saving…' : action === 'MOVE' ? 'Move seat' : action === 'END' ? 'End seat' : action === 'SUSPEND' ? 'Suspend' : action === 'RESUME' ? 'Resume' : 'Save sign-in'}</Button>}>
    <form id="change-seat" onSubmit={submit} className="space-y-4"><fieldset disabled={busy} className="min-w-0 space-y-4">
      {action === 'MOVE' && <Select label="New account" name="accountId" required width="full" placeholder="Choose an account" options={targets.map(account => ({ value: account.id, label: `${account.name} · ${PROVIDER[account.provider]}` }))} />}
      {action === 'MOVE' && <Select label="Sign-in email on the new account" name="signInEmail" width="full" defaultValue={seat.signInEmail} options={emails.map(email => ({ value: email, label: email }))} />}
      {action === 'EMAIL' && <Input label="Sign-in email" name="signInEmail" type="email" required maxLength={254} defaultValue={seat.signInEmail} width="full" autoComplete="off" hint="The email only. Never a password." />}
      {dated && <Input label="From" name="on" type="date" required defaultValue={today()} max={today()} min={seat.startedAt.slice(0, 10)} width="sm" />}
      <p className="text-[13px] leading-5 text-muted-foreground">{action === 'SUSPEND' ? 'They can’t use it for now. The seat stays theirs.' : action === 'MOVE' ? 'Ends this seat and opens one on the account you pick.' : action === 'END' ? 'They no longer use this account. The seat stays in its history.' : action === 'RESUME' ? 'They can use it again.' : 'Everyone who shares it keeps their own seat.'}</p>
      <Notice message={error} error />
    </fieldset></form>
  </Dialog>;
}
