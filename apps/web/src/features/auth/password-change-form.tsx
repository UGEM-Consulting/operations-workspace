"use client";
import { useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/alert';
import { mutate } from '@/lib/client-api';
import { signInExpired } from './mfa-verify-form';
type FieldName = 'currentPassword' | 'newPassword' | 'confirmPassword';
const RULE = 'Use 12–128 characters. A passphrase of several unrelated words works well.';

/**
 * Own password change. `forced`: the step after signing in with an administrator-set password, which then continues
 * to two-step verification or the workspace. Otherwise the Account security form; other sessions end and this one stays.
 */
export function PasswordChangeForm({ forced = false, account }: { forced?: boolean; account?: string }) {
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [notice, setNotice] = useState<{ message: string; error: boolean }>({ message: '', error: false });
  const [pending, setPending] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  function fail(field: FieldName | null, message: string) {
    // Focus after the error renders, so the message is read with the field.
    if (field) { setErrors({ [field]: message }); setTimeout(() => form.current?.querySelector<HTMLInputElement>(`[name="${field}"]`)?.focus(), 0); }
    else setNotice({ message, error: true });
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setErrors({}); setNotice({ message: '', error: false });
    const data = new FormData(event.currentTarget);
    const [currentPassword, newPassword, confirmPassword] = (['currentPassword', 'newPassword', 'confirmPassword'] as const).map(name => String(data.get(name) ?? ''));
    if (newPassword.length < 12 || newPassword.length > 128) return fail('newPassword', RULE);
    if (newPassword === currentPassword) return fail('newPassword', 'Choose a new password that differs from your current one.');
    if (newPassword !== confirmPassword) return fail('confirmPassword', 'The passwords do not match.');
    setPending(true);
    try {
      const result = await mutate<{ landingPage: string }>('auth/password', 'POST', { currentPassword, newPassword });
      // A full navigation picks up the regenerated session cookie for the next sign-in step.
      if (forced) { window.location.assign(result.landingPage); return; }
      form.current?.reset();
      setNotice({ message: 'Password changed. Your other signed-in sessions have ended.', error: false });
    } catch (error) {
      const message = signInExpired(error instanceof Error ? error.message : 'Unable to change the password');
      fail(/current password/i.test(message) ? 'currentPassword' : /differs|characters/i.test(message) ? 'newPassword' : null, message);
    } finally { setPending(false); }
  }
  return <form ref={form} onSubmit={submit} noValidate className={forced ? 'mt-7 space-y-5' : 'space-y-4'}>
    {/* Lets password managers file the new password under the right account. */}
    {account && <input type="text" name="username" autoComplete="username" value={account} readOnly hidden />}
    <Input label="Current password" name="currentPassword" type="password" autoComplete="current-password" required autoFocus={forced} maxLength={128} width={forced ? 'full' : 'md'}
      hint={forced ? 'The password you just signed in with.' : undefined} error={errors.currentPassword} />
    <Input label="New password" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} width={forced ? 'full' : 'md'} hint={RULE} error={errors.newPassword} />
    <Input label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" required maxLength={128} width={forced ? 'full' : 'md'} error={errors.confirmPassword} />
    <Notice message={notice.message} error={notice.error} />
    <Button type="submit" disabled={pending} className={forced ? 'w-full' : undefined}>{pending ? 'Changing password…' : forced ? 'Change password and continue' : 'Change password'}</Button>
    {forced && <p className="text-sm"><Link href="/login" className="text-muted-foreground underline-offset-4 hover:underline">Back to sign in</Link></p>}
  </form>;
}
