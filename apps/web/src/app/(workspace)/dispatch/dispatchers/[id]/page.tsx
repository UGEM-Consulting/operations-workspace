import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { choiceListSchema, memberListSchema, memberProfileSchema, readResponse, teamListSchema } from '@/lib/api-schemas';
import { MemberProfileView } from '@/features/dispatch/member-profile';
import { fullName, type Choice, type MemberList, type MemberProfile, type TeamList } from '@/features/dispatch/types';
export const metadata = { title: 'Dispatcher' };
export default async function DispatcherPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePage('dispatchers');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [member, mcs, teams, titles, members] = await Promise.all([apiRequest(`dispatch/members/${id}`), apiRequest('lists/mcs'), apiRequest('dispatch/teams'), apiRequest('lists/job-titles'), apiRequest('dispatch/members')]);
  if (member.status === 404) notFound();
  if (!member.ok || !mcs.ok || !teams.ok || !titles.ok) throw new Error('Unable to load the dispatcher');
  const [profile, mcList, teamList, titleList] = await Promise.all([readResponse<MemberProfile>(member, 'dispatcher', memberProfileSchema), readResponse<{ items: Choice[] }>(mcs, 'MCs', choiceListSchema),
    readResponse<TeamList>(teams, 'teams', teamListSchema), readResponse<{ items: Choice[] }>(titles, 'job titles', choiceListSchema)]);
  // Dispatchers a support could assist instead (not left; still in IT setup is fine). If they can't be loaded, the
  // "Change dispatcher" dialog says so instead of offering an empty list.
  const dispatcherList = members.ok ? await readResponse<MemberList>(members, 'dispatchers', memberListSchema).catch(() => null) : null;
  const dispatchers = (dispatcherList?.items ?? []).filter(item => item.position === 'DISPATCHER' && item.status !== 'LEFT' && item.id !== profile.id)
    .map(item => ({ id: item.id, name: fullName(item), mc: item.mc, team: item.team }));
  return <MemberProfileView member={profile} mcs={mcList.items} teams={teamList.items} jobTitles={titleList.items} dispatchers={dispatchers} dispatchersFailed={!dispatcherList} />;
}
