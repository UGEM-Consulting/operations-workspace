import Link from 'next/link';
import { ArrowLeft, Eye } from 'lucide-react';
import { requireIdentity } from '@/lib/auth';
import { Button } from '@/components/ui/button';
export const metadata = { title: 'Not part of what you can view' };

/** Someone with view-only access opened a page outside it (ViewOnlyNoAccessScreen). The API refuses it whatever the page shows. */
export default async function ViewNoAccessPage() {
  const identity = await requireIdentity();
  const views = identity.navigation.filter(item => item.href.startsWith('/view/'));
  const departments = [...new Set(views.map(item => item.section?.replace(' · view only', '')).filter(Boolean))];
  const reads = departments.map(department => department === 'Dispatch' ? 'Dispatch’s teams, dispatchers and drivers' : 'Safety’s drivers, units and expiring documents').join(' and ');
  const back = views.find(item => item.key === 'viewdispatchers') ?? views[0];
  return <section className="mx-auto grid max-w-xl justify-items-center gap-3 py-16 text-center">
    <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground"><Eye aria-hidden="true" className="size-6" /></span>
    <p className="text-xs font-medium uppercase tracking-[0.04em] text-muted-foreground">View-only access</p>
    <h1 className="text-xl font-semibold">This page isn’t part of what you can view</h1>
    <p className="text-sm leading-6 text-muted-foreground">{reads ? `You can read ${reads}. ` : ''}Applications, IT tasks and personal details stay with the people who work on them. An administrator can tell you more.</p>
    {back && <Button asChild variant="outline"><Link href={back.href}><ArrowLeft aria-hidden="true" className="size-4" />Back to {back.label}</Link></Button>}
  </section>;
}
