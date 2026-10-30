import { apiRequest, requirePage } from '@/lib/auth';
import { choiceListSchema, memberListSchema, readResponse, teamListSchema } from '@/lib/api-schemas';
import { TEAM_DEFAULTS } from '@/lib/navigation';
import { Teams } from '@/features/dispatch/teams';
import type { Choice, MemberList, TeamList } from '@/features/dispatch/types';
export const metadata = { title: 'Teams' };
export default async function TeamsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('teams');
  const query = await searchParams;
  const filters = Object.fromEntries(Object.entries(TEAM_DEFAULTS).map(([key, value]) => [key, typeof query[key] === 'string' ? query[key].slice(0, 100) : value]));
  const [teams, mcs, members] = await Promise.all([apiRequest('dispatch/teams'), apiRequest('lists/mcs'), apiRequest('dispatch/members?status=ACTIVE')]);
  if (!teams.ok || !mcs.ok || !members.ok) throw new Error('Unable to load teams');
  const [data, mcList, memberList] = await Promise.all([readResponse<TeamList>(teams, 'teams', teamListSchema), readResponse<{ items: Choice[] }>(mcs, 'MCs', choiceListSchema), readResponse<MemberList>(members, 'dispatchers', memberListSchema)]);
  return <Teams data={data} mcs={mcList.items} members={memberList.items} filters={filters} />;
}
