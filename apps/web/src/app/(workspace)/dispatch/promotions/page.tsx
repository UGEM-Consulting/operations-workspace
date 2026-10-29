import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { PROMOTION_DEFAULTS } from '@/lib/navigation';
import { Promotions, type PromotionRow } from '@/features/dispatch/promotions';
import type { Choice, TeamList } from '@/features/dispatch/types';
export const metadata = { title: 'Promotions' };
export default async function PromotionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('promotions');
  const query = await searchParams;
  const filters = Object.fromEntries(Object.entries(PROMOTION_DEFAULTS).map(([key, value]) => [key, typeof query[key] === 'string' ? query[key].slice(0, 100) : value]));
  const [promotions, mcs, teams, titles] = await Promise.all([apiRequest('dispatch/promotions'), apiRequest('lists/mcs'), apiRequest('dispatch/teams'), apiRequest('lists/job-titles')]);
  if (!promotions.ok || !mcs.ok || !teams.ok || !titles.ok) throw new Error('Unable to load promotions');
  const [data, mcList, teamList, titleList] = await Promise.all([readResponse<{ items: PromotionRow[] }>(promotions, 'promotions'), readResponse<{ items: Choice[] }>(mcs, 'MCs'),
    readResponse<TeamList>(teams, 'teams'), readResponse<{ items: Choice[] }>(titles, 'job titles')]);
  return <Promotions items={data.items} filters={filters} mcs={mcList.items} teams={teamList.items} jobTitles={titleList.items} />;
}
