import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { PageCrumb } from '@/components/shell-context';
import { DeletedLog, type RetentionRun } from '@/features/retention/retention';
export const metadata = { title: 'Deleted' };
export default async function RetentionDeletedPage() {
  await requirePage('retention');
  const response = await apiRequest('retention/runs');
  if (!response.ok) throw new Error('Unable to load the log');
  return <div className="space-y-6"><PageCrumb label="Deleted" /><DeletedLog runs={(await readResponse<{ items: RetentionRun[] }>(response, 'retention runs')).items} /></div>;
}
