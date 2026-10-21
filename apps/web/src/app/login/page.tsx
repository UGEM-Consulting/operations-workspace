import { redirect } from 'next/navigation';
import { Truck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { ThemeToggle } from '@/components/theme-toggle';
import { LoginForm } from '@/features/auth/login-form';
import { getIdentity } from '@/lib/auth';
export const metadata = { title: 'Sign in' };
export default async function LoginPage() {
  const identity = await getIdentity();
  if (identity) redirect(identity.landingPage);
  return <main className="flex min-h-screen items-center justify-center p-5"><div className="absolute right-6 top-6"><ThemeToggle /></div><Card className="w-full max-w-md p-8"><Truck className="size-9 text-primary" /><p className="mt-5 text-xs font-semibold tracking-widest text-primary">OPERATIONS WORKSPACE</p><h1 className="mt-3 text-2xl font-semibold">Welcome back</h1><p className="mt-2 text-sm text-muted-foreground">Sign in to your internal workspace.</p><LoginForm /></Card></main>;
}
