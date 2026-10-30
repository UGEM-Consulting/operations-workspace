import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { DriverProfileView } from '@/features/safety/driver-profile';
import { SCREENER_ROLES, type DriverProfile, type SafetyPeople } from '@/features/safety/types';
export const metadata = { title: 'Driver' };
export default async function DriverPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requirePage('drivers');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [driver, people] = await Promise.all([apiRequest(`safety/drivers/${id}`), apiRequest('safety/people')]);
  if (driver.status === 404) notFound();
  if (!driver.ok || !people.ok) throw new Error('Unable to load the driver');
  const [profile, peopleList] = await Promise.all([readResponse<DriverProfile>(driver, 'driver'), readResponse<SafetyPeople>(people, 'Safety people')]);
  // The API decides; these only choose which actions to offer.
  const owns = profile.owners.some(row => row.endedAt === null && row.owner?.id === identity.user.id);
  return <DriverProfileView driver={profile} people={peopleList} screener={SCREENER_ROLES.includes(identity.user.role)} owns={owns} />;
}
