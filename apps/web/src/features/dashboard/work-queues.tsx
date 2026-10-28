import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { apiRequest } from '@/lib/auth';
import { EmptyState, StatCard } from '@/components/workspace-ui';
import { StatusBadge } from '@/components/ui/status-badge';
import type { ApplicationList, ReviewSummary } from '@/features/onboarding/types';
import { type ItQueue, type Notifications } from '@/features/it/types';
import { ManagerNotifications } from '@/features/it/notifications';

async function read<T>(path: string): Promise<T> {
  const response = await apiRequest(path);
  if (!response.ok) throw new Error('Workspace data unavailable');
  return response.json() as Promise<T>;
}
function Unavailable({ title, href }: { title: string; href: string }) {
  return <div className="rounded-lg border bg-card p-6"><h2 className="font-semibold">{title}</h2><p className="mt-2 text-sm text-muted-foreground">This information could not be loaded. Please try again.</p><Link href={href} className="mt-4 inline-block text-sm font-medium text-primary underline">Open workspace</Link></div>;
}
export async function ReviewWork() {
  const [summary, queue, notifications] = await Promise.allSettled([
    read<ReviewSummary>('onboarding/summary'),
    read<ApplicationList>('onboarding/review-queue?status=AWAITING_REVIEW&pageSize=5&sort=submittedAt&direction=ASC'),
    read<Notifications>('notifications'),
  ]);
  return <div className="space-y-6">
    {summary.status === 'fulfilled' ? <section aria-label="Application summary" className="grid grid-cols-2 gap-3 xl:grid-cols-4 sm:gap-4">{[
      ['Awaiting review', summary.value.awaitingReview, 'New submissions and resubmissions', 'AWAITING_REVIEW'],
      ['Changes requested', summary.value.changesRequested, 'Waiting for applicant updates', 'CHANGES_REQUESTED'],
      ['Approved', summary.value.approved, 'Final review decisions', 'APPROVED'],
      ['Resubmitted', summary.value.resubmitted, 'Included in awaiting review', 'RESUBMITTED'],
    ].map(([label,value,detail,status]) => <StatCard key={label} label={String(label)} value={Number(value)} detail={String(detail)} href={`/onboarding/applications?status=${status}`} />)}</section> : <Unavailable title="Application summary unavailable" href="/onboarding" />}
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <section className="overflow-hidden rounded-lg border bg-card"><div className="flex flex-wrap items-center justify-between gap-3 p-6"><div><h2 className="font-semibold">Ready for your review</h2><p className="mt-1 text-xs text-muted-foreground">Oldest submissions first · Up to 5 applications</p></div><Link href="/onboarding/applications?status=AWAITING_REVIEW" className="text-xs font-semibold text-primary hover:underline">View all</Link></div>
        {queue.status === 'rejected' ? <Unavailable title="Review queue unavailable" href="/onboarding/applications" /> : queue.value.items.length ? <ul>{queue.value.items.map(item => <li key={item.id} className="border-t"><Link href={`/onboarding/applications/${item.id}`} className="flex flex-wrap items-center justify-between gap-4 px-6 py-5 transition-colors hover:bg-muted/40"><div className="min-w-0"><p className="break-words text-sm font-semibold">{[item.fields.firstName,item.fields.lastName].filter(Boolean).join(' ') || 'Application'}</p><p className="mt-1 text-xs text-muted-foreground">{item.mcName || 'Employment awaiting confirmation'}</p></div><div className="flex items-center gap-3"><StatusBadge status={item.status} /><ArrowUpRight aria-hidden="true" className="size-4 text-primary" /></div></Link></li>)}</ul> : <EmptyState title="Your review queue is clear" description="New submissions and resubmissions will appear here when they are ready for your decision." />}
      </section>
      {notifications.status === 'fulfilled' ? <ManagerNotifications initial={notifications.value} /> : <Unavailable title="Completion updates unavailable" href="/onboarding" />}
    </div>
  </div>;
}
export async function ItWork() {
  const result = await Promise.allSettled(['PENDING','IN_PROGRESS','BLOCKED','COMPLETED'].map(status => read<ItQueue>(`it/onboarding?status=${status}&pageSize=3`)));
  const labels = ['Pending setup','In progress','Blocked','Completed'];
  const statuses = ['PENDING','IN_PROGRESS','BLOCKED','COMPLETED'];
  return <section aria-labelledby="it-overview-title" className="space-y-5"><div><h2 id="it-overview-title" className="text-lg font-semibold">IT onboarding</h2><p className="mt-1 text-sm text-muted-foreground">Approved dispatchers and the next steps in their setup.</p></div><div className="grid grid-cols-2 gap-3 xl:grid-cols-4 sm:gap-4">{result.map((entry,index) => entry.status === 'fulfilled' ? <StatCard key={statuses[index]} label={labels[index]} value={entry.value.total} detail="Onboarding requests" href={`/it/tasks?status=${statuses[index]}`} /> : <Unavailable key={statuses[index]} title={`${labels[index]} unavailable`} href="/it/tasks" />)}</div>
    <div className="grid items-start gap-4 xl:grid-cols-3">{result.slice(0,3).map((entry,index) => <section key={statuses[index]} className="overflow-hidden rounded-lg border bg-card"><div className="flex items-center justify-between gap-3 p-5"><h3 className="text-sm font-semibold">{labels[index]}</h3><Link href={`/it/tasks?status=${statuses[index]}`} className="text-xs text-primary hover:underline">View all</Link></div>{entry.status === 'rejected' ? <p className="px-5 pb-5 text-sm text-muted-foreground">Unable to load requests.</p> : entry.value.items.length ? <ul>{entry.value.items.map(request => <li key={request.id} className="border-t"><Link href={`/it/tasks/${request.id}`} className="block space-y-2 p-5 transition-colors hover:bg-muted/40"><p className="text-sm font-semibold">{request.profile.proposedDisplayName ?? 'Approved dispatcher'}</p><p className="text-xs text-muted-foreground">{request.profile.mcName}</p><StatusBadge status={request.status} /></Link></li>)}</ul> : <EmptyState title="No requests here" description="Requests will appear as onboarding progresses." />}</section>)}</div>
  </section>;
}
