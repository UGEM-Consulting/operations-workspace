import { redirect } from 'next/navigation';
import { BrandWordmark } from '@/components/brand-wordmark';
import { Card } from '@/components/ui/card';
import { ThemeToggle } from '@/components/theme-toggle';
import { LoginForm } from '@/features/auth/login-form';
import { getIdentity } from '@/lib/auth';
import { brand } from '@/lib/brand';
export const metadata = { title: 'Sign in' };
export default async function LoginPage() {
  const identity = await getIdentity();
  if (identity) redirect(identity.landingPage);
  return <main className="flex min-h-dvh flex-col p-5 sm:p-8">
    <header className="flex items-center justify-between gap-4"><BrandWordmark /><ThemeToggle /></header>
    <div className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-12 py-10 lg:grid-cols-2">
      <section className="hidden lg:block" aria-label="About the workspace">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">{brand.companyName}</p>
        <h2 className="mt-5 max-w-md font-display text-6xl font-normal tracking-normal">People. Processes.<br />One workspace.</h2>
        <p className="mt-6 max-w-sm leading-7 text-muted-foreground">A shared home for onboarding and the daily work that keeps your team moving.</p>
        <div className="mt-8 h-1 w-16 bg-brand-orange" aria-hidden="true" />
      </section>
      <Card className="mx-auto w-full max-w-md border-t-4 border-t-brand-orange p-6 sm:p-8">
        <h1 className="font-display text-3xl">Welcome back</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">Sign in to {brand.displayName}.</p><LoginForm />
      </Card>
    </div>
    <footer className="text-center text-xs leading-5 text-muted-foreground">{brand.companyName} · Internal staff workspace</footer>
  </main>;
}
