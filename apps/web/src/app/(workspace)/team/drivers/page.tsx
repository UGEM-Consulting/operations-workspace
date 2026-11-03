import { apiRequest, requirePage } from '@/lib/auth';
import { dispatchDriverListSchema, dispatchDriverOptionsSchema, readResponse } from '@/lib/api-schemas';
import { DISPATCH_DRIVER_DEFAULTS } from '@/lib/navigation';
import { EmptyState } from '@/components/ui/feedback';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/workspace-ui';
import { DispatchDrivers, type DispatchDriverOptions, type DispatchDriverRow } from '@/features/dispatch/drivers';
export const metadata = { title: 'Drivers' };
export default async function TeamDriversPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('teamdrivers');
  const query = await searchParams;
  const filters = Object.fromEntries(Object.entries(DISPATCH_DRIVER_DEFAULTS).map(([key, value]) => [key, typeof query[key] === 'string' ? query[key].slice(0, 100) : value]));
  const [drivers, options] = await Promise.all([apiRequest('team/drivers'), apiRequest('team/drivers/options')]);
  // A team lead whose dispatcher record leads no team right now (the API refuses with 403).
  if (drivers.status === 403) return <div className="space-y-6"><PageHeader title="Drivers" />
    <Card><CardBody><EmptyState title="You don’t lead a team right now" description="Drivers show here while your dispatcher record leads a team. Ask a dispatch manager if this looks wrong." /></CardBody></Card></div>;
  if (!drivers.ok || !options.ok) throw new Error('Unable to load drivers');
  const [list, choices] = await Promise.all([readResponse<{ items: DispatchDriverRow[] }>(drivers, 'drivers', dispatchDriverListSchema), readResponse<DispatchDriverOptions>(options, 'dispatchers', dispatchDriverOptionsSchema)]);
  return <DispatchDrivers items={list.items} filters={filters} options={choices} teamLead />;
}
