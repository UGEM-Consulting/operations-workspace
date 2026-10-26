import { apiRequest, requirePage } from '@/lib/auth';
import { CompanyDocuments } from '@/features/onboarding/company-documents';
export const metadata = { title: 'Documents' };
export default async function Page() { await requirePage('documents'); const response=await apiRequest('documents'); if(!response.ok)throw new Error('Unable to load documents');return <CompanyDocuments initial={await response.json()}/>; }
