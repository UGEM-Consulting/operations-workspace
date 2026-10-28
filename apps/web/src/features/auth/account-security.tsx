"use client";
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { mutate } from '@/lib/client-api';
import { MfaSetup, RecoveryCodes } from './mfa-setup';
import { PasswordChangeForm } from './password-change-form';
export interface MfaStatus { enabled: boolean; required: boolean; policy: string; enabledAt: string | null; recoveryCodesRemaining: number }

// Recovery codes look like XXXXX-XXXXX, so forms that accept them use a text keyboard.
function CodeForm({ label, action, pendingLabel, variant, recovery = false, onSubmit }: { label: string; action: string; pendingLabel: string; variant?: 'destructive'; recovery?: boolean; onSubmit: (code: string) => Promise<void> }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPending(true);
    try { await onSubmit(String(new FormData(event.currentTarget).get('code') ?? '').trim()); }
    catch (error) { setError(error instanceof Error ? error.message : 'Request failed'); }
    finally { setPending(false); }
  }
  return <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
    <Input label={label} name="code" required inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" pattern={recovery ? '[0-9A-Za-z-]{6,11}' : '[0-9]{6}'} maxLength={recovery ? 11 : 6} placeholder={recovery ? '123456 or ABCDE-23456' : '123456'} width={recovery ? 'md' : 'sm'} error={error || undefined} />
    <Button type="submit" variant={variant ?? 'outline'} disabled={pending}>{pending ? pendingLabel : action}</Button>
  </form>;
}

/** Own password: other sessions end, this one continues. */
export function PasswordSettings({ account }: { account: string }) {
  return <Card className="mt-8 max-w-2xl space-y-5 p-6">
    <div>
      <h2 className="text-lg font-semibold">Password</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">Changing your password signs you out everywhere else.</p>
    </div>
    <PasswordChangeForm account={account} />
  </Card>;
}

export function AccountSecurity({ status }: { status: MfaStatus }) {
  const router = useRouter();
  const [settingUp, setSettingUp] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  // Turning MFA on or off regenerates this session; a full navigation discards the old router cache.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  const reload = () => window.location.assign('/account/security');
  if (codes) return <Card className="mt-8 max-w-2xl p-6"><h2 className="mb-4 text-lg font-semibold">New recovery codes</h2><RecoveryCodes codes={codes} doneLabel="Done" onDone={() => { setCodes(null); router.refresh(); }} /></Card>;
  return <Card className="mt-8 max-w-2xl space-y-6 p-6">
    <div>
      <h2 className="text-lg font-semibold">Two-step verification</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">After your password, sign-in asks for a code from an authenticator app on your phone.{status.required && ' Your role requires it.'}</p>
    </div>
    {status.enabled ? <>
      <p className="flex flex-wrap items-center gap-3 text-sm"><Badge label="On" tone="success" />{status.enabledAt && <span className="text-muted-foreground">since <LocalTime iso={status.enabledAt} format="date"/></span>}</p>
      <div className="space-y-3 border-t pt-5">
        <h3 className="font-medium">Recovery codes</h3>
        <p className={`text-sm ${status.recoveryCodesRemaining <= 3 ? 'text-warning' : 'text-muted-foreground'}`}>{status.recoveryCodesRemaining} of 10 unused.{status.recoveryCodesRemaining <= 3 && ' Make new codes soon.'} Making new codes cancels the old ones.</p>
        <CodeForm label="Authenticator code" action="Make new codes" pendingLabel="Making codes…" onSubmit={async code => setCodes((await mutate('auth/mfa/recovery-codes', 'POST', { code })).recoveryCodes)} />
      </div>
      {!status.required && <div className="space-y-3 border-t pt-5">
        <h3 className="font-medium">Turn off</h3>
        <p className="text-sm text-muted-foreground">Your other signed-in sessions will end. You can enter a recovery code instead of an authenticator code.</p>
        <CodeForm recovery label="Authenticator or recovery code" action="Turn off two-step verification" pendingLabel="Turning off…" variant="destructive" onSubmit={async code => { await mutate('auth/mfa/disable', 'POST', { code }); reload(); }} />
      </div>}
    </> : settingUp
      ? <MfaSetup doneLabel="Done" onComplete={reload} />
      : <div className="space-y-3"><p className="text-sm"><Badge label="Off" /></p><p className="text-sm text-muted-foreground">Turning it on ends your other signed-in sessions.</p><Button onClick={() => setSettingUp(true)}>Set up two-step verification</Button></div>}
  </Card>;
}
