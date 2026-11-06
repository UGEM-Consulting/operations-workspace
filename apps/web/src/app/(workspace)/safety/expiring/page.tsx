import { apiRequest, requirePage } from '@/lib/auth';
import { dueReviewsSchema, expiringSchema, readResponse } from '@/lib/api-schemas';
import { EXPIRING_DEFAULTS, ExpiringDocuments, type DueList, type ExpiringList } from '@/features/safety/expiring-documents';
import { SCREENER_ROLES } from '@/features/safety/types';
export const metadata = { title: 'Expiring documents' };
export default async function ExpiringDocumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requirePage('expiring');
  const params = await searchParams;
  // Safety staff start on their own drivers; everyone else on all of them.
  const defaults = { ...EXPIRING_DEFAULTS, view: user.role === 'SAFETY_STAFF' ? 'mine' : 'all' };
  const filters = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof params[key] === 'string' ? params[key].slice(0, 100) : value]));
  if (!['mine', 'all'].includes(filters.view)) filters.view = defaults.view;
  const [expiring, due] = await Promise.all([apiRequest('safety/expiring'), apiRequest('safety/due')]);
  if (!expiring.ok || !due.ok) throw new Error('Unable to load expiring documents');
  const [data, reviews] = await Promise.all([readResponse<ExpiringList>(expiring, 'expiring documents', expiringSchema), readResponse<DueList>(due, 'due reviews', dueReviewsSchema)]);
  return <ExpiringDocuments data={data} reviews={reviews} meId={user.id} screener={SCREENER_ROLES.includes(user.role)} filters={filters} />;
}
