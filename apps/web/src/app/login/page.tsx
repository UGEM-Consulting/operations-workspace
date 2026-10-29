import { redirect } from 'next/navigation';
import { LoginForm } from '@/features/auth/login-form';
import { SignInHeading, SignInShell } from '@/features/auth/sign-in-frame';
import { getIdentity } from '@/lib/auth';
import { brand } from '@/lib/brand';
export const metadata = { title: 'Sign in' };
export default async function LoginPage() {
  const identity = await getIdentity();
  if (identity) redirect(identity.landingPage);
  return <SignInShell><SignInHeading title="Sign in" description={`Use your ${brand.companyName} work email.`} /><LoginForm /></SignInShell>;
}
