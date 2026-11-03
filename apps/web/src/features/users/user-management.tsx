'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { KeyRound, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Input, Select } from '@/components/ui/field';
import { FilterBar } from '@/components/ui/filter-bar';
import { Table } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { Person } from '@/components/ui/avatar';
import { useToast } from '@/components/ui/toast';
import { Badge, roleLabel, StatusBadge } from '@/components/ui/status-badge';
import { ApiError, errorMessage, mutate } from '@/lib/client-api';
import { readApi } from '@/features/onboarding/types';
import { USER_DEFAULTS } from '@/lib/navigation';
import type { StaffUser } from '@/lib/auth';
import { PageHeader } from '@/components/workspace-ui';
import { PasswordReadyDialog, type ReadyPassword } from './password-ready-dialog';
const roles = ['SYSTEM_ADMIN', 'DISPATCHER_MANAGER', 'IT_SPECIALIST', 'TEAM_LEAD', 'SAFETY_MANAGER', 'SAFETY_LEAD', 'SAFETY_STAFF'];
// Roles that can be responsible for invitations and applications; losing them (or the account) hands those records over.
const RESPONSIBLE = ['DISPATCHER_MANAGER', 'SYSTEM_ADMIN'];
interface OpenRecords { invitations: number; applications: number; changes: number; itSetup: number; removals?: number; total: number }
type ManagedUser = StaffUser & { mustChangePassword?: boolean; memberId?: string | null };
/** A dispatcher record a team lead account can link to; what the account sees follows the team it leads. */
export interface LeadChoice { id: string; name: string; team: string | null }
/**
 * Staff accounts with status tabs and search kept in the URL; filtering happens here because the API returns every account.
 * `page` renders it as the Staff accounts page; otherwise it is a card on Settings (an older API without that page).
 */
