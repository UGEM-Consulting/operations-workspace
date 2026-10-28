'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Input, Select } from '@/components/ui/field';
import { Table } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { Person } from '@/components/ui/avatar';
import { useToast } from '@/components/ui/toast';
import { Badge, roleLabel, StatusBadge } from '@/components/ui/status-badge';
import { mutate } from '@/lib/client-api';
import type { StaffUser } from '@/lib/auth';
const roles = ['SYSTEM_ADMIN', 'DISPATCHER_MANAGER', 'IT_SPECIALIST'];
type ManagedUser = StaffUser & { mustChangePassword?: boolean };
export function UserManagement({ users, currentUserId }: { users: ManagedUser[]; currentUserId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState('');
  const visible = users.filter(user => `${user.firstName} ${user.lastName} ${user.email}`.toLowerCase().includes(query.toLowerCase()));
  function edit(user: ManagedUser | null) { setEditing(user); setError(''); setOpen(true); }
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
      setHighlight(String(data.email).trim().toLowerCase()); setQuery('');
      toast(editing ? { title: 'User updated', description: result.sessionsRevoked === false ? undefined : 'Their existing sessions have ended.' }
        : { title: 'User created', description: 'They choose their own password when they first sign in.' });
      setOpen(false); router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save the user. Your entries have been kept.'); }
    finally { setPending(false); }
  }
  return <div className="mt-8 space-y-5">
    <Card>
      <CardHeader title="Internal users" description={`${users.length} staff account${users.length === 1 ? '' : 's'}. Applicants are separate.`} actions={<Button size="sm" onClick={() => edit(null)}><Plus aria-hidden="true" className="size-4" />Add user</Button>} />
      <div className="px-4 pb-4 pt-3 sm:px-5"><Input label="Search users" name="userSearch" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name or email" width="md" /></div>
      <Table caption="Internal staff accounts" rows={visible} rowKey={user => user.id} className="border-t border-border"
        rowClassName={user => highlight === user.email.toLowerCase() ? 'bg-success-background/50' : undefined} columns={[
          { key: 'person', label: 'Name', primary: true, cell: user => <Person name={`${user.firstName} ${user.lastName}`} secondary={user.email} /> },
          { key: 'role', label: 'Role', cell: user => roleLabel(user.role) },
          { key: 'status', label: 'Status', cell: user => <span className="flex flex-wrap gap-1.5"><StatusBadge status={user.status} />{user.mustChangePassword && <Badge label="Password change pending" tone="warning" />}</span> },
          { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: user => <Button variant="outline" size="sm" onClick={() => edit(user)}>Edit<span className="sr-only"> {user.email}</span></Button> },
        ]} empty={<EmptyState compact title={query ? 'No matching users' : 'No internal users'} description={query ? 'Try another name or email.' : undefined} />}
        footer={<p className="text-[13px] text-muted-foreground">Showing up to 200 internal accounts.</p>} />
    </Card>
    {open && <Dialog open onClose={() => setOpen(false)} busy={pending} title={editing ? `Edit ${editing.firstName} ${editing.lastName}` : 'Add internal user'} actions={<Button type="submit" form="user-editor">{pending ? 'Saving…' : editing ? 'Save changes' : 'Create user'}</Button>}>
      <form id="user-editor" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2"><Input label="First name" name="firstName" defaultValue={editing?.firstName} required maxLength={100} width="full" /><Input label="Last name" name="lastName" defaultValue={editing?.lastName} required maxLength={100} width="full" /></div>
        <Input label="Email" name="email" type="email" defaultValue={editing?.email} required maxLength={254} width="full" />
        <div className="grid gap-4 sm:grid-cols-2"><Select label="Role" name="role" defaultValue={editing?.role ?? 'DISPATCHER_MANAGER'} width="full" options={roles.map(role => ({ value: role, label: roleLabel(role) }))} /><Select label="Status" name="status" defaultValue={editing?.status ?? 'ACTIVE'} width="full" options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }]} /></div>
        <Input label={editing ? 'New password' : 'Initial password'} optional={!!editing} name="password" type="password" autoComplete="new-password" required={!editing} minLength={12} maxLength={128} width="full"
          hint={`Use 12–128 characters. ${editing?.id === currentUserId ? 'Leave blank to keep your current password.' : `${editing ? 'Leave blank to keep the current password. ' : ''}They must replace it with their own when they next sign in.`}`} />
        {editing && <Alert tone="warning"><p>Changing the email, role, status or password ends this user’s existing sessions; name changes do not.{editing.id === currentUserId && ' If you change those on your own account, you will need to sign in again.'}</p></Alert>}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
