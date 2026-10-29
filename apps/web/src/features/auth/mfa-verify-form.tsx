"use client";
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronLeft, KeyRound, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { mutate } from '@/lib/client-api';
// A missing or expired half-signed-in session is a 401 (a bare "Unauthorized" or the generic ended-session text).
const EXPIRED = new Set(['Unauthorized', 'Your session ended. Sign in again.']);
export const signInExpired = (message: string) => EXPIRED.has(message) ? 'Your sign-in expired. Sign in again.' : message;
/** Leaves a half-finished sign-in; the next attempt starts again from the password. */
export function BackToSignIn() {
  return <Button asChild variant="ghost" className="-ml-2"><Link href="/login"><ChevronLeft aria-hidden="true" className="size-4" />Back to sign in</Link></Button>;
}
export function MfaVerifyForm() {
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState(0);
  // Focus returns to the code once the error is rendered, so the message is read with the field.
  useEffect(() => { if (failures) document.querySelector<HTMLInputElement>('#mfa-code, #mfa-recovery')?.select(); }, [failures]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPending(true);
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim();
    try {
      const data = await mutate('auth/mfa/verify', 'POST', { code });
      // After a recovery code, show the remaining codes so the user can replace them.
      window.location.assign(data.recoveryCodesRemaining === undefined ? data.landingPage : '/account/security');
    } catch (error) { setError(signInExpired(error instanceof Error ? error.message : 'Unable to verify the code')); setPending(false); setFailures(count => count + 1); }
  }
  return <form onSubmit={submit} className="mt-6 space-y-4">
    {recovery
      ? <Input key="recovery" id="mfa-recovery" label="Recovery code" hint="Each recovery code works once." name="code" required autoFocus autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={20} placeholder="XXXXX-XXXXX" width="full" className="[&_input]:font-mono [&_input]:tracking-wider" error={error || undefined} />
      : <Input key="totp" id="mfa-code" label="Authenticator code" hint="The code changes every 30 seconds." name="code" required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="123456" width="full" className="[&_input]:font-mono [&_input]:text-lg [&_input]:tracking-[.3em]" error={error || undefined} />}
    <Button type="submit" size="lg" disabled={pending} className="w-full">{pending ? 'Verifying…' : 'Verify and sign in'}</Button>
    <Button type="button" variant="link" onClick={() => { setRecovery(!recovery); setError(''); }}>{recovery ? <Smartphone aria-hidden="true" className="size-4" /> : <KeyRound aria-hidden="true" className="size-4" />}{recovery ? 'Use your authenticator app instead' : 'Use a recovery code instead'}</Button>
    <hr className="border-border" />
    <p className="text-[13px] leading-5 text-muted-foreground">Lost your phone and your recovery codes? Ask a workspace administrator to reset your two-step verification.</p>
    <BackToSignIn />
  </form>;
}
