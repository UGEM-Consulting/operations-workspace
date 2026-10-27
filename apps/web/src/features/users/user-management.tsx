'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { inputClass } from '@/components/ui/field';
import { roleLabel, StatusBadge, statusLabel } from '@/components/ui/status-badge';
import { mutate } from '@/lib/client-api';
import type { StaffUser } from '@/lib/auth';
const roles = ['SYSTEM_ADMIN', 'DISPATCHER_MANAGER', 'IT_SPECIALIST'];
export function UserManagement({ users, currentUserId }: { users: StaffUser[]; currentUserId: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState('');
  const visible = users.filter(user => `${user.firstName} ${user.lastName} ${user.email}`.toLowerCase().includes(query.toLowerCase()));
  function edit(user: StaffUser | null) { setEditing(user); setError(''); setOpen(true); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data: Record<string, FormDataEntryValue> = Object.fromEntries(new FormData(event.currentTarget));
    if (!data.password) delete data.password;
    setPending(true); setError('');
    try {
      await mutate(editing ? `users/${editing.id}` : 'users', editing ? 'PATCH' : 'POST', data);
      // Self-edits revoke the session; discard the authenticated router cache.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      if (editing?.id === currentUserId) { window.location.assign('/login'); return; }
      setHighlight(String(data.email).trim().toLowerCase()); setQuery('');
      setMessage(editing ? 'User updated. Their existing sessions have ended.' : 'User created.');
      setOpen(false); router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save the user. Your entries have been kept.'); }
    finally { setPending(false); }
  }
  return <div className="mt-8 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-4"><h2 className="text-lg font-semibold">Internal users</h2><Button onClick={() => edit(null)}><Plus aria-hidden="true" className="size-4" />Add user</Button></div>
    <Notice message={message} />
    <label className="block max-w-sm text-sm">Search users<input className={inputClass} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name or email" /></label>
    <Card className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Internal staff accounts</caption><thead className="border-b bg-muted"><tr><th scope="col" className="px-5 py-4">Name / email</th><th scope="col" className="px-5 py-4">Role / status</th><th scope="col" className="px-5 py-4"><span className="sr-only">Actions</span></th></tr></thead><tbody>{visible.map(user => <tr key={user.id} className={`border-b last:border-0 ${highlight === user.email.toLowerCase() ? 'bg-success-background/50' : ''}`}><td className="px-5 py-4"><p className="font-medium">{user.firstName} {user.lastName}</p><p className="mt-1 break-all text-muted-foreground">{user.email}</p></td><td className="px-5 py-4"><p className="mb-2">{roleLabel(user.role)}</p><StatusBadge label={statusLabel(user.status)} tone={user.status === 'ACTIVE' ? 'success' : 'neutral'} /></td><td className="px-5 py-4"><Button variant="outline" onClick={() => edit(user)}>Edit<span className="sr-only"> {user.email}</span></Button></td></tr>)}</tbody></table>{!visible.length && <p className="p-8 text-center text-sm text-muted-foreground">{query ? 'No users match your search. Try another name or email.' : 'No internal users to display.'}</p>}</Card>
    <p className="text-xs text-muted-foreground">Showing up to 200 internal accounts. Applicants are separate.</p>
    {open && <Dialog open onClose={() => setOpen(false)} busy={pending} title={editing ? `Edit ${editing.firstName} ${editing.lastName}` : 'Add internal user'} description="Required fields are marked with an asterisk." actions={<Button type="submit" form="user-editor">{pending ? 'Saving…' : editing ? 'Save changes' : 'Create user'}</Button>}>
      <form id="user-editor" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">First name *<input name="firstName" defaultValue={editing?.firstName} required maxLength={100} className={inputClass} /></label><label className="text-sm">Last name *<input name="lastName" defaultValue={editing?.lastName} required maxLength={100} className={inputClass} /></label></div>
        <label className="block text-sm">Email *<input name="email" type="email" defaultValue={editing?.email} required maxLength={254} className={inputClass} /></label>
        <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm">Role *<select name="role" defaultValue={editing?.role ?? 'DISPATCHER_MANAGER'} className={inputClass}>{roles.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label><label className="block text-sm">Status *<select name="status" defaultValue={editing?.status ?? 'ACTIVE'} className={inputClass}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label></div>
        <label className="block text-sm">{editing ? 'New password (optional)' : 'Initial password *'}<input name="password" type="password" autoComplete="new-password" required={!editing} minLength={12} maxLength={128} aria-describedby="user-password-help" className={inputClass} /></label>
        <p id="user-password-help" className="text-sm text-muted-foreground">Use 12–128 characters.{editing && ' Leave blank to keep the current password.'}</p>
        {editing && <p className="rounded-lg bg-warning-background p-3 text-sm text-warning">Saving changes ends this user’s existing sessions.{editing.id === currentUserId && ' You are editing your own account and will need to sign in again.'}</p>}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
