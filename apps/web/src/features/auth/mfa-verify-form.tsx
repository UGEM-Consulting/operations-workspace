"use client";
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { inputClass } from '@/components/ui/field';
import { mutate } from '@/lib/client-api';
// The API answers a missing or expired half-signed-in session with a bare 401.
export const signInExpired = (message: string) => message === 'Unauthorized' ? 'Your sign-in expired. Sign in again.' : message;
export function MfaVerifyForm() {
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPending(true);
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim();
    try {
      const data = await mutate('auth/mfa/verify', 'POST', { code });
      // After a recovery code, show the remaining codes so the user can replace them.
      window.location.assign(data.recoveryCodesRemaining === undefined ? data.landingPage : '/account/security');
    } catch (error) { setError(signInExpired(error instanceof Error ? error.message : 'Unable to verify the code')); setPending(false); }
  }
  return <form onSubmit={submit} className="mt-7 space-y-5">
    {recovery
      ? <label className="block text-sm font-medium">Recovery code<input key="recovery" name="code" required autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={20} placeholder="XXXXX-XXXXX" className={`${inputClass} font-mono tracking-wider`} /></label>
      : <label className="block text-sm font-medium">Authenticator code<input key="totp" name="code" required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="123456" className={`${inputClass} font-mono text-lg tracking-[.3em]`} /></label>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <Button type="submit" disabled={pending} className="w-full">{pending ? 'Verifying…' : 'Verify and sign in'}</Button>
    <div className="flex flex-wrap justify-between gap-3 text-sm">
      <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => { setRecovery(!recovery); setError(''); }}>{recovery ? 'Use your authenticator app' : 'Use a recovery code'}</button>
      <Link href="/login" className="text-muted-foreground underline-offset-4 hover:underline">Back to sign in</Link>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">Lost your phone and recovery codes? Ask a workspace administrator to reset your two-step verification.</p>
  </form>;
}
