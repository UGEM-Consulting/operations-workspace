import { apiRequest, requirePage } from '@/lib/auth';
import { existingOptionsSchema, readResponse } from '@/lib/api-schemas';
import { PageHeader } from '@/components/workspace-ui';
import { PageCrumb } from '@/components/shell-context';
import { AddExisting, type ExistingOptions } from '@/features/dispatch/add-existing';
export const metadata = { title: 'Add existing dispatchers' };
/** Dispatch › Dispatchers › Add existing dispatchers: people already working here, from a CSV or one at a time. */
export default async function AddExistingPage() {
  await requirePage('dispatchers');
  const response = await apiRequest('dispatch/existing/options');
  if (!response.ok) throw new Error('Unable to load the lists');
  const options = await readResponse<ExistingOptions>(response, 'lists', existingOptionsSchema);
  return <div className="space-y-6">
    <PageCrumb label="Add existing dispatchers" />
    <PageHeader title="Add existing dispatchers" description="For people already working here. They become Active straight away, with no application and no IT setup, and nobody is messaged." />
    <AddExisting options={options} />
  </div>;
}
