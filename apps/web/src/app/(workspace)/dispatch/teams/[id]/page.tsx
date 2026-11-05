import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { choiceListSchema, readResponse, teamDetailSchema } from '@/lib/api-schemas';
import { TeamPage } from '@/features/dispatch/team-page';
import type { Choice, TeamDetail } from '@/features/dispatch/types';
export const metadata = { title: 'Team' };
export default async function TeamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePage('teams');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [team, mcs] = await Promise.all([apiRequest(`dispatch/teams/${id}`), apiRequest('lists/mcs')]);
  if (team.status === 404) notFound();
  if (!team.ok || !mcs.ok) throw new Error('Unable to load the team');
  const [detail, mcList] = await Promise.all([readResponse<TeamDetail>(team, 'team', teamDetailSchema), readResponse<{ items: Choice[] }>(mcs, 'MCs', choiceListSchema)]);
  return <TeamPage team={detail} mcs={mcList.items} />;
}
