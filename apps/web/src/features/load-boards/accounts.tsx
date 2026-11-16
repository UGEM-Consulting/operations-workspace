'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ellipsis, Plus } from 'lucide-react';
import { PageCrumb } from '@/components/shell-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
import { Notice } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/field';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { AddSeatDialog, ChangeSeatDialog, PROVIDER, SeatBadge, SeatDates, seatMenu, seatNote, type LoadBoardAccount, type Provider, type SeatAction, type SeatPerson } from './seats';

// Admin › Lists › Load board accounts (LoadBoardAccountsListScreen, LoadBoardAccountScreen; section 33, approved 2026-11-13).
export interface AccountRow extends LoadBoardAccount { mcId: string | null; mc: string | null; mcArchived: boolean; companyName: string | null; people: number; version: number }
export interface AccountList { items: AccountRow[]; counts: { active: number; archived: number }; mcs: { id: string; name: string; archived: boolean }[] }
const company = (row: Pick<AccountRow, 'mc' | 'mcArchived' | 'companyName'>) => row.mc ? `${row.mc}${row.mcArchived ? ' (archived MC)' : ''}` : row.companyName ?? '—';

/** The list itself: each account, the company it's under and how many people use it. IT and administrators keep it; managers read it. */
export function LoadBoardAccountList({ data, filters, canChange }: { data: AccountList; filters: Record<string, string>; canChange: boolean }) {
  const router = useRouter(), toast = useToast();
  const [editing, setEditing] = useState<AccountRow | 'new' | null>(null), [pending, setPending] = useState<string | null>(null);
  const query = (filters.search ?? '').toLowerCase();
  const searched = data.items.filter(item => `${item.name} ${company(item)} ${PROVIDER[item.provider]}`.toLowerCase().includes(query));
  const visible = searched.filter(item => filters.status === 'ALL' || item.archived === (filters.status === 'ARCHIVED'));
  async function archive(item: AccountRow) {
    if (pending) return; setPending(item.id);
    try { await mutate(`lists/load-board-accounts/${item.id}`, 'PATCH', { version: item.version, archived: !item.archived }); toast({ title: item.archived ? `${item.name} restored` : `${item.name} archived` }); router.refresh(); }
    catch (failure) { toast({ tone: 'danger', title: 'Not changed', description: errorMessage(failure, 'Reload the list and try again.') }); }
    finally { setPending(null); }
  }
  return <>
    <Table caption="Load board accounts" className="border-t border-border" rows={visible} rowKey={item => item.id} columns={[
      { key: 'name', label: 'Account', primary: true, cell: item => <Link href={`/lists/load-board-accounts/${item.id}`} className="font-medium text-primary underline-offset-4 hover:underline">{item.name}</Link> },
      { key: 'provider', label: 'Provider', cell: item => PROVIDER[item.provider] },
      { key: 'company', label: 'Company', hideBelow: 'md', cell: item => company(item) },
      { key: 'people', label: 'People', align: 'right', cell: item => item.people },
      { key: 'status', label: 'Status', cell: item => <Badge label={item.archived ? 'Archived' : 'Active'} tone={item.archived ? 'neutral' : 'success'} /> },
      ...(canChange ? [{ key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right' as const, cell: (item: AccountRow) => item.placeholder ? null : <span className="flex justify-end gap-1">
        <Button variant="outline" size="sm" disabled={!!pending} onClick={() => setEditing(item)}>Edit<span className="sr-only"> {item.name}</span></Button>
        <Button variant="ghost" size="sm" disabled={!!pending} onClick={() => void archive(item)}>{pending === item.id ? 'Saving…' : item.archived ? 'Restore' : 'Archive'}<span className="sr-only"> {item.name}</span></Button></span> }] : [])]}
      empty={<EmptyState compact title="Nothing matches these filters" description="Try another status or search." />}
      footer={<div className="flex flex-wrap items-center justify-between gap-3"><p className="text-[13px] text-muted-foreground">“Account not recorded” holds sign-ins recorded before this list. Move each to its real account.</p>
        {canChange && <Button size="sm" onClick={() => setEditing('new')}><Plus aria-hidden="true" className="size-4" />Add account</Button>}</div>} />
    {editing && <AccountDialog account={editing === 'new' ? null : editing} mcs={data.mcs} onClose={() => setEditing(null)} />}
  </>;
}

