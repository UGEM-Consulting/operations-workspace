import { redirect } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { existingDriverOptionsSchema, readResponse } from '@/lib/api-schemas';
import { AddExistingDrivers, type ExistingDriverOptions } from '@/features/safety/existing-drivers';
import { DECIDER_ROLES } from '@/features/safety/types';
export const metadata = { title: 'Add existing drivers' };
export default async function ExistingDriversPage() {
  const { user } = await requirePage('drivers');
  // Adding someone as Cleared stands in for the decision: the Safety Director and administrators only.
  if (!DECIDER_ROLES.includes(user.role)) redirect('/safety/drivers');
  const response = await apiRequest('safety/drivers/existing/options');
  if (!response.ok) throw new Error('Unable to load the choices for existing drivers');
  return <AddExistingDrivers options={await readResponse<ExistingDriverOptions>(response, 'existing driver options', existingDriverOptionsSchema)} />;
}
