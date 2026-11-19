import { notFound } from 'next/navigation';
import { Card, CardBody } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { PageCrumb } from '@/components/shell-context';
import { PageHeader } from '@/components/workspace-ui';
import { apiRequest, requirePage } from '@/lib/auth';
import { announcementDetailSchema, announcementListSchema, announcementOptionsSchema, readResponse } from '@/lib/api-schemas';
import { ComposeAnnouncement } from './compose';
import { AnnouncementPage } from './detail';
import { AnnouncementList } from './list';
import type { AnnouncementDetail, AnnouncementOptions, AnnouncementRow } from './shared';

// The same pages serve managers (Dispatch › Announcements) and team leads (/team/announcements); the API decides the scope.
type Where = { key: 'announcements' | 'teamannouncements'; base: string; lead: boolean };
export const DISPATCH: Where = { key: 'announcements', base: '/dispatch/announcements', lead: false };
export const TEAM: Where = { key: 'teamannouncements', base: '/team/announcements', lead: true };
// A team lead whose dispatcher record leads no team right now (the API refuses with 403).
const noTeam = <div className="space-y-6"><PageHeader title="Announcements" />
  <Card><CardBody><EmptyState title="You don’t lead a team right now" description="Announcements show here while your dispatcher record leads a team. Ask a dispatch manager if this looks wrong." /></CardBody></Card></div>;

export async function ListPage(where: Where) {
  await requirePage(where.key);
  const response = await apiRequest('announcements');
  if (response.status === 403 && where.lead) return noTeam;
  if (!response.ok) throw new Error('Unable to load announcements');
  const data = await readResponse<{ items: AnnouncementRow[] }>(response, 'announcements', announcementListSchema);
  return <><PageCrumb label="Announcements" /><AnnouncementList items={data.items} base={where.base} lead={where.lead} /></>;
}
export async function NewPage(where: Where, team: string | undefined) {
  await requirePage(where.key);
  const response = await apiRequest('announcements/options');
  if (response.status === 403 && where.lead) return noTeam;
  if (!response.ok) throw new Error('Unable to load teams');
  const options = await readResponse<AnnouncementOptions>(response, 'teams', announcementOptionsSchema);
  // The API sends the header the groups will see (name and role), so the preview matches it exactly.
  return <><PageCrumb label="New" /><ComposeAnnouncement options={options} base={where.base} lead={where.lead} presetTeam={team && /^[0-9a-f-]{36}$/.test(team) ? team : null} /></>;
}
export async function DetailPage(where: Where, id: string) {
  await requirePage(where.key);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const response = await apiRequest(`announcements/${id}`);
  if (response.status === 403 && where.lead) return noTeam;
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error('Unable to load the announcement');
  const announcement = await readResponse<AnnouncementDetail>(response, 'announcement', announcementDetailSchema);
  return <><PageCrumb label="Announcement" /><AnnouncementPage announcement={announcement} /></>;
}
