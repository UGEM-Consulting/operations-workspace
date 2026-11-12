import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { ownerDetailSchema, readResponse } from '@/lib/api-schemas';
import { OwnerPage } from '@/features/safety/owner-page';
import type { OwnerDetail } from '@/features/safety/units-types';
import { SCREENER_ROLES } from '@/features/safety/types';
export const metadata = { title: 'Truck owner' };
export default async function TruckOwnerPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requirePage('units');
  const { id } = await params;
  const response = await apiRequest(`safety/owners/${encodeURIComponent(id)}`);
  if (response.status === 404 || response.status === 400) notFound();
  if (!response.ok) throw new Error('Unable to load the truck owner');
  return <OwnerPage owner={await readResponse<OwnerDetail>(response, 'truck owner', ownerDetailSchema)} canArchive={SCREENER_ROLES.includes(user.role)} />;
}
