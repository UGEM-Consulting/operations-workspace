'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { inputClass } from '@/components/ui/field';
import { mutate } from '@/lib/client-api';
import type { StaffUser } from '@/lib/auth';
const policies = [{ value: 'ADMINS', label: 'Administrators only' }, { value: 'ALL_STAFF', label: 'All staff' }];
/** Requirement policy and resets. Administrators never see authenticator secrets or recovery codes. */
export function MfaAdministration({ users, currentUserId, policy }: { users: StaffUser[]; currentUserId: string; policy: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function run(action: () => Promise<unknown>, done: string) {
    setPending(true); setError(''); setMessage('');
    try { await action(); setMessage(done); setConfirming(''); router.refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Request failed'); }
    finally { setPending(false); }
  }
  async function savePolicy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mfaRequiredFor = String(new FormData(event.currentTarget).get('mfaRequiredFor'));
    await run(() => mutate('settings/security', 'PATCH', { mfaRequiredFor }), mfaRequiredFor === 'ALL_STAFF'
      ? 'All staff must now use two-step verification. Anyone not yet verified is asked to set it up at their next request.' : 'Two-step verification is now required for administrators only.');
  }
  const enrolled = users.filter(user => user.mfaEnabled);
  return <section className="mt-10 space-y-5" aria-labelledby="mfa-admin-heading">
    <h2 id="mfa-admin-heading" className="text-lg font-semibold">Two-step verification</h2>
    <Card className="space-y-4 p-5">
      <form onSubmit={savePolicy} className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Required for<select name="mfaRequiredFor" defaultValue={policy} className={`${inputClass} w-56`}>{policies.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <Button type="submit" variant="outline" disabled={pending}>Save requirement</Button>
      </form>
      <p className="text-sm text-muted-foreground">Administrators always need it. Everyone else can turn it on from Account security.</p>
      {message && <p role="status" className="text-sm text-success">{message}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </Card>
    <Card className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Two-step verification by user</caption>
      <thead className="border-b bg-muted"><tr><th scope="col" className="px-5 py-4">User</th><th scope="col" className="px-5 py-4">Status</th><th scope="col" className="px-5 py-4"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{users.map(user => <tr key={user.id} className="border-b last:border-0">
        <td className="px-5 py-4"><p className="font-medium">{user.firstName} {user.lastName}</p><p className="mt-1 break-all text-muted-foreground">{user.email}</p></td>
        <td className="px-5 py-4">{user.mfaEnabled ? 'On' : 'Off'}</td>
        <td className="px-5 py-4">{user.mfaEnabled && user.id !== currentUserId && (confirming === user.id
          ? <div className="flex flex-wrap gap-2"><Button variant="destructive" disabled={pending} onClick={() => run(() => mutate(`users/${user.id}/mfa/reset`, 'POST'), `Two-step verification was reset for ${user.email}. Their sessions have ended; they set it up again at their next sign-in.`)}>{pending ? 'Resetting…' : 'Confirm reset'}</Button><Button variant="outline" disabled={pending} onClick={() => setConfirming('')}>Cancel</Button></div>
          : <Button variant="outline" onClick={() => { setConfirming(user.id); setMessage(''); setError(''); }}>Reset<span className="sr-only"> two-step verification for {user.email}</span></Button>)}</td>
      </tr>)}</tbody></table></Card>
    <p className="text-xs text-muted-foreground">{enrolled.length} of {users.length} users have two-step verification on. Reset only after confirming the person’s identity, for example when they lost their phone and recovery codes. Resetting ends their sessions. Use Account security for your own account.</p>
  </section>;
}
