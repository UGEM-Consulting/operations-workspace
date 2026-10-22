import { ManagerNotifications } from '@/features/it/notifications';
import Link from 'next/link';
import { apiRequest, requirePage } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/workspace-ui';
import type { ReviewSummary } from '@/features/onboarding/types';
export const metadata = { title: 'Dispatcher onboarding' };
export default async function Page() {
 await requirePage('onboarding');const response=await apiRequest('onboarding/summary');
 if(!response.ok)throw new Error('Unable to load onboarding overview');
 const summary:ReviewSummary=await response.json();
 const notices=await apiRequest('notifications');if(!notices.ok)throw new Error('Unable to load notifications');const notifications=await notices.json();
 return <div className="space-y-7"><PageHeader eyebrow="People & onboarding" title="Dispatcher onboarding" description="Your dispatcher review inbox. Counts cover all applications in your authorized scope." />
 <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{[['Awaiting review',summary.awaitingReview,'AWAITING_REVIEW'],['Changes requested',summary.changesRequested,'CHANGES_REQUESTED'],['Resubmitted',summary.resubmitted,'RESUBMITTED'],['Approved',summary.approved,'APPROVED'],['Rejected',summary.rejected,'REJECTED']].map(([label,count,status])=><Link key={label} href={`/onboarding/applications?status=${status}`}><Card className="h-full p-5 transition-colors hover:bg-accent"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-3 text-3xl font-semibold">{count}</p></Card></Link>)}</div>
 <p className="text-sm text-muted-foreground">Awaiting review includes new submissions and resubmissions. New approvals automatically create an IT setup checklist. Completion updates appear below.</p>
 <ManagerNotifications initial={notifications}/>
 <div className="flex flex-wrap gap-4"><Button asChild><Link href="/onboarding/invitations">Manage invitations</Link></Button><Button asChild variant="outline"><Link href="/onboarding/applications">Review applications</Link></Button></div></div>;
}
