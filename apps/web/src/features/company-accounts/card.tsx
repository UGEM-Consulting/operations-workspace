'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ellipsis, Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { DescriptionList } from '@/components/ui/description-list';
import { DropdownMenu, type MenuEntry } from '@/components/ui/dropdown-menu';
import { Notice } from '@/components/ui/alert';
import { Input, RadioGroup, Select } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';

// Accounts at other companies (Design System section 33, Company accounts and load boards, approved 2026-11-13).
export type AccountStatus = 'ACTIVE' | 'KEPT_FOR_LOAD_BOARDS' | 'CLOSED';
export interface CompanyAccount { id: string; mcId: string | null; mc: string | null; mcArchived: boolean; companyName: string | null; nameUsed: string | null; companyEmail: string | null;
  ringCentralNumber: string | null; ringCentralExtension: string | null; status: AccountStatus; closedAt: string | null; sourceName: string | null; version: number; keptFor: string[] }
const STATUS: Record<AccountStatus, { label: string; tone: 'success' | 'warning' | 'neutral' }> = { ACTIVE: { label: 'Active', tone: 'success' }, KEPT_FOR_LOAD_BOARDS: { label: 'Kept for load boards', tone: 'warning' }, CLOSED: { label: 'Closed', tone: 'neutral' } };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
export const companyOf = (account: Pick<CompanyAccount, 'mc' | 'mcArchived' | 'companyName'>) => account.mc ? `${account.mc}${account.mcArchived ? ' (archived)' : ''}` : account.companyName ?? '';

/**
 * Company accounts on a dispatcher's page (CompanyAccountsProfileScreen): one per company they work for or worked for,
 * besides their main accounts. An email kept open for a load board says which seat keeps it. Administrators add and change
 * them here (CompanyAccountsAdminScreen); everyone else reads.
 */
export function CompanyAccountsCard({ memberId, accounts, mcs, canChange }: { memberId: string; accounts: CompanyAccount[]; mcs: { id: string; name: string; archived?: boolean }[]; canChange: boolean }) {
  const [editing, setEditing] = useState<CompanyAccount | 'new' | null>(null), [closing, setClosing] = useState<CompanyAccount | null>(null);
  const router = useRouter(), toast = useToast(), [busy, setBusy] = useState(false);
  if (!accounts.length && !canChange) return null;
  async function setStatus(account: CompanyAccount, status: AccountStatus) {
    if (busy) return; setBusy(true);
    try { await mutate(`company-accounts/${account.id}`, 'PATCH', { version: account.version, status }); toast({ title: 'Account updated' }); router.refresh(); }
    catch (failure) { toast({ tone: 'danger', title: 'Not changed', description: errorMessage(failure, 'Reload the page and try again.') }); }
    finally { setBusy(false); }
  }
  const menu = (account: CompanyAccount): MenuEntry[] => [{ label: 'Edit', icon: Pencil, onSelect: () => setEditing(account) },
    ...(account.status === 'ACTIVE' ? [{ label: 'Kept for load boards', onSelect: () => void setStatus(account, 'KEPT_FOR_LOAD_BOARDS') }] : [{ label: account.status === 'CLOSED' ? 'Open again' : 'Active', onSelect: () => void setStatus(account, 'ACTIVE') }]),
    ...(account.status === 'CLOSED' ? [] : [{ separator: true as const }, { label: 'Record as closed', onSelect: () => setClosing(account) }])];
  return <Card>
    <CardHeader title="Company accounts" description="Accounts at other companies they work for or worked for." actions={canChange && <Button size="sm" variant="ghost" onClick={() => setEditing('new')}><Plus aria-hidden="true" className="size-4" />Add account</Button>} />
    <CardBody>{accounts.length ? <ul className="divide-y divide-border">{accounts.map(account => <li key={account.id} className="grid gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{companyOf(account)}</span>
        <span className="flex items-center gap-1"><Badge label={STATUS[account.status].label} tone={STATUS[account.status].tone} />{canChange && <DropdownMenu label={`Actions for the account at ${companyOf(account)}`} triggerIcon={Ellipsis} triggerVariant="ghost" align="end" items={menu(account)} />}</span></div>
      {account.nameUsed && <p className="text-[13px] text-muted-foreground">As {account.nameUsed}</p>}
      <DescriptionList layout="rows" stacked items={[...(account.companyEmail ? [{ label: 'Company email', value: account.companyEmail }] : []), ...(account.ringCentralNumber ? [{ label: 'RingCentral number', value: account.ringCentralNumber, mono: true }] : []),
        ...(account.ringCentralExtension ? [{ label: 'Extension', value: account.ringCentralExtension, mono: true }] : []), ...(account.closedAt ? [{ label: 'Closed', value: <LocalTime iso={account.closedAt} format="date" /> }] : [])]} />
      {account.status !== 'CLOSED' && account.keptFor.length > 0 && <p className="text-[13px] leading-5 text-muted-foreground">Signs in to {account.keptFor.join(' and ')}.{account.status === 'KEPT_FOR_LOAD_BOARDS' ? ' Close it once no seat uses it.' : ''}</p>}
      {account.status === 'KEPT_FOR_LOAD_BOARDS' && !account.keptFor.length && <p className="text-[13px] leading-5 text-muted-foreground">No load board seat uses it now, so it can be closed.</p>}
    </li>)}</ul> : <p className="text-sm text-muted-foreground">None recorded.</p>}</CardBody>
    {editing && <AccountDialog memberId={memberId} account={editing === 'new' ? null : editing} mcs={mcs} onClose={() => setEditing(null)} />}
    {closing && <ClosedDialog account={closing} onClose={() => setClosing(null)} />}
  </Card>;
}

