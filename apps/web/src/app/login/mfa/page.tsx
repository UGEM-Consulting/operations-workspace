import { redirect } from 'next/navigation';
import { MfaVerifyForm } from '@/features/auth/mfa-verify-form';
import { SignInShell } from '@/features/auth/sign-in-frame';
import { getIdentity } from '@/lib/auth';
export const metadata = { title: 'Two-step verification' };
export default async function MfaPage() {
  const identity = await getIdentity();
  if (identity) redirect(identity.landingPage);
  // The form names the method (authenticator, emailed code or recovery code) once the API says which applies.
  return <SignInShell wide><MfaVerifyForm /></SignInShell>;
}
