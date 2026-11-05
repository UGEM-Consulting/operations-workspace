import { apiRequest, requirePage } from '@/lib/auth';
import { dueReviewsSchema, expiringSchema, readResponse } from '@/lib/api-schemas';
import { ExpiringDocuments, type DueList, type ExpiringList } from '@/features/safety/expiring-documents';
export const metadata = { title: 'Expiring documents' };
export default async function ExpiringDocumentsPage() {
  await requirePage('expiring');
  const [expiring, due] = await Promise.all([apiRequest('safety/expiring'), apiRequest('safety/due')]);
  if (!expiring.ok || !due.ok) throw new Error('Unable to load expiring documents');
  const [data, reviews] = await Promise.all([readResponse<ExpiringList>(expiring, 'expiring documents', expiringSchema), readResponse<DueList>(due, 'due reviews', dueReviewsSchema)]);
  return <ExpiringDocuments data={data} reviews={reviews} />;
}
