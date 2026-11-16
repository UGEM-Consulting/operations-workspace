import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { PageCrumb } from '@/components/shell-context';
import { RetentionSchedule, type RetentionOverview } from '@/features/retention/retention';
export const metadata = { title: 'Keeping records' };
/** Admin › Keeping records (section 34): how long each kind of record is kept, and whether deleting is on. Administrators only. */
export default async function RetentionPage() {
  await requirePage('retention');
  const response = await apiRequest('retention');
  if (!response.ok) throw new Error('Unable to load the schedule');
  return <div className="space-y-6"><PageCrumb label="Keeping records" /><RetentionSchedule data={await readResponse<RetentionOverview>(response, 'retention')} /></div>;
}
