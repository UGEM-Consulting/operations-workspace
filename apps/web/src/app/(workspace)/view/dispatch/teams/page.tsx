import Link from 'next/link';
import { requirePage } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { Table } from '@/components/ui/table';
import { PageHeader } from '@/components/workspace-ui';
import { NotAvailable, viewRead, ViewOnlyMark } from '@/features/view/ui';
export const metadata = { title: 'Teams · view only' };

interface ViewTeam { id: string; name: string; mc: { id: string; name: string }; lead: { id: string; name: string } | null; members: number; onboarding: number; helpers: number }

/** Dispatch › Teams read only: each active team, its MC, lead and how many people, opening its page. */
export default async function ViewTeamsPage() {
  await requirePage('viewteams');
  const data = await viewRead<{ items: ViewTeam[] }>('dispatch/teams', 'teams');
  if (!data) return <NotAvailable back="/account/security" label="Account security" />;
  return <div className="space-y-6">
    <PageHeader title="Teams" badge={<ViewOnlyMark />} description="Dispatch teams, their MC and team lead." />
    <Card>
      <Table caption="Teams" rows={data.items} rowKey={team => team.id} columns={[
        { key: 'name', label: 'Team', primary: true, cell: team => <Link href={`/view/dispatch/teams/${team.id}`} className="font-medium text-foreground hover:underline">{team.name}</Link> },
        { key: 'mc', label: 'MC', cell: team => team.mc.name },
        { key: 'lead', label: 'Team lead', cell: team => team.lead ? <Link href={`/view/dispatch/dispatchers/${team.lead.id}`} className="hover:underline">{team.lead.name}</Link> : <span className="text-muted-foreground">No lead yet</span> },
        { key: 'members', label: 'Dispatchers', align: 'right', cell: team => team.members + team.onboarding },
        { key: 'helpers', label: 'Supports and updaters', align: 'right', hideBelow: 'md', cell: team => team.helpers },
      ]} empty={<EmptyState compact title="No teams yet" />} />
    </Card>
  </div>;
}
