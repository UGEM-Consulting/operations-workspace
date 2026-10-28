import { redirect } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { LoginForm } from '@/features/auth/login-form';
import { SignInShell } from '@/features/auth/sign-in-frame';
import { getIdentity } from '@/lib/auth';
import { brand } from '@/lib/brand';
export const metadata = { title: 'Sign in' };
export default async function LoginPage() {
  const identity = await getIdentity();
  if (identity) redirect(identity.landingPage);
  // The sign-in card comes first in the document so its h1 is the first heading; the tagline is placed beside it visually.
  return <SignInShell className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-12 py-10 lg:grid-cols-2">
    <Card className="mx-auto w-full max-w-md border-t-4 border-t-brand-orange p-6 sm:p-8 lg:order-2">
      <h1 className="font-display text-3xl">Welcome back</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">Sign in to {brand.displayName}.</p><LoginForm />
    </Card>
    <section className="hidden lg:order-1 lg:block" aria-label="About the workspace">
      <p className="text-xs font-semibold uppercase tracking-widest text-primary">{brand.companyName}</p>
      <p className="mt-5 max-w-md font-display text-6xl font-normal tracking-normal">People. Processes.<br />One workspace.</p>
      <p className="mt-6 max-w-sm leading-7 text-muted-foreground">A shared home for onboarding and the daily work that keeps your team moving.</p>
      <div className="mt-8 h-1 w-16 bg-brand-orange" aria-hidden="true" />
    </section>
  </SignInShell>;
}
