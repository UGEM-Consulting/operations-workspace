'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
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
import { mutate } from '@/lib/client-api';
import { USER_DEFAULTS } from '@/lib/navigation';
import type { StaffUser } from '@/lib/auth';
import { PageHeader } from '@/components/workspace-ui';
const roles = ['SYSTEM_ADMIN', 'DISPATCHER_MANAGER', 'IT_SPECIALIST', 'TEAM_LEAD'];
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
  const searched = users.filter(user => `${user.firstName} ${user.lastName} ${user.email}`.toLowerCase().includes(filters.search.toLowerCase()));
  const visible = searched.filter(user => filters.status === 'ALL' || user.status === filters.status);
  const filtered = filters.search !== '' || filters.status !== 'ALL';
  const [role, setRole] = useState('DISPATCHER_MANAGER');
  function edit(user: ManagedUser | null) { setEditing(user); setError(''); setOpen(true); setRole(user?.role ?? 'DISPATCHER_MANAGER'); }
  const linked = (user: ManagedUser) => leads.find(lead => lead.id === user.memberId);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data: Record<string, FormDataEntryValue> = Object.fromEntries(new FormData(event.currentTarget));
    if (!data.password) delete data.password;
    setPending(true); setError('');
    try {
      // Name-only edits keep sessions; email, role, status and password changes end them.
      const result = await mutate<{ sessionsRevoked?: boolean }>(editing ? `users/${editing.id}` : 'users', editing ? 'PATCH' : 'POST', data);
      // A revoked own session: discard the authenticated router cache.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      if (editing?.id === currentUserId && result.sessionsRevoked !== false) { window.location.assign('/login'); return; }
      setHighlight(String(data.email).trim().toLowerCase());
      toast(editing ? { title: 'User updated', description: result.sessionsRevoked === false ? undefined : 'Their existing sessions have ended.' }
        : { title: 'User created', description: 'They choose their own password when they first sign in.' });
      setOpen(false); router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save the user. Your entries have been kept.'); }
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
    {open && <Dialog open onClose={() => setOpen(false)} busy={pending} title={editing ? `Edit ${editing.firstName} ${editing.lastName}` : 'Add staff member'} actions={<Button type="submit" form="user-editor">{pending ? 'Saving…' : editing ? 'Save changes' : 'Create user'}</Button>}>
      <form id="user-editor" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2"><Input label="First name" name="firstName" defaultValue={editing?.firstName} required maxLength={100} width="full" /><Input label="Last name" name="lastName" defaultValue={editing?.lastName} required maxLength={100} width="full" /></div>
        <Input label="Email" name="email" type="email" defaultValue={editing?.email} required maxLength={254} width="full" />
        <div className="grid gap-4 sm:grid-cols-2"><Select label="Role" name="role" value={role} onChange={event => setRole(event.target.value)} width="full" options={roles.map(role => ({ value: role, label: roleLabel(role) }))} /><Select label="Status" name="status" defaultValue={editing?.status ?? 'ACTIVE'} width="full" options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }]} /></div>
        {role === 'TEAM_LEAD' && <Select label="Team lead’s dispatcher record" name="memberId" defaultValue={editing?.memberId ?? ''} required placeholder="Choose a dispatcher" width="full"
          options={leads.map(lead => ({ value: lead.id, label: lead.team ? `${lead.name} · leads ${lead.team}` : `${lead.name} · leads no team yet` }))}
          hint="They see and act only for the team this dispatcher leads. Changing it ends their sessions." />}
        <Input label={editing ? 'New password' : 'Initial password'} optional={!!editing} name="password" type="password" autoComplete="new-password" required={!editing} minLength={12} maxLength={128} width="full"
          hint={`Use 12–128 characters. ${editing?.id === currentUserId ? 'Leave blank to keep your current password.' : `${editing ? 'Leave blank to keep the current password. ' : ''}They must replace it with their own when they next sign in.`}`} />
        {editing && <Alert tone="warning"><p>Changing the email, role, status or password ends this user’s existing sessions; name changes do not.{editing.id === currentUserId && ' If you change those on your own account, you will need to sign in again.'}</p></Alert>}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
