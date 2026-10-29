'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/feedback';
import { Select, Textarea } from '@/components/ui/field';
import { FilterBar } from '@/components/ui/filter-bar';
import { LocalTime } from '@/components/ui/local-time';
import { Table } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { PROMOTION_DEFAULTS } from '@/lib/navigation';
import type { Choice, TeamRow } from './types';

export interface PromotionRow { id: string; status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'CANCELLED'; reason: string; note: string | null; version: number; createdAt: string; decidedAt: string | null;
  itRequestId: string | null; supportId: string; support: string; dispatcherId: string | null; dispatcher: string | null; mcId: string | null; mc: string | null; teamId: string | null; team: string | null;
  requestedBy: string | null; decidedBy: string | null }

/**
 * Dispatch › Promotions: team leads' requests for a support to become a dispatcher. Approving picks where they will work
 * (by default their dispatcher's MC and team) and a job title, and starts their IT setup; declining needs a note the team
 * lead sees.
 */
export function Promotions({ items, filters, mcs, teams, jobTitles }: { items: PromotionRow[]; filters: Record<string, string>; mcs: Choice[]; teams: TeamRow[]; jobTitles: Choice[] }) {
  const router = useRouter();
  const toast = useToast();
  const [deciding, setDeciding] = useState<{ row: PromotionRow; decision: 'APPROVE' | 'DECLINE' } | null>(null);
  const [mcId, setMcId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const query = filters.search.toLowerCase();
  const searched = items.filter(row => `${row.support} ${row.dispatcher ?? ''} ${row.team ?? ''} ${row.requestedBy ?? ''}`.toLowerCase().includes(query));
  const visible = searched.filter(row => filters.status === 'ALL' || row.status === filters.status);
  const teamChoices = teams.filter(team => !team.archived && team.mc.id === mcId);
  function open(row: PromotionRow, decision: 'APPROVE' | 'DECLINE') { setDeciding({ row, decision }); setMcId(row.mcId ?? ''); setError(''); }
  async function decide(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deciding || pending) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPending(true); setError('');
    try {
      await mutate(`dispatch/promotions/${deciding.row.id}/decide`, 'POST', { version: deciding.row.version, decision: deciding.decision, ...(form.note?.trim() ? { note: form.note } : {}),
        ...(deciding.decision === 'APPROVE' ? { mcId: form.mcId || null, teamId: form.teamId || null, jobTitleId: form.jobTitleId } : {}) });
      toast(deciding.decision === 'APPROVE' ? { title: `${deciding.row.support} is now a dispatcher`, description: 'Their IT setup request was created.' } : { title: 'Request declined' });
      setDeciding(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <div className="space-y-6">
    <PageHeader title="Promotions" description="Team leads’ requests for a support to become a dispatcher. Approving starts their IT setup." />
    <Card>
      <FilterBar path="/dispatch/promotions" filters={filters} defaults={PROMOTION_DEFAULTS} searchLabel="Search support, dispatcher or team" statuses={[
        { key: 'PENDING', label: 'Waiting', count: searched.filter(row => row.status === 'PENDING').length },
        { key: 'APPROVED', label: 'Approved', count: searched.filter(row => row.status === 'APPROVED').length },
        { key: 'DECLINED', label: 'Declined', count: searched.filter(row => row.status === 'DECLINED').length },
        { key: 'ALL', label: 'All', count: searched.length }]} />
      <Table caption="Promotion requests" className="border-t border-border" rows={visible} rowKey={row => row.id} columns={[
        { key: 'support', label: 'Support', primary: true, cell: row => <Link href={`/dispatch/dispatchers/${row.supportId}`} className="block rounded-sm hover:underline"><Person name={row.support} secondary={row.dispatcher ? `Supports ${row.dispatcher}` : undefined} /></Link> },
        { key: 'team', label: 'Team', hideBelow: 'md', cell: row => row.team ? <>{row.team}<span className="block text-[13px] text-muted-foreground">{row.mc}</span></> : <span className="text-muted-foreground">{row.mc ?? 'Independent'}</span> },
        { key: 'reason', label: 'Why', hideBelow: 'lg', cell: row => <><p className="line-clamp-2 text-sm">{row.reason}</p><p className="text-[13px] text-muted-foreground">by {row.requestedBy ?? 'a team lead'} · <LocalTime iso={row.createdAt} format="date" /></p></> },
        { key: 'status', label: 'Status', cell: row => <StatusBadge status={row.status} /> },
        { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: row => row.status === 'PENDING' ? <span className="flex justify-end gap-1">
          <Button size="sm" onClick={() => open(row, 'APPROVE')}>Approve<span className="sr-only"> {row.support}</span></Button>
          <Button size="sm" variant="ghost" className="text-danger" onClick={() => open(row, 'DECLINE')}>Decline<span className="sr-only"> {row.support}</span></Button></span>
          : row.itRequestId ? <span className="text-[13px] text-muted-foreground">IT setup started</span> : null },
      ]} empty={<EmptyState compact title={filters.status === 'PENDING' && !filters.search ? 'No requests waiting' : 'Nothing matches these filters'} description="Team leads send requests from their My team page." />} />
    </Card>
    {deciding && <Dialog open onClose={() => setDeciding(null)} busy={pending} tone={deciding.decision === 'DECLINE' ? 'danger' : undefined}
      title={deciding.decision === 'APPROVE' ? `Make ${deciding.row.support} a dispatcher` : `Decline the request for ${deciding.row.support}?`}
      description={deciding.decision === 'APPROVE' ? 'They stop being a support, become a dispatcher in Onboarding and get an IT setup request. They become Active when IT finishes.' : 'The team lead sees your note.'}
      actions={<Button type="submit" form="promotion-decision" variant={deciding.decision === 'DECLINE' ? 'destructive' : 'default'}>{pending ? 'Saving…' : deciding.decision === 'APPROVE' ? 'Approve' : 'Decline'}</Button>}>
      <form id="promotion-decision" onSubmit={decide} className="space-y-4">
        <div className="rounded-md bg-muted px-4 py-3 text-sm"><p className="font-medium">Why they’re ready</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{deciding.row.reason}</p></div>
        {deciding.decision === 'APPROVE' && <>
          <Select label="MC" name="mcId" value={mcId} onChange={event => setMcId(event.target.value)} width="full" options={[{ value: '', label: 'Independent' }, ...mcs.filter(mc => !mc.archived).map(mc => ({ value: mc.id, label: mc.name }))]} />
          <Select key={mcId} label="Team" name="teamId" defaultValue={teamChoices.some(team => team.id === deciding.row.teamId) ? deciding.row.teamId ?? '' : ''} disabled={!mcId} placeholder="No team" width="full"
            options={teamChoices.map(team => ({ value: team.id, label: team.name }))} hint="Defaults to the team of the dispatcher they support." />
          <Select label="Job title" name="jobTitleId" required placeholder="Choose a job title" width="full" options={jobTitles.filter(title => !title.archived).map(title => ({ value: title.id, label: title.name }))} />
        </>}
        <Textarea label={deciding.decision === 'DECLINE' ? 'Note for the team lead' : 'Note'} optional={deciding.decision === 'APPROVE'} required={deciding.decision === 'DECLINE'} name="note" maxLength={1000} rows={3} />
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