function AccountDialog({ memberId, account, mcs, onClose }: { memberId: string; account: CompanyAccount | null; mcs: { id: string; name: string; archived?: boolean }[]; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [company, setCompany] = useState(account?.mcId ?? (account?.companyName ? 'OTHER' : ''));
  const [state, setState] = useState<'ACTIVE' | 'CLOSED'>('ACTIVE');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const fields = { nameUsed: form.nameUsed ?? '', companyEmail: form.companyEmail ?? '', ringCentralNumber: form.ringCentralNumber ?? '', ringCentralExtension: form.ringCentralExtension ?? '' };
    setBusy(true); setError('');
    try {
      await (account ? mutate(`company-accounts/${account.id}`, 'PATCH', { version: account.version, ...fields })
        : mutate('company-accounts', 'POST', { memberId, ...(company === 'OTHER' ? { companyName: form.companyName } : { mcId: company }), ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value)),
          ...(state === 'CLOSED' ? { status: 'CLOSED', closedOn: form.closedOn } : {}) }));
      toast({ title: account ? 'Account updated' : 'Account added' }); onClose(); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  return <Dialog open onClose={onClose} busy={busy} title={account ? `Edit the account at ${companyOf(account)}` : 'Add an account at another company'} description="Never a password. Nobody is messaged."
    actions={<Button type="submit" form="company-account" disabled={busy}>{busy ? 'Saving…' : account ? 'Save changes' : 'Add account'}</Button>}>
    <form id="company-account" onSubmit={submit} className="space-y-4"><fieldset disabled={busy} className="min-w-0 space-y-4">
      {!account && <Select label="Company" required width="full" placeholder="Choose a company" value={company} onChange={event => setCompany(event.target.value)}
        options={[...mcs.map(mc => ({ value: mc.id, label: mc.archived ? `${mc.name} (archived)` : mc.name })), { value: 'OTHER', label: 'Another company' }]} />}
      {company === 'OTHER' && !account && <Input label="Company name" name="companyName" required maxLength={100} width="full" />}
      <Input label="Name used there" name="nameUsed" optional maxLength={100} defaultValue={account?.nameUsed ?? ''} width="full" hint="The American name they use or used at this company. Latin letters." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Company email" name="companyEmail" optional type="email" maxLength={254} defaultValue={account?.companyEmail ?? ''} width="full" />
        <Input label="RingCentral number" name="ringCentralNumber" optional type="tel" maxLength={40} defaultValue={account?.ringCentralNumber ?? ''} width="full" />
      </div>
      <Input label="Extension" name="ringCentralExtension" optional inputMode="numeric" maxLength={6} defaultValue={account?.ringCentralExtension ?? ''} width="sm" />
      {!account && <RadioGroup name="state" label="Is it still open?" value={state} onChange={value => setState(value as 'ACTIVE' | 'CLOSED')} options={[{ value: 'ACTIVE', label: 'Yes, it’s open' }, { value: 'CLOSED', label: 'No, it’s closed', description: 'Recorded for history.' }]} />}
      {!account && state === 'CLOSED' && <Input label="Closed on" name="closedOn" type="date" required max={today()} min="1980-01-01" width="sm" />}
      <Notice message={error} error />
    </fieldset></form>
  </Dialog>;
}

/** Records that an account is already closed. Asking IT to close one is its own request. */
function ClosedDialog({ account, onClose }: { account: CompanyAccount; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const closedOn = String(new FormData(event.currentTarget).get('closedOn') ?? '');
    setBusy(true); setError('');
    try { await mutate(`company-accounts/${account.id}`, 'PATCH', { version: account.version, status: 'CLOSED', closedOn }); toast({ title: 'Recorded as closed' }); onClose(); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  return <Dialog open onClose={onClose} busy={busy} title={`Record the account at ${companyOf(account)} as closed`} description="For an account that’s already closed. The row stays as history."
    actions={<Button type="submit" form="account-closed" disabled={busy}>{busy ? 'Saving…' : 'Record as closed'}</Button>}>
    <form id="account-closed" onSubmit={submit} className="space-y-4"><fieldset disabled={busy} className="min-w-0 space-y-4">
      <Input label="Closed on" name="closedOn" type="date" required defaultValue={today()} max={today()} min="1980-01-01" width="sm" />
      {account.keptFor.length > 0 && <Notice message={`It still signs in to ${account.keptFor.join(' and ')}. Move or end that seat first if they still need it.`} />}
      <Notice message={error} error />
    </fieldset></form>
  </Dialog>;
}
