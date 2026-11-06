import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse, trucksSchema } from '@/lib/api-schemas';
import { Trucks, type TruckList } from '@/features/safety/trucks';
export const metadata = { title: 'Trucks' };
export default async function TrucksPage() {
  await requirePage('trucks');
  const response = await apiRequest('safety/trucks');
  if (!response.ok) throw new Error('Unable to load trucks');
  return <Trucks data={await readResponse<TruckList>(response, 'trucks', trucksSchema)} />;
}
