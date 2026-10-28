"use client";
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { mutate } from '@/lib/client-api';
export function LoginForm() {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState(0);
  const password = useRef<HTMLInputElement>(null);
  // After the error is rendered, so the field's description (the message) is read when it gains focus.
  useEffect(() => { if (failures) { password.current?.select(); password.current?.focus(); } }, [failures]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      // The API names the next page: the workspace, a required password change, or the authenticator step.
      const data = await mutate<{ landingPage: string }>('auth/login', 'POST', { email: form.get('email'), password: form.get('password') });
      window.location.assign(data.landingPage);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to sign in'); setPending(false); setFailures(count => count + 1);
    }
  }
  // The credentials message belongs to both fields; it is shown once, under the password.
  return <form onSubmit={submit} className="mt-7 space-y-5">
    <Input label="Email" name="email" type="email" autoComplete="username" required autoFocus maxLength={254} width="full" aria-invalid={error ? true : undefined} />
    <Input ref={password} label="Password" name="password" type="password" autoComplete="current-password" required maxLength={128} width="full" error={error || undefined} />
    <Button type="submit" disabled={pending} className="w-full">{pending ? 'Signing in…' : 'Sign in'}</Button>
    <p className="text-xs leading-5 text-muted-foreground">Internal staff access only. Contact your administrator for an account.</p>
  </form>;
}
