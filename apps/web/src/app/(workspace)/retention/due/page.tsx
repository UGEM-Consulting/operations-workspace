import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { PageCrumb } from '@/components/shell-context';
import { DueRecords, type DueList } from '@/features/retention/retention';
export const metadata = { title: 'Due to be deleted' };
export default async function RetentionDuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('retention');
  const { page } = await searchParams, number = typeof page === 'string' && /^\d{1,4}$/.test(page) ? Number(page) || 1 : 1;
  const response = await apiRequest(`retention/due?page=${number}`);
  if (!response.ok) throw new Error('Unable to load what is due');
  return <div className="space-y-6"><PageCrumb label="Due" /><DueRecords data={await readResponse<DueList>(response, 'due records')} /></div>;
}
