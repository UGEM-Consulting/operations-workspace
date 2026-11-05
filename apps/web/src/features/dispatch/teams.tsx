'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Person } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/feedback';
import { FilterBar } from '@/components/ui/filter-bar';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { TEAM_DEFAULTS } from '@/lib/navigation';
import { TeamEditor } from './team-editor';
import type { Choice, TeamList } from './types';

/**
 * Dispatch › Teams. Each team works for one MC and may have a lead, who must be one of its dispatchers. A row opens the
 * team's page, which has Edit and Archive (designed as TeamRowsOpenScreen, approved 2026-11-05); archived teams stay on history.
 */
export function Teams({ data, mcs, filters }: { data: TeamList; mcs: Choice[]; filters: Record<string, string> }) {
  const [adding, setAdding] = useState(false);
  const query = filters.search.toLowerCase();
  const searched = data.items.filter(team => `${team.name} ${team.mc.name} ${team.lead?.name ?? ''}`.toLowerCase().includes(query));
  const visible = searched.filter(team => filters.status === 'ALL' || team.archived === (filters.status === 'ARCHIVED'));
  const filtered = filters.search !== '' || filters.status !== TEAM_DEFAULTS.status;
  return <div className="space-y-6">
    <PageHeader title="Teams" description="Dispatchers work in teams. Each team works for one MC and has one team lead."
      action={<Button onClick={() => setAdding(true)} disabled={!mcs.some(mc => !mc.archived)}><Plus aria-hidden="true" className="size-4" />Add team</Button>} />
    <Card>
      <FilterBar path="/dispatch/teams" filters={filters} defaults={TEAM_DEFAULTS} searchLabel="Search team, team lead or MC" statuses={[
        { key: 'ACTIVE', label: 'Active', count: searched.filter(row => !row.archived).length },
        { key: 'ARCHIVED', label: 'Archived', count: searched.filter(row => row.archived).length },
        { key: 'ALL', label: 'All', count: searched.length }]} />
      <Table caption="Teams" className="border-t border-border" rows={visible} rowKey={row => row.id} rowClassName={() => 'relative cursor-pointer'} columns={[
        // The link covers the whole row, so it's one thing to click.
        { key: 'team', label: 'Team', primary: true, cell: row => <Link href={`/dispatch/teams/${row.id}`} className="block rounded-sm after:absolute after:inset-0 hover:underline focus-visible:outline-2"><Person name={row.name} secondary={row.lead ? `Team lead ${row.lead.name}` : 'No team lead yet'} /></Link> },
        { key: 'mc', label: 'MC', cell: row => row.mc.name },
        { key: 'members', label: 'Dispatchers', align: 'right', cell: row => <span className="tabular-nums">{row.members}{row.onboarding ? <span className="ml-1 text-[13px] text-muted-foreground">+{row.onboarding} onboarding</span> : null}</span> },
        { key: 'helpers', label: 'Supports and updaters', align: 'right', hideBelow: 'lg', cell: row => <span className="tabular-nums">{row.helpers ?? row.wholeTeam ?? 0}</span> },
        { key: 'status', label: 'Status', hideBelow: 'md', cell: row => <Badge label={row.archived ? 'Archived' : 'Active'} tone={row.archived ? 'neutral' : 'success'} /> },
        { key: 'open', label: 'Open', srOnly: true, align: 'right', cell: () => <ChevronRight aria-hidden="true" className="ml-auto size-4 text-muted-foreground" /> },
      ]} empty={filtered ? <EmptyState compact title="Nothing matches these filters" description="Try another status or search." />
        : <EmptyState compact title="No teams yet" description={mcs.some(mc => !mc.archived) ? 'Add a team for each MC and team lead.' : 'Add an MC in Admin › Lists first; every team works for one MC.'} />} />
    </Card>
    {adding && <TeamEditor team={null} mcs={mcs} candidates={[]} onClose={() => setAdding(false)} />}
  </div>;
}
