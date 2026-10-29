import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { MemberProfileView } from '@/features/dispatch/member-profile';
import type { Choice, MemberProfile, TeamList } from '@/features/dispatch/types';
export const metadata = { title: 'Dispatcher' };
export default async function DispatcherPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePage('dispatchers');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [member, mcs, teams, titles] = await Promise.all([apiRequest(`dispatch/members/${id}`), apiRequest('lists/mcs'), apiRequest('dispatch/teams'), apiRequest('lists/job-titles')]);
  if (member.status === 404) notFound();
  if (!member.ok || !mcs.ok || !teams.ok || !titles.ok) throw new Error('Unable to load the dispatcher');
  const [profile, mcList, teamList, titleList] = await Promise.all([readResponse<MemberProfile>(member, 'dispatcher'), readResponse<{ items: Choice[] }>(mcs, 'MCs'),
    readResponse<TeamList>(teams, 'teams'), readResponse<{ items: Choice[] }>(titles, 'job titles')]);
  return <MemberProfileView member={profile} mcs={mcList.items} teams={teamList.items} jobTitles={titleList.items} />;
}
