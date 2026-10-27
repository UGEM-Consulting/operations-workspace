"use client";
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { mutate } from '@/lib/client-api';
export function LoginForm() {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const data = await mutate('auth/login', 'POST', { email: form.get('email'), password: form.get('password') });
      window.location.assign(data.landingPage);
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to sign in'); setPending(false); }
  }
  return <form onSubmit={submit} className="mt-7 space-y-5"><label className="block text-sm font-medium">Email<input name="email" type="email" autoComplete="username" required maxLength={254} className="mt-2 w-full rounded-lg border bg-background px-3 py-2.5" /></label><label className="block text-sm font-medium">Password<input name="password" type="password" autoComplete="current-password" required maxLength={128} className="mt-2 w-full rounded-lg border bg-background px-3 py-2.5" /></label>{error && <p role="alert" className="text-sm text-danger">{error}</p>}<Button type="submit" disabled={pending} className="w-full">{pending ? 'Signing in…' : 'Sign in'}</Button><p className="text-xs leading-5 text-muted-foreground">Internal staff access only. Contact your administrator for an account.</p></form>;
}
