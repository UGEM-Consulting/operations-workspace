'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Select } from '@/components/ui/field';
import { Table } from '@/components/ui/table';
import { Person } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { mutate } from '@/lib/client-api';
import type { StaffUser } from '@/lib/auth';
const policies = [{ value: 'ADMINS', label: 'Administrators only' }, { value: 'ALL_STAFF', label: 'All staff' }];
/** Requirement policy and resets. Administrators never see authenticator secrets or recovery codes. */
export function MfaAdministration({ users, currentUserId, policy }: { users: StaffUser[]; currentUserId: string; policy: string }) {
  const router = useRouter();
  const toast = useToast();
  const [resetting, setResetting] = useState<StaffUser | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<unknown>, title: string, description: string) {
    setPending(true); setError('');
    try { await action(); toast({ title, description }); setResetting(null); router.refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Request failed'); }
    finally { setPending(false); }
  }
  async function savePolicy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mfaRequiredFor = String(new FormData(event.currentTarget).get('mfaRequiredFor'));
    await run(() => mutate('settings/security', 'PATCH', { mfaRequiredFor }), 'Requirement saved', mfaRequiredFor === 'ALL_STAFF'
      ? 'All staff must now use two-step verification. Anyone not yet verified is asked to set it up at their next request.' : 'Two-step verification is now required for administrators only.');
  }
  const enrolled = users.filter(user => user.mfaEnabled);
  return <section className="mt-10 space-y-5" aria-labelledby="mfa-admin-heading">
    <h2 id="mfa-admin-heading" className="text-lg font-semibold">Two-step verification</h2>
    <Card className="space-y-4 p-4 sm:p-5">
      <form onSubmit={savePolicy} className="flex flex-wrap items-end gap-3">
        <Select label="Required for" name="mfaRequiredFor" defaultValue={policy} width="md" options={policies} />
        <Button type="submit" variant="outline" disabled={pending}>Save requirement</Button>
      </form>
      <p className="text-[13px] leading-5 text-muted-foreground">Administrators always need it. Everyone else can turn it on from Account security.</p>
      {!resetting && <Notice message={error} error />}
    </Card>
    <Card>
      <CardHeader title="Staff" description={`${enrolled.length} of ${users.length} users have two-step verification on.`} />
      <Table caption="Two-step verification by user" rows={users} rowKey={user => user.id} className="mt-3 border-t border-border" columns={[
        { key: 'person', label: 'User', primary: true, cell: user => <Person name={`${user.firstName} ${user.lastName}`} secondary={user.email} /> },
        { key: 'status', label: 'Two-step verification', cell: user => <span className="flex flex-wrap items-center gap-2"><Badge label={user.mfaEnabled ? 'On' : 'Off'} tone={user.mfaEnabled ? 'success' : 'neutral'} />{user.mfaEnabled && <span className="text-[13px] text-muted-foreground">{user.mfaMethod === 'EMAIL' ? 'Email codes' : 'Authenticator app'}</span>}</span> },
        { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: user => user.mfaEnabled && user.id !== currentUserId && <Button variant="outline" size="sm" onClick={() => { setResetting(user); setError(''); }}>Reset<span className="sr-only"> two-step verification for {user.email}</span></Button> },
      ]} footer={<p className="text-[13px] text-muted-foreground">Reset only after confirming the person’s identity. Use Account security for your own account.</p>} />
    </Card>
    {resetting && <Dialog open size="sm" tone="danger" onClose={() => setResetting(null)} busy={pending} protectChanges={false} title="Reset two-step verification?"
      description={`${resetting.firstName} ${resetting.lastName} will be signed out everywhere and asked to set it up again at their next sign-in.`}
      actions={<Button variant="destructive" onClick={() => void run(() => mutate(`users/${resetting.id}/mfa/reset`, 'POST'), 'Two-step verification reset', `${resetting.email} sets it up again at their next sign-in.`)}>{pending ? 'Resetting…' : 'Reset two-step verification'}</Button>}>
      <div className="space-y-3 text-sm"><p>Do this only after confirming who they are outside this app, for example by phone or in person, when they lost their phone and their recovery codes.</p><Notice message={error} error /></div>
    </Dialog>}
  </section>;
}
