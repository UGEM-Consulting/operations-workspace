import Link from 'next/link';
import { requireIdentity } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { LogoutButton } from '@/features/auth/logout-button';
export default async function AccessDenied() {
  const identity = await requireIdentity();
  return <main className="mx-auto max-w-xl p-10"><h1 className="text-3xl font-normal">Access denied</h1><p className="my-5 text-muted-foreground">Your account does not have permission to open this page. Contact your administrator if you need access.</p><div className="flex gap-3"><Button asChild><Link href={identity.landingPage}>Return to workspace</Link></Button><LogoutButton /></div></main>;
}
