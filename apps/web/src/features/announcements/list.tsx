import Link from 'next/link';
import { Megaphone } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { PageHeader } from '@/components/workspace-ui';
import { firstLine, rowBadge, type AnnouncementRow } from './shared';

/** Dispatch › Announcements and a team lead's Announcements (AnnounceListScreen, AnnounceEmptyScreen): newest first. */
export function AnnouncementList({ items, base, lead }: { items: AnnouncementRow[]; base: string; lead: boolean }) {
  const write = <Link href={`${base}/new`} className={buttonVariants()}><Megaphone aria-hidden="true" className="size-4" />New announcement</Link>;
  return <div className="space-y-6">
    <PageHeader title="Announcements" description={lead ? 'Messages to your team’s Telegram group, written here and sent by the workspace bot.' : 'Messages to teams’ Telegram groups, written here and sent by the workspace bot.'} action={write} />
    {items.length ? <Card>
      <Table caption="Announcements" rows={items} rowKey={row => row.id} columns={[
        { key: 'message', label: 'Message', primary: true, cell: row => <Link href={`${base}/${row.id}`} className="block max-w-md truncate font-medium text-primary hover:underline">{firstLine(row.text)}</Link> },
        { key: 'to', label: 'To', cell: row => row.teams.length === 1 ? row.teams[0] : `${row.teams.length} teams` },
        { key: 'by', label: 'By', hideBelow: 'md', cell: row => row.authorRole === 'Team lead' ? `${row.authorName} (team lead)` : row.authorName },
        { key: 'sent', label: 'Sent', nowrap: true, cell: row => <LocalTime iso={row.createdAt} /> },
        { key: 'delivered', label: 'Delivered', cell: row => { const badge = rowBadge(row); return <Badge label={badge.label} tone={badge.tone} />; } },
      ]} />
    </Card> : <Card><CardBody><EmptyState icon={Megaphone} title="No announcements yet"
      description={lead ? 'Write one to send to your team’s Telegram group.' : 'Write one to send to the Telegram groups of one team, several, or every team. A team needs its group linked first (Admin › Telegram).'} action={write} /></CardBody></Card>}
  </div>;
}
