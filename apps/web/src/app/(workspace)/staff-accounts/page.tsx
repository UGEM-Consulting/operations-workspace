import { apiRequest, requirePage, type StaffUser } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { USER_DEFAULTS } from '@/lib/navigation';
import { UserManagement, type LeadChoice } from '@/features/users/user-management';
import { fullName, type MemberList, type TeamList } from '@/features/dispatch/types';
export const metadata = { title: 'Staff accounts' };
export default async function StaffAccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requirePage('users');
  const params = await searchParams;
  const filters = Object.fromEntries(Object.entries(USER_DEFAULTS).map(([key, value]) => [key, typeof params[key] === 'string' ? params[key].slice(0, 100) : value]));
  const [response, members, teams] = await Promise.all([apiRequest('users'), apiRequest('dispatch/members'), apiRequest('dispatch/teams')]);
  if (!response.ok) throw new Error('Unable to load users');
  // Dispatcher records a team lead account can link to, with the team each one leads (without them, no team lead option works).
  let leads: LeadChoice[] = [];
  if (members.ok && teams.ok) {
    const [memberList, teamList] = await Promise.all([readResponse<MemberList>(members, 'dispatchers'), readResponse<TeamList>(teams, 'teams')]);
    leads = memberList.items.filter(member => member.position === 'DISPATCHER' && member.status !== 'LEFT')
      .map(member => ({ id: member.id, name: fullName(member), team: teamList.items.find(team => !team.archived && team.lead?.id === member.id)?.name ?? null }));
  }
  return <UserManagement page users={await readResponse<StaffUser[]>(response, 'users')} currentUserId={identity.user.id} filters={filters} leads={leads} />;
}
