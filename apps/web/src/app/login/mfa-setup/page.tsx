import { redirect } from 'next/navigation';
import { MfaSetup } from '@/features/auth/mfa-setup';
import { SignInFrame } from '@/features/auth/sign-in-frame';
import { getIdentity } from '@/lib/auth';
export const metadata = { title: 'Set up two-step verification' };
export default async function MfaSetupPage() {
  const identity = await getIdentity();
  if (identity) redirect(identity.landingPage);
  return <SignInFrame title="Set up two-step verification" description="Your account must use an authenticator app before you can open the workspace. This takes about a minute."><MfaSetup /></SignInFrame>;
}
