import { apiRequest, requirePage } from '@/lib/auth';
import { dispatchDriverListSchema, dispatchDriverOptionsSchema, readResponse } from '@/lib/api-schemas';
import { DISPATCH_DRIVER_DEFAULTS } from '@/lib/navigation';
import { DispatchDrivers, type DispatchDriverOptions, type DispatchDriverRow } from '@/features/dispatch/drivers';
export const metadata = { title: 'Drivers' };
export default async function DispatchDriversPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('dispatchdrivers');
  const query = await searchParams;
  const filters = Object.fromEntries(Object.entries(DISPATCH_DRIVER_DEFAULTS).map(([key, value]) => [key, typeof query[key] === 'string' ? query[key].slice(0, 100) : value]));
  const [drivers, options] = await Promise.all([apiRequest('dispatch/drivers'), apiRequest('dispatch/drivers/options')]);
  if (!drivers.ok || !options.ok) throw new Error('Unable to load drivers');
  const [list, choices] = await Promise.all([readResponse<{ items: DispatchDriverRow[] }>(drivers, 'drivers', dispatchDriverListSchema), readResponse<DispatchDriverOptions>(options, 'dispatchers', dispatchDriverOptionsSchema)]);
  return <DispatchDrivers items={list.items} filters={filters} options={choices} teamLead={false} />;
}
