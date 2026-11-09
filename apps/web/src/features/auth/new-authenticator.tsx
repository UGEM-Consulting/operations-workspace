"use client";
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { ApiError, errorMessage, mutate } from '@/lib/client-api';

interface Replacement { qrCode: string; uri: string; manualKey: string; issuer: string; account: string; replacementId: string }

/**
 * Set up a new authenticator while two-step verification stays on (designed as NewAuthenticatorAccountScreen and
 * NewAuthenticatorSetupScreen). First a code from the current authenticator or a recovery code, unless the person just
 * signed in with a recovery code (afterRecovery: the API allows that once, for a short while); then the new QR code.
 * The old authenticator keeps working until the new one's first code is accepted, which signs other sessions out.
 */
export function NewAuthenticatorDialog({ afterRecovery = false, onClose }: { afterRecovery?: boolean; onClose: () => void }) {
  const [started, setStarted] = useState<Replacement | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  // Without the shortcut (it ran out, or was used), ask for a code.
  const [needCode, setNeedCode] = useState(!afterRecovery);
  // An older API has no such route (the web may deploy first): say so instead of asking for a code that can't work.
  const [unavailable, setUnavailable] = useState(false);
  const tried = useRef(false);
  async function begin(code?: string) {
    setPending(true); setError('');
    try { setStarted(await mutate<Replacement>('auth/mfa/replacement', 'POST', code ? { code } : {})); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) { setUnavailable(true); return; }
      if (code) setError(errorMessage(failure, 'The code wasn’t accepted.')); setNeedCode(true);
    }
    finally { setPending(false); }
  }
  useEffect(() => { if (afterRecovery && !tried.current) { tried.current = true; void begin(); } }, [afterRecovery]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim();
    if (!started) { await begin(code); return; }
    setPending(true); setError('');
    try {
      // Names the setup whose QR code is shown, so one started again elsewhere is refused instead of failing as a wrong code.
      await mutate('auth/mfa/replacement/confirm', 'POST', { code, replacementId: started.replacementId });
      // The session was regenerated: a full navigation drops the old router cache.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/account/security');
    } catch (failure) { setError(errorMessage(failure, 'The code wasn’t accepted.')); setPending(false); }
  }
  if (unavailable) return <Dialog open size="sm" onClose={onClose} title="Not available yet" closeLabel="Close">
    <p className="text-sm text-muted-foreground">Setting up a new authenticator arrives with the next workspace update. Until then, an administrator can reset your two-step verification.</p>
  </Dialog>;
  if (!started) return <Dialog open size="sm" onClose={onClose} busy={pending} protectChanges={false} title="Set up a new authenticator?"
    description="First confirm it’s you. Use a recovery code if you no longer have the old one."
    actions={needCode ? <Button type="submit" form="new-authenticator" disabled={pending}>{pending ? 'Checking…' : 'Continue'}</Button> : undefined}>
    {needCode ? <form id="new-authenticator" onSubmit={submit}>
      <Input label="Code from your authenticator or a recovery code" name="code" required autoFocus autoComplete="one-time-code" pattern="[0-9A-Za-z-]{6,11}" maxLength={11}
        placeholder="123456 or ABCDE-23456" hint="A recovery code is used up, like at sign-in." width="sm" className="[&_input]:font-mono [&_input]:tracking-wider" error={error || undefined} />
    </form> : <p role="status" className="text-sm text-muted-foreground">Getting a new code ready…</p>}
  </Dialog>;
  return <Dialog open size="lg" onClose={onClose} busy={pending} protectChanges={false} title="Set up a new authenticator"
    description="Scan the code with your authenticator app, then enter the code it shows. Until you do, your old one keeps working."
    actions={<Button type="submit" form="new-authenticator" disabled={pending}>{pending ? 'Checking…' : 'Use the new authenticator'}</Button>}>
    <form id="new-authenticator" onSubmit={submit} className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL the API made for this setup */}
        <img src={started.qrCode} alt={`QR code to add ${started.account} to your authenticator app`} width={168} height={168} className="size-42 shrink-0 rounded-md border border-border bg-white p-2 max-sm:mx-auto" />
        <div className="min-w-0 space-y-3">
          <p className="text-[13px] text-muted-foreground">Can’t scan? In the app choose “Enter a setup key” and type this key.</p>
          <div><p className="text-sm font-medium">Setup key</p><code className="mt-1 block break-all rounded-sm border border-border bg-muted px-3 py-2 font-mono text-[15px] tracking-wider">{started.manualKey}</code></div>
          <div className="flex flex-wrap items-center gap-3"><CopyButton text={started.manualKey.replace(/\s+/g, '')} label="Copy key" /><a href={started.uri} className="text-sm text-primary underline-offset-4 hover:underline sm:hidden">Open in authenticator app</a></div>
          <p className="text-[13px] text-muted-foreground">Account: {started.account} · time-based</p>
        </div>
      </div>
      <Input key="new-code" label="6-digit code from the new authenticator" name="code" required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="123456"
        width="sm" className="[&_input]:font-mono [&_input]:tracking-wider" error={error || undefined} />
      <p className="text-[13px] text-muted-foreground">Your recovery codes stay the same. Other signed-in sessions end, as when you turned it on.</p>
    </form>
  </Dialog>;
}
