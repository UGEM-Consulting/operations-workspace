import { Suspense } from 'react';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { requirePage } from '@/lib/auth';
import { PageHeader, PanelLoading } from '@/components/workspace-ui';
import { Button } from '@/components/ui/button';
import { ReviewWork, ItWork } from '@/features/dashboard/work-queues';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Overview' };
export default async function Dashboard() {
  const identity = await requirePage('dashboard');
  const has = (key: string) => identity.navigation.some(item => item.key === key);
  const primary = identity.navigation.find(item => item.key === 'applications') ?? identity.navigation.find(item => item.key === 'it') ?? identity.navigation.find(item => item.key !== 'dashboard');
  return <div className="space-y-7">
    <PageHeader eyebrow="Your operations, connected" title="Workspace overview" description={`Welcome back, ${identity.user.firstName}. Review what needs attention and keep your team moving forward.`} />
    <section className="flex flex-wrap items-center justify-between gap-5 rounded-lg bg-sidebar px-6 py-6 text-white sm:px-7"><div className="flex items-start gap-4"><span aria-hidden="true" className="mt-1 h-12 w-1 shrink-0 rounded-full bg-brand-orange" /><div><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-sidebar-accent">Your next steps</p><h2 className="mt-2 text-lg font-semibold">Continue your next task</h2><p className="mt-2 max-w-lg text-xs leading-6 text-sidebar-foreground">{has('applications') ? 'Review submitted applications, confirm assignments, and follow IT completion updates.' : 'Review approved onboarding requests and keep each setup checklist moving.'}</p></div></div>{primary && <Button asChild className="bg-brand-orange text-brand-ink hover:bg-brand-orange/85"><Link href={primary.href}>Go to {primary.label} <ArrowRight aria-hidden="true" className="size-4" /></Link></Button>}</section>
    {has('applications') && <Suspense fallback={<PanelLoading />}><ReviewWork /></Suspense>}
    {has('it') && <Suspense fallback={<PanelLoading />}><ItWork /></Suspense>}
    <section aria-labelledby="workspace-shortcuts"><h2 id="workspace-shortcuts" className="mb-4 text-lg font-semibold">Your workspace</h2><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{identity.navigation.filter(item => item.key !== 'dashboard').map(item => <Link key={item.key} href={item.href} className="flex items-center justify-between gap-3 rounded-md border bg-card p-5 text-sm font-medium transition-colors hover:border-primary/50 hover:bg-accent">{item.label}<ArrowUpRight aria-hidden="true" className="size-4 text-primary" /></Link>)}</div></section>
  </div>;
}
