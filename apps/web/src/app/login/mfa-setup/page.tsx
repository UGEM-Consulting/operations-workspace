import { redirect } from 'next/navigation';
import { MfaSetup } from '@/features/auth/mfa-setup';
import { SignInShell } from '@/features/auth/sign-in-frame';
import { getIdentity } from '@/lib/auth';
export const metadata = { title: 'Set up two-step verification' };
export default async function MfaSetupPage() {
  const identity = await getIdentity();
  if (identity) redirect(identity.landingPage);
  return <SignInShell wide><MfaSetup signIn /></SignInShell>;
}
