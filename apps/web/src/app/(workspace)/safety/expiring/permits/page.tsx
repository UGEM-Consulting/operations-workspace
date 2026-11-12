import { apiRequest, requirePage } from '@/lib/auth';
import { permitsYearSchema, readResponse } from '@/lib/api-schemas';
import { PERMIT_DEFAULTS } from '@/lib/navigation';
import { Permits } from '@/features/safety/permits';
import type { PermitsYear } from '@/features/safety/units-types';
export const metadata = { title: 'Permits' };
export default async function PermitsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requirePage('expiring');
  const params = await searchParams;
  const defaults = { ...PERMIT_DEFAULTS, status: user.role === 'SAFETY_STAFF' ? 'MINE' : 'ALL' };
  const filters = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof params[key] === 'string' ? params[key].slice(0, 100) : value]));
  if (!['MINE', 'ALL', 'DONE'].includes(filters.status)) filters.status = defaults.status;
  const response = await apiRequest('safety/units/permits');
  if (!response.ok) throw new Error('Unable to load permits');
  return <Permits data={await readResponse<PermitsYear>(response, 'permits', permitsYearSchema)} filters={filters} currentUserId={user.id} />;
}
