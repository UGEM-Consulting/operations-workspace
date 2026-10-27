import { redirect } from 'next/navigation';
import { MfaVerifyForm } from '@/features/auth/mfa-verify-form';
import { SignInFrame } from '@/features/auth/sign-in-frame';
import { getIdentity } from '@/lib/auth';
export const metadata = { title: 'Two-step verification' };
export default async function MfaPage() {
  const identity = await getIdentity();
  if (identity) redirect(identity.landingPage);
  return <SignInFrame title="Two-step verification" description="Enter the 6-digit code from your authenticator app."><MfaVerifyForm /></SignInFrame>;
}
