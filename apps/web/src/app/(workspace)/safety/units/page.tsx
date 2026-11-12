import { apiRequest, requirePage } from '@/lib/auth';
import { ownerListSchema, readResponse, unitListSchema } from '@/lib/api-schemas';
import { UNIT_DEFAULTS } from '@/lib/navigation';
import { Units, type UnitsTab } from '@/features/safety/units';
import type { OwnerRow, UnitList } from '@/features/safety/units-types';
export const metadata = { title: 'Units' };
const TABS: UnitsTab[] = ['trucks', 'trailers', 'owners'];
export default async function UnitsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requirePage('units');
  const params = await searchParams;
  const tab = TABS.find(name => name === params.tab) ?? 'trucks';
  const filters = Object.fromEntries(Object.entries(UNIT_DEFAULTS).map(([key, value]) => [key, typeof params[key] === 'string' ? params[key].slice(0, 100) : value]));
  const [units, owners] = await Promise.all([apiRequest('safety/units'), apiRequest('safety/owners')]);
  if (!units.ok || !owners.ok) throw new Error('Unable to load units');
  const [data, ownerList] = await Promise.all([readResponse<UnitList>(units, 'units', unitListSchema), readResponse<{ items: OwnerRow[] }>(owners, 'truck owners', ownerListSchema)]);
  return <Units tab={tab} data={data} owners={ownerList.items} filters={filters} currentUserId={user.id} />;
}