function AccountDialog({ account, mcs, onClose }: { account: AccountRow | null; mcs: AccountList['mcs']; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [under, setUnder] = useState(account?.mcId ?? (account?.companyName ? 'OTHER' : ''));
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const body = { name: form.name, mcId: under && under !== 'OTHER' ? under : account ? null : undefined, companyName: under === 'OTHER' ? form.companyName : account ? '' : undefined };
    setBusy(true); setError('');
    try {
      await (account ? mutate(`lists/load-board-accounts/${account.id}`, 'PATCH', { version: account.version, ...body }) : mutate('lists/load-board-accounts', 'POST', { provider: form.provider, ...body }));
      toast({ title: account ? 'Account updated' : 'Account added' }); onClose(); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  return <Dialog open onClose={onClose} busy={busy} title={account ? `Edit ${account.name}` : 'Add a load board account'} description="One of the company’s DAT or Truckstop accounts. Never a password."
    actions={<Button type="submit" form="lb-account" disabled={busy}>{busy ? 'Saving…' : account ? 'Save changes' : 'Add account'}</Button>}>
    <form id="lb-account" onSubmit={submit} className="space-y-4"><fieldset disabled={busy} className="min-w-0 space-y-4">
      {!account && <Select label="Provider" name="provider" required width="sm" options={(['DAT', 'TRUCKSTOP'] as Provider[]).map(value => ({ value, label: PROVIDER[value] }))} />}
      <Input label="Name" name="name" required maxLength={100} defaultValue={account?.name} width="full" autoComplete="off" hint="Such as YouPro DAT." />
      <Select label="Company it’s under" optional width="full" value={under} onChange={event => setUnder(event.target.value)} placeholder="Not set"
        options={[...mcs.map(mc => ({ value: mc.id, label: mc.archived ? `${mc.name} (archived)` : mc.name })), { value: 'OTHER', label: 'Another company' }]} />
      {under === 'OTHER' && <Input label="Company name" name="companyName" required maxLength={100} defaultValue={account?.companyName ?? ''} width="full" />}
      <Notice message={error} error />
    </fieldset></form>
  </Dialog>;
}

export interface AccountSeat { id: string; memberId: string; name: string; position: string; supportType: string; memberStatus: string; signInEmail: string | null; status: 'ACTIVE' | 'SUSPENDED' | 'ENDED';
  startedAt: string; suspendedAt: string | null; endedAt: string | null; endedHow: string | null; version: number; mcName: string | null; teamName: string | null; sharedWith: string[] }
export interface AccountPage { account: { id: string; provider: Provider; name: string; mc: string | null; companyName: string | null; placeholder: boolean; archived: boolean; version: number }; using: AccountSeat[]; history: AccountSeat[] }
/** One account (LoadBoardAccountScreen): who has it now, with their sign-in and since when; ended and moved seats are under History. */
export function LoadBoardAccountView({ data, accounts, people, canChange, linkPeople }: { data: AccountPage; accounts: LoadBoardAccount[]; people: SeatPerson[]; canChange: boolean; linkPeople: boolean }) {
  const { account } = data;
  const [adding, setAdding] = useState(false), [changing, setChanging] = useState<{ seat: AccountSeat; action: SeatAction } | null>(null);
  const person = (seat: AccountSeat) => <span className="block min-w-0">{linkPeople ? <Link href={`/dispatch/dispatchers/${seat.memberId}`} className="font-medium text-primary underline-offset-4 hover:underline">{seat.name}</Link> : <span className="font-medium">{seat.name}</span>}
    <span className="block text-[13px] text-muted-foreground">{seat.memberStatus === 'LEFT' ? 'Left' : seat.position === 'DISPATCHER' ? 'Dispatcher' : seat.supportType === 'UPDATER' ? 'Updater' : 'Support'}</span></span>;
  const columns = (open: boolean) => [
    { key: 'person', label: 'Person', primary: true, cell: (seat: AccountSeat) => person(seat) },
    ...(open ? [{ key: 'place', label: 'MC and team', hideBelow: 'md' as const, cell: (seat: AccountSeat) => seat.mcName ? `${seat.mcName}${seat.teamName ? ` · ${seat.teamName}` : ''}` : '—' }] : []),
    ...(data.using.concat(data.history).some(seat => seat.signInEmail) ? [{ key: 'email', label: 'Sign-in email', cell: (seat: AccountSeat) => <span className="break-all">{seat.signInEmail}</span> }] : []),
    { key: 'since', label: open ? 'Since' : 'Dates', nowrap: true, muted: true, hideBelow: 'lg' as const, cell: (seat: AccountSeat) => <SeatDates seat={seat} /> },
    { key: 'status', label: 'Status', cell: (seat: AccountSeat) => <span className="grid gap-0.5"><SeatBadge status={seat.status} /><span className="text-[13px] text-muted-foreground">{seatNote({ ...seat, placeholder: account.placeholder })}</span></span> },
    ...(canChange && open ? [{ key: 'actions', label: 'Actions', srOnly: true, action: true, align: 'right' as const, cell: (seat: AccountSeat) => <DropdownMenu label={`Seat actions for ${seat.name}`} triggerIcon={Ellipsis} triggerVariant="ghost" align="end" items={seatMenu(seat, action => setChanging({ seat, action }))} /> }] : [])];
  return <div className="space-y-6">
    <PageCrumb label={account.name} />
    <PageHeader title={account.name} description={[PROVIDER[account.provider], account.mc ? `Under ${account.mc}` : account.companyName ? `Under ${account.companyName}` : null, `${data.using.length} ${data.using.length === 1 ? 'person' : 'people'}`].filter(Boolean).join(' · ')}
      action={canChange && !account.placeholder && !account.archived && <Button onClick={() => setAdding(true)}><Plus aria-hidden="true" className="size-4" />Add seat</Button>} />
    {account.placeholder && <Notice message="These sign-ins were recorded before the list of accounts. Move each seat to the account it’s really on." />}
    <Card>
      <Tabs label="Seats" defaultValue="now" items={[{ key: 'now', label: 'Using it', count: data.using.length }, { key: 'history', label: 'History', count: data.history.length }]} panels={{
        now: <Table caption={`People using ${account.name}`} className="mt-3 border-t border-border" rows={data.using} rowKey={seat => seat.id} columns={columns(true)}
          empty={<EmptyState compact title="Nobody uses this account now" description={canChange ? 'Add a seat to record who signs in to it.' : 'IT records who uses each account.'} />}
          footer={!linkPeople ? undefined : <p className="text-[13px] text-muted-foreground">Exports never include sign-ins.</p>} />,
        history: <Table caption={`Earlier seats on ${account.name}`} className="mt-3 border-t border-border" rows={data.history} rowKey={seat => seat.id} columns={columns(false)}
          empty={<EmptyState compact title="No earlier seats" description="Seats that end, or move to another account, show here." />} />,
      }} />
    </Card>
    {adding && <AddSeatDialog people={people} accountId={account.id} accounts={accounts} onClose={() => setAdding(false)} />}
    {changing && changing.seat.signInEmail && <ChangeSeatDialog seat={{ ...changing.seat, signInEmail: changing.seat.signInEmail, account: account.name, accountId: account.id, provider: account.provider }} action={changing.action} who={changing.seat.name}
      accounts={accounts} companyEmails={people.filter(item => item.id === changing.seat.memberId).flatMap(item => item.companyEmail ?? [])} onClose={() => setChanging(null)} />}
  </div>;
}
