import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse, unitDetailSchema, unitListSchema } from '@/lib/api-schemas';
import { UnitPage } from '@/features/safety/unit-page';
import type { UnitDetail, UnitList } from '@/features/safety/units-types';
import { SCREENER_ROLES } from '@/features/safety/types';
export const metadata = { title: 'Unit' };
export default async function UnitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requirePage('units');
  const { id } = await params;
  const [response, list] = await Promise.all([apiRequest(`safety/units/${encodeURIComponent(id)}`), apiRequest('safety/units')]);
  if (response.status === 404 || response.status === 400) notFound();
  if (!response.ok || !list.ok) throw new Error('Unable to load the unit');
  const [unit, choices] = await Promise.all([readResponse<UnitDetail>(response, 'unit', unitDetailSchema), readResponse<UnitList>(list, 'units', unitListSchema)]);
  // The API decides; this only hides buttons that would be refused (an owner-operator's Safety Manager is checked there).
  const canChange = SCREENER_ROLES.includes(user.role) || unit.responsibleId === user.id || user.role === 'SAFETY_STAFF';
  return <UnitPage unit={unit} choices={{ next: choices.next, choices: choices.choices }} canChange={canChange} />;
}
