import Link from 'next/link';
import { apiRequest, requirePage } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import type { ReviewSummary } from '@/features/onboarding/types';
export const metadata = { title: 'Dispatcher onboarding' };
export default async function Page() {
 await requirePage('onboarding');const response=await apiRequest('onboarding/summary');
 if(!response.ok)throw new Error('Unable to load onboarding overview');
 const summary:ReviewSummary=await response.json();
 return <div className="space-y-6"><h1 className="text-2xl font-semibold">Dispatcher onboarding</h1><p className="text-muted-foreground">Your review inbox. Counts cover all applications in your authorized scope.</p>
 <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{[['Awaiting review',summary.awaitingReview,'AWAITING_REVIEW'],['Changes requested',summary.changesRequested,'CHANGES_REQUESTED'],['Resubmitted',summary.resubmitted,'RESUBMITTED'],['Approved',summary.approved,'APPROVED'],['Rejected',summary.rejected,'REJECTED']].map(([label,count,status])=><Link key={label} href={`/onboarding/applications?status=${status}`}><Card className="h-full p-5 transition-colors hover:bg-accent"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-3 text-3xl font-semibold">{count}</p></Card></Link>)}</div>
 <p className="text-sm text-muted-foreground">Awaiting review includes new submissions and resubmissions. Approved records are ready for the future IT queue; no provisioning tasks are created yet.</p>
 <div className="flex flex-wrap gap-4"><Link href="/onboarding/invitations" className="rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground">Manage invitations</Link><Link href="/onboarding/applications" className="rounded-lg border border-border px-4 py-3 text-sm font-medium">Review applications</Link></div></div>;
}
