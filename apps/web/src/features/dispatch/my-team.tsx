'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/feedback';
import { Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { memberBadge, type MemberStatus } from './types';

export interface TeamView {
  teams: { id: string; name: string; mc: string }[];
  dispatchers: { id: string; name: string; status: MemberStatus; teamId: string; jobTitle: string | null; lead: boolean }[];
  supports: { id: string; name: string; status: MemberStatus; dispatcherId: string; since: string; pending: { id: string; createdAt: string } | null }[];
  requests: { id: string; status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'CANCELLED'; reason: string; note: string | null; createdAt: string; decidedAt: string | null; support: string }[];
}

/**
 * A team lead's own team: its dispatchers and their supports (names and status only), and promotion requests. A team
 * lead asks for a support to become a dispatcher; a dispatcher manager decides.
 */
export function MyTeam({ data }: { data: TeamView }) {
  const router = useRouter();
  const toast = useToast();
  const [requesting, setRequesting] = useState<TeamView['supports'][number] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function request(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requesting || pending) return;
    setPending('request'); setError('');
    try {
      await mutate('team/promotions', 'POST', { supportId: requesting.id, reason: String(new FormData(event.currentTarget).get('reason') ?? '') });
      toast({ title: 'Request sent', description: 'A dispatcher manager will decide.' });
      setRequesting(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to send. Your entries have been kept.')); }
    finally { setPending(null); }
  }
  async function cancel(id: string) {
    if (pending) return;
    setPending(id);
    try { await mutate(`team/promotions/${id}/cancel`, 'POST', {}); toast({ title: 'Request cancelled' }); router.refresh(); }
    catch (error) { toast({ tone: 'danger', title: 'Not cancelled', description: errorMessage(error, 'Reload the page and try again.') }); }
    finally { setPending(null); }
  }
  if (!data.teams.length) return <div className="space-y-6"><PageHeader title="My team" />
    <Alert tone="info" title="No team yet"><p>Your account isn’t linked to a team you lead. Ask a dispatcher manager to set you as a team’s lead.</p></Alert></div>;
  return <div className="space-y-6">
    <PageHeader title="My team" description="Your team’s dispatchers and the supports who help them. Ask for a support to become a dispatcher when they’re ready." meta={data.teams.map(team => `${team.name} · ${team.mc}`)} />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <div className="min-w-0 space-y-6">
        {data.teams.map(team => <Card key={team.id}>
          <CardHeader title={team.name} description={team.mc} />
          <ul className="mt-3 divide-y divide-border border-t border-border">
            {data.dispatchers.filter(row => row.teamId === team.id).map(dispatcher => <li key={dispatcher.id} className="px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Person name={dispatcher.name} secondary={dispatcher.lead ? 'Team lead' : dispatcher.jobTitle ?? 'Dispatcher'} />
                <Badge {...memberBadge(dispatcher.status)} />
              </div>
              {data.supports.filter(support => support.dispatcherId === dispatcher.id).map(support => <div key={support.id} className="ml-11 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
                <span className="min-w-0 text-sm"><span className="font-medium">{support.name}</span><span className="block text-[13px] text-muted-foreground">Support since <LocalTime iso={support.since} format="date" /></span></span>
                {support.pending ? <span className="flex items-center gap-2"><Badge label="Requested" tone="info" /><Button size="sm" variant="ghost" disabled={!!pending} onClick={() => void cancel(support.pending!.id)}>{pending === support.pending.id ? 'Cancelling…' : 'Cancel'}<span className="sr-only"> the request for {support.name}</span></Button></span>
                  : <Button size="sm" variant="outline" onClick={() => { setRequesting(support); setError(''); }}><TrendingUp aria-hidden="true" className="size-4" />Request dispatcher access<span className="sr-only"> for {support.name}</span></Button>}
              </div>)}
            </li>)}
          </ul>
        </Card>)}
      </div>
      <Card className="xl:sticky xl:top-20">
        <CardHeader title="Your requests" />
        {data.requests.length ? <ul className="mt-3 divide-y divide-border border-t border-border">{data.requests.map(row => <li key={row.id} className="space-y-1 px-4 py-3 text-sm sm:px-5">
          <div className="flex items-center justify-between gap-2"><span className="font-medium">{row.support}</span><StatusBadge status={row.status} /></div>
          <p className="text-[13px] text-muted-foreground"><LocalTime iso={row.createdAt} format="date" />{row.decidedAt ? <> · decided <LocalTime iso={row.decidedAt} format="date" /></> : null}</p>
          {row.note && <p className="rounded-md bg-muted px-3 py-2 text-[13px]">{row.note}</p>}
        </li>)}</ul> : <CardBody><EmptyState compact title="No requests yet" description="Requests you send appear here with the manager’s decision." /></CardBody>}
      </Card>
    </div>
    {requesting && <Dialog open onClose={() => setRequesting(null)} busy={pending === 'request'} title={`Request dispatcher access for ${requesting.name}`}
      description="A dispatcher manager decides. If approved, they become a dispatcher, get their company accounts from IT, and stop being a support."
      actions={<Button type="submit" form="promotion-request">{pending === 'request' ? 'Sending…' : 'Send request'}</Button>}>
      <form id="promotion-request" onSubmit={request} className="space-y-4">
        <Textarea label="Why they’re ready" name="reason" required maxLength={1000} rows={4} hint="What they already handle on their own. The manager sees this." />
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
