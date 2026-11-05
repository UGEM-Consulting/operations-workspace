'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/feedback';
import { Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { aSupport, memberBadge, supportName, type MemberStatus } from './types';

export interface TeamView {
  teams: { id: string; name: string; mc: string }[];
  dispatchers: { id: string; name: string; status: MemberStatus; teamId: string; jobTitle: string | null; lead: boolean }[];
  supports: { id: string; name: string; status: MemberStatus; dispatcherId: string | null; teamId?: string | null; since: string; sinceKnown?: boolean; supportType?: string; pending: { id: string; createdAt: string } | null }[];
  requests: { id: string; status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'CANCELLED'; reason: string; note: string | null; createdAt: string; decidedAt: string | null; support: string }[];
}

/**
 * A team lead's own team: its dispatchers and their supports (names and status only), and promotion requests. A team
 * lead asks for a support to become a dispatcher; a dispatch manager decides.
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
      toast({ title: 'Request sent', description: 'A dispatch manager will decide.' });
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
  const promotion = (support: TeamView['supports'][number]) => support.pending ? <span className="flex items-center gap-2"><Badge label="Requested" tone="info" /><Button size="sm" variant="ghost" disabled={!!pending} onClick={() => void cancel(support.pending!.id)}>{pending === support.pending.id ? 'Cancelling…' : 'Cancel'}<span className="sr-only"> the request for {support.name}</span></Button></span>
    : <Button size="sm" variant="outline" onClick={() => { setRequesting(support); setError(''); }}>Request promotion<span className="sr-only"> for {support.name}</span></Button>;
  const one = data.teams.length === 1 ? data.teams[0] : null, dispatcherCount = data.dispatchers.filter(row => row.teamId === one?.id).length;
  if (!data.teams.length) return <div className="space-y-6"><PageHeader title="My team" />
    <Alert tone="info" title="No team yet"><p>Your account isn’t linked to a team you lead. Ask a dispatch manager to set you as a team’s lead.</p></Alert></div>;
  return <div className="space-y-6">
    <PageHeader title={one?.name ?? 'My team'} meta={one ? [one.mc, `${dispatcherCount} ${dispatcherCount === 1 ? 'dispatcher' : 'dispatchers'}`] : data.teams.map(team => `${team.name} · ${team.mc}`)} />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <div className="min-w-0 space-y-6">
        {data.teams.map(team => {
          const wholeTeam = data.supports.filter(support => support.teamId === team.id);
          return <section key={team.id} aria-label={team.name} className="space-y-6">
            {!one && <h2 className="text-[17px] font-semibold leading-6">{team.name}<span className="block text-[13px] font-normal text-muted-foreground">{team.mc}</span></h2>}
            {wholeTeam.length > 0 && <Card><CardHeader title="Assist the whole team" description="They work with everyone here, not one dispatcher." />
              <Table className="mt-3 border-t border-border" caption="Whole team supports and updaters" rows={wholeTeam} rowKey={support => support.id} columns={[
                { key: 'name', label: 'Name', primary: true, cell: support => <Person name={support.name} secondary={supportName(support)} /> },
                { key: 'status', label: 'Status', cell: support => <Badge {...memberBadge(support.status)} /> },
                { key: 'request', label: 'Promotion', srOnly: true, action: true, align: 'right', cell: promotion }]} /></Card>}
            <Card><CardHeader title="Dispatchers" />
              <Table className="mt-3 border-t border-border" caption="Dispatchers and who assists them" rows={data.dispatchers.filter(row => row.teamId === team.id)} rowKey={dispatcher => dispatcher.id} columns={[
                { key: 'name', label: 'Name', primary: true, cell: dispatcher => <Person name={dispatcher.name} secondary={dispatcher.lead ? 'Dispatcher, team lead' : 'Dispatcher'} /> },
                { key: 'assisted', label: 'Assisted by', cell: dispatcher => {
                  const assisting = data.supports.filter(support => support.dispatcherId === dispatcher.id);
                  return assisting.length ? <ul className="space-y-2">{assisting.map(support => <li key={support.id} className="flex flex-wrap items-center gap-2"><span>{support.name}, {supportName(support)}</span>{promotion(support)}</li>)}</ul> : '—';
                } },
                { key: 'status', label: 'Status', cell: dispatcher => <Badge {...memberBadge(dispatcher.status)} /> }]} /></Card>
          </section>;
        })}
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
    {requesting && <Dialog open onClose={() => setRequesting(null)} busy={pending === 'request'} title={`Request promotion for ${requesting.name}`}
      description={`A dispatch manager decides. If approved, they become a dispatcher, get their company accounts from IT, and stop being ${aSupport(requesting)}.`}
      actions={<Button type="submit" form="promotion-request">{pending === 'request' ? 'Sending…' : 'Send request'}</Button>}>
      <form id="promotion-request" onSubmit={request} className="space-y-4">
        <Textarea label="Why they’re ready" name="reason" required maxLength={1000} rows={4} hint="What they already handle on their own. The manager sees this." />
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
