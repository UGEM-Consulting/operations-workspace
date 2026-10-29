import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { apiRequest } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Person } from '@/components/ui/avatar';
import { StatCard } from '@/components/workspace-ui';
import { EmptyState } from '@/components/ui/feedback';
import { StatusBadge } from '@/components/ui/status-badge';
import type { ApplicationList, ReviewSummary } from '@/features/onboarding/types';
import { type ItQueue, type ItRequest, type Notifications } from '@/features/it/types';
import { ManagerNotifications } from '@/features/it/notifications';

async function read<T>(path: string): Promise<T> {
  const response = await apiRequest(path);
  if (!response.ok) throw new Error('Workspace data unavailable');
  return readResponse<T>(response, 'workspace data');
}
function Unavailable({ title }: { title: string }) {
  return <Alert tone="warning" title={title}><p>This information could not be loaded. The service may be starting up; reload the page in a moment.</p></Alert>;
}
/** How long something has waited, in whole hours or days: "5 hours", "3 days". */
export function waited(iso: string | null, now = Date.now()) {
  if (!iso) return '';
  const hours = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 3_600_000));
  if (hours < 1) return 'Under an hour';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
const viewAll = (href: string) => <Button asChild size="sm" variant="ghost"><Link href={href}>View all<ArrowRight aria-hidden="true" className="size-4" /></Link></Button>;

/** The review side of the dashboard: the summary line, counts, the oldest waiting applications and IT completion updates. */
export async function ReviewWork({ firstName }: { firstName: string }) {
  const [summary, queue, notifications] = await Promise.allSettled([
    read<ReviewSummary>('onboarding/summary'),
    read<ApplicationList>('onboarding/review-queue?status=AWAITING_REVIEW&pageSize=5&sort=submittedAt&direction=ASC'),
    read<Notifications>('notifications'),
  ]);
  const waiting = summary.status === 'fulfilled' ? summary.value.awaitingReview : null;
  const oldest = queue.status === 'fulfilled' ? queue.value.items[0]?.submittedAt ?? null : null;
  const lead = waiting === null ? 'Here is what needs your attention.' : waiting === 0 ? 'Nothing is waiting for your decision.'
    : `${waiting} application${waiting === 1 ? ' is' : 's are'} waiting for your decision.${oldest ? ` The oldest has waited ${waited(oldest).toLowerCase()}.` : ''}`;
  return <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0"><h1 className="font-sans text-[22px] font-semibold leading-[30px] tracking-[-0.01em]">Welcome back, {firstName}</h1><p className="mt-1 text-sm leading-6 text-muted-foreground">{lead}</p></div>
      <div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link href="/onboarding/applications">Open review queue</Link></Button><Button asChild><Link href="/onboarding/invitations">Create invitation</Link></Button></div>
    </div>
    {summary.status === 'fulfilled' ? <section aria-label="Application summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard label="Awaiting review" value={summary.value.awaitingReview} tone="info" detail={summary.value.resubmitted ? `${summary.value.resubmitted} resubmitted` : 'New submissions and resubmissions'} href="/onboarding/applications" />
      <StatCard label="Changes requested" value={summary.value.changesRequested} tone="warning" detail="Waiting on applicants" href="/onboarding/applications?status=CHANGES_REQUESTED" />
      <StatCard label="Approved" value={summary.value.approved} tone="success" detail="Sent to IT setup" href="/onboarding/applications?status=APPROVED" />
      <StatCard label="Rejected" value={summary.value.rejected} tone="danger" detail="Closed applications" href="/onboarding/applications?status=REJECTED" />
    </section> : <Unavailable title="Application summary unavailable" />}
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Ready for your review" description="Oldest first" actions={viewAll('/onboarding/applications')} />
        {queue.status === 'rejected' ? <div className="p-4 sm:p-5"><Unavailable title="Review queue unavailable" /></div>
          : queue.value.items.length ? <ul className="mt-3 divide-y divide-border border-t border-border">{queue.value.items.map(item => {
            const name = [item.fields.firstName, item.fields.lastName].filter(Boolean).join(' ') || 'Applicant';
            return <li key={item.id}><Link href={`/onboarding/applications/${item.id}`} className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none sm:px-5">
              <Person name={name} secondary={item.mcName || 'Employment not provided'} />
              <span className="flex shrink-0 items-center gap-3"><span className="hidden text-[13px] tabular-nums text-muted-foreground sm:inline">{waited(item.submittedAt)}</span><StatusBadge status={item.status} /></span>
            </Link></li>;
          })}</ul> : <EmptyState compact title="Your review queue is clear" description="New submissions and resubmissions appear here." />}
      </Card>
      {notifications.status === 'fulfilled' ? <ManagerNotifications initial={notifications.value} /> : <Unavailable title="Updates unavailable" />}
    </div>
  </div>;
}

const IT_STATUSES = [['BLOCKED', 'Blocked', 'warning', 'Waiting on something'], ['PENDING', 'Not started', 'neutral', 'New approvals'], ['IN_PROGRESS', 'In progress', 'info', 'Setup under way'], ['COMPLETED', 'Completed', 'success', 'Manager notified']] as const;

/** The IT side of the dashboard: request counts by status and the requests that need attention first. */
export async function ItWork({ heading }: { heading: 'h1' | 'h2' }) {
  const results = await Promise.allSettled(IT_STATUSES.map(([status]) => read<ItQueue>(`it/onboarding?status=${status}&pageSize=5`)));
  // Blocked first, then not started, then in progress: the order IT should pick them up.
  const attention = results.slice(0, 3).flatMap(result => result.status === 'fulfilled' ? result.value.items : []).slice(0, 6);
  const open = results.slice(0, 3).reduce((total, result) => total + (result.status === 'fulfilled' ? result.value.total : 0), 0);
  const Heading = heading;
  return <section aria-labelledby="it-work-title" className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0"><Heading id="it-work-title" className={heading === 'h1' ? 'font-sans text-[22px] font-semibold leading-[30px] tracking-[-0.01em]' : 'text-lg font-semibold'}>IT setup</Heading>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{open ? `${open} approved dispatcher${open === 1 ? ' is' : 's are'} waiting for setup to finish.` : 'Every approved dispatcher is set up.'}</p></div>
      <Button asChild variant="outline"><Link href="/it/tasks">Open IT tasks</Link></Button>
    </div>
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">{results.map((result, index) => {
      const [status, label, tone, detail] = IT_STATUSES[index];
      return result.status === 'fulfilled' ? <StatCard key={status} label={label} value={result.value.total} tone={tone} detail={detail} href={`/it/tasks?status=${status}`} /> : <Unavailable key={status} title={`${label} unavailable`} />;
    })}</div>
    <Card>
      <CardHeader title="Needs attention" description="Blocked first, then not started" as={heading === 'h1' ? 'h2' : 'h3'} actions={viewAll('/it/tasks')} />
      {attention.length ? <ul className="mt-3 divide-y divide-border border-t border-border">{attention.map((request: ItRequest) => <li key={request.id}><Link href={`/it/tasks/${request.id}`} className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none sm:px-5">
        <Person name={request.profile.proposedDisplayName ?? 'Approved dispatcher'} secondary={`${request.profile.mcName} · ${request.profile.jobTitle}`} />
        <span className="shrink-0"><StatusBadge status={request.status} /></span>
      </Link></li>)}</ul> : <EmptyState compact headingLevel={4} title="Nothing needs attention" description="New approvals create setup requests automatically." />}
    </Card>
  </section>;
}