export function UserManagement({ users, currentUserId, filters, page = false, leads = [] }: { users: ManagedUser[]; currentUserId: string; filters: Record<string, string>; page?: boolean; leads?: LeadChoice[] }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [highlight, setHighlight] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState('');
  const [ready, setReady] = useState<ReadyPassword | null>(null);
  const searched = users.filter(user => `${user.firstName} ${user.lastName} ${user.email}`.toLowerCase().includes(filters.search.toLowerCase()));
  const visible = searched.filter(user => filters.status === 'ALL' || user.status === filters.status);
  const filtered = filters.search !== '' || filters.status !== 'ALL';
  const [role, setRole] = useState('DISPATCHER_MANAGER');
  const [status, setStatus] = useState('ACTIVE');
  // A manager's open records, loaded when the change would take their access away (designed as HandOverOnDeactivateScreen).
  const [records, setRecords] = useState<OpenRecords | 'loading' | 'failed' | null>(null);
  function edit(user: ManagedUser | null) { setEditing(user); setError(''); setOpen(true); setRole(user?.role ?? 'DISPATCHER_MANAGER'); setStatus(user?.status ?? 'ACTIVE'); setRecords(null); }
  const responsible = !!editing && editing.status === 'ACTIVE' && RESPONSIBLE.includes(editing.role);
  const losesAccess = responsible && (status === 'INACTIVE' || !RESPONSIBLE.includes(role));
  async function change(next: { role?: string; status?: string }) {
    if (next.role !== undefined) setRole(next.role);
    if (next.status !== undefined) setStatus(next.status);
    const nextRole = next.role ?? role, nextStatus = next.status ?? status;
    if (!editing || !responsible || records !== null || (nextStatus !== 'INACTIVE' && RESPONSIBLE.includes(nextRole))) return;
    await loadRecords(editing.id);
  }
  async function loadRecords(id: string) {
    setRecords('loading');
    try { setRecords(await readApi<OpenRecords>(`users/${id}/open-records`)); } catch { setRecords('failed'); }
  }
  const takers = users.filter(user => user.status === 'ACTIVE' && RESPONSIBLE.includes(user.role) && user.id !== editing?.id);
  const takerOptions = takers.map(user => ({ value: user.id, label: `${user.firstName} ${user.lastName} · ${roleLabel(user.role)}${user.id === currentUserId ? ' (you)' : ''}` }));
  const linked = (user: ManagedUser) => leads.find(lead => lead.id === user.memberId);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data: Record<string, FormDataEntryValue> = Object.fromEntries(new FormData(event.currentTarget));
    if (!data.handOverTo) delete data.handOverTo;
    setPending(true); setError('');
    try {
      // Name-only edits keep sessions; email, role and status changes end them.
      const result = await mutate<{ sessionsRevoked?: boolean; generatedPassword?: string }>(editing ? `users/${editing.id}` : 'users', editing ? 'PATCH' : 'POST', data);
      // A revoked own session: discard the authenticated router cache.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      if (editing?.id === currentUserId && result.sessionsRevoked !== false) { window.location.assign('/login'); return; }
      setHighlight(String(data.email).trim().toLowerCase());
      const handed = (result as { handedOver?: number }).handedOver ?? 0;
      if (editing) toast({ title: 'User updated', description: [result.sessionsRevoked === false ? '' : 'Their existing sessions have ended.', handed ? `${handed} open record${handed === 1 ? '' : 's'} handed over.` : ''].filter(Boolean).join(' ') || undefined });
      else if (result.generatedPassword) setReady({ kind: 'created', name: `${String(data.firstName).trim()} ${String(data.lastName).trim()}`, firstName: String(data.firstName).trim(), email: String(data.email).trim().toLowerCase(), password: result.generatedPassword });
      setOpen(false); router.refresh();
    } catch (error) {
      setError(errorMessage(error, 'Unable to save the user. Your entries have been kept.'));
      // They may have gained open records since the check: load them again so the dialog can ask who takes over.
      if (error instanceof ApiError && error.kind === 'conflict' && editing && losesAccess) void loadRecords(editing.id);
    }
    finally { setPending(false); }
  }
  // The editor stays open behind this, so anything typed there is kept.
  async function resetPassword() {
    if (pending || !editing) return;
    setPending(true); setResetError('');
    try {
      const result = await mutate<{ generatedPassword?: string }>(`users/${editing.id}`, 'PATCH', { generatePassword: true });
      setResetting(false);
      if (result.generatedPassword) setReady({ kind: 'reset', name: `${editing.firstName} ${editing.lastName}`, firstName: editing.firstName, email: editing.email, password: result.generatedPassword });
      router.refresh();
    } catch (error) { setResetError(errorMessage(error, 'Unable to reset the password. Please try again.')); }
    finally { setPending(false); }
  }
  const description = 'People who can sign in to the workspace. Applicants don’t need accounts.';
  const add = (size?: 'sm') => <Button size={size} onClick={() => edit(null)}><Plus aria-hidden="true" className="size-4" />Add staff member</Button>;
  return <div className={page ? 'space-y-6' : 'mt-8 space-y-5'}>
    {page && <PageHeader title="Staff accounts" description={description} action={add()} />}
    <Card>
      {!page && <CardHeader title="Staff accounts" description={description} actions={add('sm')} />}
      <FilterBar path={page ? '/staff-accounts' : '/settings'} filters={filters} defaults={USER_DEFAULTS} searchLabel="Search name or email" statuses={[
        { key: 'ACTIVE', label: 'Active', count: searched.filter(user => user.status === 'ACTIVE').length },
        { key: 'INACTIVE', label: 'Inactive', count: searched.filter(user => user.status === 'INACTIVE').length },
        { key: 'ALL', label: 'All', count: searched.length }]} />
      <Table caption="Internal staff accounts" rows={visible} rowKey={user => user.id} className="border-t border-border"
        rowClassName={user => highlight === user.email.toLowerCase() ? 'bg-success-background/50' : undefined} columns={[
          { key: 'person', label: 'Name', primary: true, cell: user => <Person name={`${user.firstName} ${user.lastName}`} secondary={user.email} /> },
          { key: 'role', label: 'Role', cell: user => user.role === 'TEAM_LEAD' && linked(user) ? <>{roleLabel(user.role)}<span className="block text-[13px] text-muted-foreground">{linked(user)!.team ?? 'No team led'}</span></> : roleLabel(user.role) },
          { key: 'status', label: 'Status', cell: user => <span className="flex flex-wrap gap-1.5"><StatusBadge status={user.status} />{user.mustChangePassword && <Badge label="Password change pending" tone="warning" />}</span> },
          { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: user => <Button variant="outline" size="sm" onClick={() => edit(user)}>Edit<span className="sr-only"> {user.email}</span></Button> },
        ]} empty={<EmptyState compact title={filtered ? 'No matching accounts' : 'No staff accounts'} description={filtered ? 'Try another status, name or email.' : undefined} />}
        footer={<p className="text-[13px] text-muted-foreground">{visible.length} of {users.length} staff account{users.length === 1 ? '' : 's'} · up to 200 shown.</p>} />
    </Card>
    {open && <Dialog open onClose={() => setOpen(false)} busy={pending} title={editing ? `Edit ${editing.firstName} ${editing.lastName}` : 'Add staff member'} actions={<Button type="submit" form="user-editor">{pending ? 'Saving…' : editing ? (losesAccess && records && typeof records === 'object' && records.total > 0 ? (status === 'INACTIVE' ? 'Hand over and deactivate' : 'Hand over and save') : 'Save changes') : 'Create account'}</Button>}>
      <form id="user-editor" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2"><Input label="First name" name="firstName" defaultValue={editing?.firstName} required maxLength={100} width="full" /><Input label="Last name" name="lastName" defaultValue={editing?.lastName} required maxLength={100} width="full" /></div>
        <Input label="Email" name="email" type="email" defaultValue={editing?.email} required maxLength={254} width="full" />
        <div className="grid gap-4 sm:grid-cols-2"><Select label="Role" name="role" value={role} onChange={event => void change({ role: event.target.value })} width="full" options={roles.map(role => ({ value: role, label: roleLabel(role) }))} /><Select label="Status" name="status" value={status} onChange={event => void change({ status: event.target.value })} width="full" options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }]} /></div>
        {losesAccess && records === 'loading' && <p role="status" className="text-sm text-muted-foreground">Checking their open invitations and applications…</p>}
        {losesAccess && records === 'failed' && <>
          <Alert tone="warning"><p>Their open records couldn’t be checked. If they may have any, choose who takes them over.</p></Alert>
          <Select id="hand-over-to" label="Hand them over to" optional name="handOverTo" defaultValue="" placeholder="Choose a manager" width="full" options={takerOptions} /></>}
        {losesAccess && records && typeof records === 'object' && records.total > 0 && <Card>
          <CardHeader title={`${editing?.firstName} has ${records.total} open record${records.total === 1 ? '' : 's'}`} />
          <div className="space-y-4 px-4 pb-4 pt-3 sm:px-5">
            <ul className="space-y-2 text-sm">{([['Invitations not used yet', records.invitations], ['Applications in progress or awaiting review', records.applications], ['Waiting for the applicant’s changes', records.changes], ['Approved, IT setup not finished', records.itSetup], ...(records.removals ? [['Dispatchers leaving, IT removal not finished', records.removals]] as const : [])] as const)
              .map(([label, count]) => <li key={label} className="flex justify-between gap-3"><span>{label}</span><span className="font-semibold tabular-nums">{count}</span></li>)}</ul>
            <Select id="hand-over-to" label="Hand them over to" name="handOverTo" required placeholder="Choose a manager" width="full"
              options={takerOptions}
              hint={`All ${records.total} move together. Finished applications stay with ${editing?.firstName} for the record. Applicants aren’t told; their links keep working.${records.removals ? ' New email from a leaving dispatcher goes to the new manager instead, and IT sees that on the checklist.' : ''}`} />
          </div></Card>}
        {role === 'TEAM_LEAD' && <Select label="Team lead’s dispatcher record" name="memberId" defaultValue={editing?.memberId ?? ''} required placeholder="Choose a dispatcher" width="full"
          options={leads.map(lead => ({ value: lead.id, label: lead.team ? `${lead.name} · leads ${lead.team}` : `${lead.name} · leads no team yet` }))}
          hint="They see and act only for the team this dispatcher leads. Changing it ends their sessions." />}
        {!editing && <p className="text-[13px] leading-5 text-muted-foreground">We’ll create a first password for you to send them. They replace it with their own when they first sign in.</p>}
        {editing && (editing.id === currentUserId
          ? <p className="text-[13px] leading-5 text-muted-foreground">Change your own password in <Link href="/account/security" className="font-medium underline">Account security</Link>.</p>
          : <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium">Password</p><p className="text-[13px] leading-5 text-muted-foreground">Forgotten, or the first one was lost? Create a new one to send them.</p></div>
            <Button type="button" variant="outline" size="sm" onClick={() => { setResetError(''); setResetting(true); }}><KeyRound aria-hidden="true" className="size-4" />Reset password</Button></div>)}
        {editing && <Alert tone="warning"><p>Changing the email, role or status ends this user’s existing sessions; name changes do not.{editing.id === currentUserId && ' If you change those on your own account, you will need to sign in again.'}</p></Alert>}
        <Notice message={error} error />
      </form>
    </Dialog>}
    {resetting && editing && <Dialog open size="sm" tone="danger" busy={pending} protectChanges={false} onClose={() => setResetting(false)} title={`Reset ${editing.firstName} ${editing.lastName}’s password?`}
      description="Their current password stops working and they’re signed out everywhere."
      actions={<Button type="button" variant="destructive" disabled={pending} onClick={() => void resetPassword()}>{pending ? 'Resetting…' : 'Reset password'}</Button>}>
      <p className="text-sm">You’ll see a new password once, to send them.</p>
      <Notice message={resetError} error />
    </Dialog>}
    {ready && <PasswordReadyDialog ready={ready} onClose={() => setReady(null)} />}
  </div>;
}
