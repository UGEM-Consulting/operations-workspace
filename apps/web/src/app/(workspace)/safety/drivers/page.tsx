import { apiRequest, requirePage } from '@/lib/auth';
import { driverListSchema, readResponse, safetyPeopleSchema } from '@/lib/api-schemas';
import { DRIVER_DEFAULTS } from '@/lib/navigation';
import { Drivers } from '@/features/safety/drivers';
import { SCREENER_ROLES, type DriverRow, type SafetyPeople } from '@/features/safety/types';
export const metadata = { title: 'Drivers' };
export default async function DriversPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requirePage('drivers');
  const query = await searchParams;
  const filters = Object.fromEntries(Object.entries(DRIVER_DEFAULTS).map(([key, value]) => [key, typeof query[key] === 'string' ? query[key].slice(0, 100) : value]));
  const [drivers, people] = await Promise.all([apiRequest('safety/drivers'), apiRequest('safety/people')]);
  if (!drivers.ok || !people.ok) throw new Error('Unable to load drivers');
  const [data, peopleList] = await Promise.all([readResponse<{ items: DriverRow[] }>(drivers, 'drivers', driverListSchema), readResponse<SafetyPeople>(people, 'Safety people', safetyPeopleSchema)]);
  return <Drivers items={data.items} filters={filters} people={peopleList} canAdd={SCREENER_ROLES.includes(identity.user.role)} currentUserId={identity.user.id} />;
}
