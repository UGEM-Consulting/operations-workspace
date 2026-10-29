import { Suspense } from 'react';
import { requirePage } from '@/lib/auth';
import { PageLoading } from '@/components/workspace-ui';
import { ReviewWork, ItWork } from '@/features/dashboard/work-queues';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Overview' };
/** Home for every staff member: managers see their review work and IT updates; IT sees setup requests; admins see both. */
export default async function Dashboard() {
  const identity = await requirePage('dashboard');
  const has = (key: string) => identity.navigation.some(item => item.key === key);
  const reviews = has('applications'), it = has('it');
  return <div className="space-y-10">
    {reviews && <Suspense fallback={<PageLoading label="Loading applications…" />}><ReviewWork firstName={identity.user.firstName} /></Suspense>}
    {it && <Suspense fallback={<PageLoading label="Loading IT setup…" header={!reviews} />}><ItWork heading={reviews ? 'h2' : 'h1'} /></Suspense>}
    {!reviews && !it && <div><h1 className="font-sans text-[22px] font-semibold leading-[30px] tracking-[-0.01em]">Welcome back, {identity.user.firstName}</h1><p className="mt-1 text-sm leading-6 text-muted-foreground">Your workspace pages are in the menu.</p></div>}
  </div>;
}
