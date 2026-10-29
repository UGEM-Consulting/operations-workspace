'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/field';
import { FilterBar } from '@/components/ui/filter-bar';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { TEAM_DEFAULTS } from '@/lib/navigation';
import { Choice, fullName, MemberRow, TeamList, TeamRow } from './types';

/**
 * Dispatch › Teams. Each team works for one MC and may have a lead, who must be one of its dispatchers. A team keeps its
 * MC and can't be archived while it has dispatchers; archived teams stay on history.
 */
export function Teams({ data, mcs, members, filters }: { data: TeamList; mcs: Choice[]; members: MemberRow[]; filters: Record<string, string> }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<TeamRow | 'new' | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const query = filters.search.toLowerCase();
  const searched = data.items.filter(team => `${team.name} ${team.mc.name} ${team.lead?.name ?? ''}`.toLowerCase().includes(query));
  const visible = searched.filter(team => filters.status === 'ALL' || team.archived === (filters.status === 'ARCHIVED'));
  const filtered = filters.search !== '' || filters.status !== TEAM_DEFAULTS.status;
  const team = editing === 'new' ? null : editing;
  // Only the team's own active dispatchers can lead it.
  // Only the team's own active dispatchers can lead it (not those still in IT setup).
  const candidates = team ? members.filter(member => member.teamId === team.id && member.status === 'ACTIVE' && member.position === 'DISPATCHER') : [];
  function open(next: TeamRow | 'new') { setEditing(next); setError(''); }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !editing) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPending('save'); setError('');
    try {
      if (team) await mutate(`dispatch/teams/${team.id}`, 'PATCH', { version: team.version, name: form.name, ...(team.members + (team.onboarding ?? 0) ? {} : { mcId: form.mcId }), leadMemberId: form.leadMemberId || null });
      else await mutate('dispatch/teams', 'POST', { name: form.name, mcId: form.mcId });
      toast({ title: team ? 'Team updated' : 'Team added' });
      setEditing(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(null); }
  }
  async function archive(row: TeamRow) {
    if (pending) return;
    setPending(row.id);
    try {
      await mutate(`dispatch/teams/${row.id}`, 'PATCH', { version: row.version, archived: !row.archived });
      toast({ title: row.archived ? `${row.name} restored` : `${row.name} archived` });
      router.refresh();
    } catch (error) { toast({ tone: 'danger', title: 'Not changed', description: errorMessage(error, 'Reload the page and try again.') }); }
    finally { setPending(null); }
  }
  const activeMcs = mcs.filter(mc => !mc.archived || mc.id === team?.mc.id);
  return <div className="space-y-6">
    <PageHeader title="Teams" description="Dispatchers work in teams. Each team works for one MC and has one team lead."
      action={<Button onClick={() => open('new')} disabled={!mcs.some(mc => !mc.archived)}><Plus aria-hidden="true" className="size-4" />Add team</Button>} />
    <Card>
      <FilterBar path="/dispatch/teams" filters={filters} defaults={TEAM_DEFAULTS} searchLabel="Search team, team lead or MC" statuses={[
        { key: 'ACTIVE', label: 'Active', count: searched.filter(row => !row.archived).length },
        { key: 'ARCHIVED', label: 'Archived', count: searched.filter(row => row.archived).length },
        { key: 'ALL', label: 'All', count: searched.length }]} />
      <Table caption="Teams" className="border-t border-border" rows={visible} rowKey={row => row.id} columns={[
        { key: 'team', label: 'Team', primary: true, cell: row => <Person name={row.name} secondary={row.lead ? `Team lead ${row.lead.name}` : 'No team lead yet'} /> },
        { key: 'mc', label: 'MC', cell: row => row.mc.name },
        { key: 'members', label: 'Dispatchers', align: 'right', cell: row => <span className="tabular-nums">{row.members}{row.onboarding ? <span className="ml-1 text-[13px] text-muted-foreground">+{row.onboarding} onboarding</span> : null}</span> },
        { key: 'status', label: 'Status', hideBelow: 'md', cell: row => <Badge label={row.archived ? 'Archived' : 'Active'} tone={row.archived ? 'neutral' : 'success'} /> },
        { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: row => <span className="flex justify-end gap-1">
          {!row.archived && <Button variant="outline" size="sm" disabled={!!pending} onClick={() => open(row)}>Edit<span className="sr-only"> {row.name}</span></Button>}
          <Button variant="ghost" size="sm" disabled={!!pending || (!row.archived && row.members + (row.onboarding ?? 0) > 0)} title={!row.archived && row.members + (row.onboarding ?? 0) > 0 ? 'Move its dispatchers first' : undefined} onClick={() => void archive(row)}>
            {pending === row.id ? 'Saving…' : row.archived ? 'Restore' : 'Archive'}<span className="sr-only"> {row.name}</span></Button></span> },
      ]} empty={filtered ? <EmptyState compact title="Nothing matches these filters" description="Try another status or search." />
        : <EmptyState compact title="No teams yet" description={mcs.some(mc => !mc.archived) ? 'Add a team for each MC and team lead.' : 'Add an MC in Admin › Lists first; every team works for one MC.'} />}
        footer={<p className="text-[13px] text-muted-foreground">A team can only be archived once it has no dispatchers.</p>} />
    </Card>
    {editing && <Dialog open onClose={() => setEditing(null)} busy={pending === 'save'} title={team ? `Edit ${team.name}` : 'Add team'}
      actions={<Button type="submit" form="team-editor">{pending === 'save' ? 'Saving…' : team ? 'Save changes' : 'Add team'}</Button>}>
      <form id="team-editor" onSubmit={save} className="space-y-4">
        <Input label="Team name" name="name" defaultValue={team?.name} required maxLength={100} autoComplete="off" width="full" hint="Usually the team lead’s name, such as Avery team." />
        <Select label="MC" name="mcId" defaultValue={team?.mc.id ?? ''} required disabled={!!team && team.members + (team.onboarding ?? 0) > 0} placeholder={team ? undefined : 'Choose an MC'} width="full"
          options={activeMcs.map(mc => ({ value: mc.id, label: mc.name }))} hint={team && team.members + (team.onboarding ?? 0) > 0 ? 'A team keeps its MC while it has dispatchers.' : undefined} />
        {team && <Select label="Team lead" name="leadMemberId" defaultValue={team.lead?.id ?? ''} placeholder="No team lead" width="full"
          options={candidates.map(member => ({ value: member.id, label: fullName(member) }))} hint={candidates.length ? 'One of this team’s dispatchers.' : 'Move a dispatcher into this team first.'} />}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
