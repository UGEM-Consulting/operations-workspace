"use client";
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { inputClass } from '@/components/ui/field';
import { mutate } from '@/lib/client-api';
import { MfaSetup, RecoveryCodes } from './mfa-setup';
export interface MfaStatus { enabled: boolean; required: boolean; policy: string; enabledAt: string | null; recoveryCodesRemaining: number }

function CodeForm({ label, action, pendingLabel, variant, onSubmit }: { label: string; action: string; pendingLabel: string; variant?: 'destructive'; onSubmit: (code: string) => Promise<void> }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPending(true);
    try { await onSubmit(String(new FormData(event.currentTarget).get('code') ?? '').trim()); }
    catch (error) { setError(error instanceof Error ? error.message : 'Request failed'); }
    finally { setPending(false); }
  }
  return <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
    <label className="text-sm">{label}<input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="123456" className={`${inputClass} w-40 font-mono tracking-[.2em]`} /></label>
    <Button type="submit" variant={variant ?? 'outline'} disabled={pending}>{pending ? pendingLabel : action}</Button>
    {error && <p role="alert" className="w-full text-sm text-danger">{error}</p>}
  </form>;
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
      <p className="text-sm"><span className="rounded-full bg-success-background px-3 py-1 font-medium text-success">On</span>{status.enabledAt && <span className="ml-3 text-muted-foreground">since {new Date(status.enabledAt).toLocaleDateString()}</span>}</p>
      <div className="space-y-3 border-t pt-5">
        <h3 className="font-medium">Recovery codes</h3>
        <p className={`text-sm ${status.recoveryCodesRemaining <= 3 ? 'text-warning' : 'text-muted-foreground'}`}>{status.recoveryCodesRemaining} of 10 unused.{status.recoveryCodesRemaining <= 3 && ' Generate new codes soon.'} Generating new codes cancels the old ones.</p>
        <CodeForm label="Authenticator code" action="Generate new codes" pendingLabel="Generating…" onSubmit={async code => setCodes((await mutate('auth/mfa/recovery-codes', 'POST', { code })).recoveryCodes)} />
      </div>
      {!status.required && <div className="space-y-3 border-t pt-5">
        <h3 className="font-medium">Turn off</h3>
        <p className="text-sm text-muted-foreground">Your other signed-in sessions will end. You can enter a recovery code instead of an authenticator code.</p>
        <CodeForm label="Code" action="Turn off two-step verification" pendingLabel="Turning off…" variant="destructive" onSubmit={async code => { await mutate('auth/mfa/disable', 'POST', { code }); reload(); }} />
      </div>}
    </> : settingUp
      ? <MfaSetup doneLabel="Done" onComplete={reload} />
      : <div className="space-y-3"><p className="text-sm"><span className="rounded-full bg-muted px-3 py-1 font-medium">Off</span></p><p className="text-sm text-muted-foreground">Turning it on ends your other signed-in sessions.</p><Button onClick={() => setSettingUp(true)}>Set up two-step verification</Button></div>}
  </Card>;
}
