import { apiRequest, requirePage } from '@/lib/auth';
import { consentListSchema, readResponse } from '@/lib/api-schemas';
import { ConsentForms, type ConsentList } from '@/features/safety/consent-forms';
export const metadata = { title: 'Consent forms' };
export default async function ConsentFormsPage() {
  await requirePage('consents');
  const response = await apiRequest('safety/consents');
  if (!response.ok) throw new Error('Unable to load consent forms');
  return <ConsentForms initial={await readResponse<ConsentList>(response, 'consent forms', consentListSchema)} />;
}
