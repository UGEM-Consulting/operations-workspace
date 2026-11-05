import { apiRequest, requirePage } from '@/lib/auth';
import { expiringSchema, readResponse } from '@/lib/api-schemas';
import { ExpiringDocuments, type ExpiringList } from '@/features/safety/expiring-documents';
export const metadata = { title: 'Expiring documents' };
export default async function ExpiringDocumentsPage() {
  await requirePage('expiring');
  const response = await apiRequest('safety/expiring');
  if (!response.ok) throw new Error('Unable to load expiring documents');
  return <ExpiringDocuments data={await readResponse<ExpiringList>(response, 'expiring documents', expiringSchema)} />;
}
