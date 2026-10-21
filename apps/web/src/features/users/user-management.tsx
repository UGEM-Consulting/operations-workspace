"use client";
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { mutate } from '@/lib/client-api';
import type { StaffUser } from '@/lib/auth';
const roles = ['SYSTEM_ADMIN', 'DISPATCHER_MANAGER', 'IT_SPECIALIST'];
const field = 'mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm';
export function UserManagement({ users, currentUserId }: { users: StaffUser[]; currentUserId: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const data: Record<string, FormDataEntryValue> = Object.fromEntries(form);
    if (!data.password) delete data.password;
    try {
      await mutate(editing ? `users/${editing.id}` : 'users', editing ? 'PATCH' : 'POST', data);
      // Editing yourself revokes your session; discard the authenticated router cache.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      if (editing?.id === currentUserId) { window.location.assign('/login'); return; }
      setMessage(editing ? 'User updated. Existing sessions were revoked.' : 'User created.'); setEditing(null); formElement.reset(); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Request failed'); }
    finally { setPending(false); }
  }
  return <div className="mt-8 grid gap-6 xl:grid-cols-[1.3fr_1fr]"><Card className="overflow-x-auto p-5"><h2 className="mb-4 font-semibold">Internal users</h2><table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="pb-3">Name / email</th><th>Role / status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{users.map(user => <tr key={user.id} className="border-t"><td className="py-4 pr-3"><p className="font-medium">{user.firstName} {user.lastName}</p><p className="mt-1 text-xs text-muted-foreground">{user.email}</p></td><td className="pr-3 text-xs"><p>{user.role.replaceAll('_', ' ')}</p><p className="mt-1 text-muted-foreground">{user.status}</p></td><td><Button variant="outline" onClick={() => { setEditing(user); setMessage(''); }}>Edit<span className="sr-only"> {user.email}</span></Button></td></tr>)}</tbody></table><p className="mt-4 text-xs text-muted-foreground">Showing up to 200 internal accounts. Applicants are separate.</p></Card><Card className="p-6"><h2 className="font-semibold">{editing ? 'Edit internal user' : 'Create internal user'}</h2><form key={editing?.id ?? 'new'} onSubmit={submit} className="mt-5 space-y-4"><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">First name<input name="firstName" defaultValue={editing?.firstName} required maxLength={100} className={field} /></label><label className="text-sm">Last name<input name="lastName" defaultValue={editing?.lastName} required maxLength={100} className={field} /></label></div><label className="block text-sm">Email<input name="email" type="email" defaultValue={editing?.email} required maxLength={254} className={field} /></label><label className="block text-sm">Role<select name="role" defaultValue={editing?.role ?? 'DISPATCHER_MANAGER'} className={field}>{roles.map(role => <option key={role}>{role}</option>)}</select></label><label className="block text-sm">Status<select name="status" defaultValue={editing?.status ?? 'ACTIVE'} className={field}><option>ACTIVE</option><option>INACTIVE</option></select></label><label className="block text-sm">{editing ? 'New password (optional)' : 'Initial password'}<input name="password" type="password" autoComplete="new-password" required={!editing} minLength={12} maxLength={128} className={field} /></label><p className="text-xs leading-5 text-muted-foreground">Use at least 12 characters. Changes revoke this user’s sessions, including your own if you edit yourself.</p><div className="flex gap-3"><Button disabled={pending} type="submit">{pending ? 'Saving…' : 'Save user'}</Button>{editing && <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>}</div></form>{message && <p role="status" className="mt-4 text-sm">{message}</p>}</Card></div>;
}
