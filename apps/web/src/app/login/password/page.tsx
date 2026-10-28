import { redirect } from 'next/navigation';
import { PasswordChangeForm } from '@/features/auth/password-change-form';
import { SignInFrame } from '@/features/auth/sign-in-frame';
import { getIdentity } from '@/lib/auth';
export const metadata = { title: 'Choose a new password' };
export default async function PasswordChangePage() {
  const identity = await getIdentity();
  if (identity) redirect(identity.landingPage);
  return <SignInFrame title="Choose a new password" description="An administrator set your current password. Choose a new one that only you know before you continue."><PasswordChangeForm forced /></SignInFrame>;
}
