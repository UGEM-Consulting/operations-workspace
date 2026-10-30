import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse, teamViewSchema } from '@/lib/api-schemas';
import { MyTeam, type TeamView } from '@/features/dispatch/my-team';
export const metadata = { title: 'My team' };
export default async function MyTeamPage() {
  await requirePage('myteam');
  const response = await apiRequest('team');
  if (!response.ok) throw new Error('Unable to load your team');
  return <MyTeam data={await readResponse<TeamView>(response, 'team', teamViewSchema)} />;
}
