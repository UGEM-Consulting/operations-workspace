"use client";
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, KeyRound, Mail, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { ApiError, errorMessage, mutate } from '@/lib/client-api';
import { ResendCode, type EmailCodeSent } from './email-code';
import { SignInHeading } from './sign-in-frame';
// A missing or expired half-signed-in session is a 401 (a bare "Unauthorized" or the generic ended-session text).
const EXPIRED = new Set(['Unauthorized', 'Your session ended. Sign in again.']);
export const signInExpired = (message: string) => EXPIRED.has(message) ? 'Your sign-in expired. Sign in again.' : message;
/** Leaves a half-finished sign-in; the next attempt starts again from the password. */
export function BackToSignIn() {
  return <Button asChild variant="ghost" className="-ml-2"><Link href="/login"><ChevronLeft aria-hidden="true" className="size-4" />Back to sign in</Link></Button>;
}
type Challenge = { method: 'TOTP' } | ({ method: 'EMAIL' } & EmailCodeSent);

/**
 * The second sign-in step. The API names the method: an authenticator code, or an emailed code it sends on the first
 * request (a reload within the resend wait sends nothing new). A recovery code works with either.
 */
export function MfaVerifyForm() {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [sentAt, setSentAt] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [resending, setResending] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState(0);
  const started = useRef(false);
  async function load(resend = false) {
    setLoadError(''); setResending(resend);
    try { setChallenge(await mutate<Challenge>('auth/mfa/challenge', 'POST', resend ? { resend: true } : {})); setSentAt(Date.now()); }
    catch (error) {
      // An API older than email codes has no challenge route: its users all have authenticator apps.
      if (error instanceof ApiError && error.status === 404) setChallenge({ method: 'TOTP' });
      else setLoadError(signInExpired(errorMessage(error, 'The code could not be sent.')));
    }
    finally { setResending(false); }
  }
  useEffect(() => { if (!started.current) { started.current = true; void load(); } }, []);
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
  const email = challenge?.method === 'EMAIL' ? challenge : null;
  const heading = recovery
    ? <SignInHeading icon={KeyRound} title="Two-step verification" description="Enter one of the recovery codes you saved when you set up two-step verification." />
    : email ? <SignInHeading icon={Mail} title="Check your email" description={<>We emailed a 6-digit code to <span className="font-medium text-foreground">{email.sentTo}</span>. It expires in 10 minutes.</>} />
    : challenge ? <SignInHeading icon={Smartphone} title="Two-step verification" description="Enter the 6-digit code from the authenticator app on your phone." />
    : <SignInHeading title="Two-step verification" description="Enter the code that proves it’s you." />;
  const ready = challenge || recovery;
  return <>{heading}<form onSubmit={submit} className="mt-6 space-y-4">
    {loadError && <p role="alert" className="text-sm text-danger">{loadError}{' '}<Button type="button" variant="link" onClick={() => void load(true)}>Try again</Button></p>}
    {!ready && !loadError && <p role="status" className="text-sm text-muted-foreground">Getting your sign-in code ready…</p>}
    {recovery
      ? <Input key="recovery" id="mfa-recovery" label="Recovery code" hint="Each recovery code works once." name="code" required autoFocus autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={20} placeholder="XXXXX-XXXXX" width="full" className="[&_input]:font-mono [&_input]:tracking-wider" error={error || undefined} />
      : challenge && <Input key={challenge.method} id="mfa-code" label={email ? 'Email code' : 'Authenticator code'} hint={email ? undefined : 'The code changes every 30 seconds.'} name="code" required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="123456" width="full" className="[&_input]:font-mono [&_input]:text-lg [&_input]:tracking-[.3em]" error={error || undefined} />}
    {email && !recovery && <ResendCode sent={email} sentAt={sentAt} pending={resending} onResend={() => void load(true)} />}
    {ready && <Button type="submit" size="lg" disabled={pending} className="w-full">{pending ? 'Verifying…' : 'Verify and sign in'}</Button>}
    <Button type="button" variant="link" onClick={() => { setRecovery(!recovery); setError(''); }}>
      {recovery ? (email ? <Mail aria-hidden="true" className="size-4" /> : <Smartphone aria-hidden="true" className="size-4" />) : <KeyRound aria-hidden="true" className="size-4" />}
      {recovery ? (email ? 'Use the emailed code instead' : 'Use your authenticator app instead') : 'Use a recovery code instead'}
    </Button>
    <hr className="border-border" />
    <p className="text-[13px] leading-5 text-muted-foreground">{email ? 'Can’t get into your email and lost your recovery codes?' : 'Lost your phone and your recovery codes?'} Ask a workspace administrator to reset your two-step verification.</p>
    <BackToSignIn />
  </form></>;
}
