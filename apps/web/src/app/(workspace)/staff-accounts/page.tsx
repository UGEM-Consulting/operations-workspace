import { apiRequest, requirePage, type StaffUser } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { USER_DEFAULTS } from '@/lib/navigation';
import { UserManagement } from '@/features/users/user-management';
export const metadata = { title: 'Staff accounts' };
export default async function StaffAccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requirePage('users');
  const params = await searchParams;
  const filters = Object.fromEntries(Object.entries(USER_DEFAULTS).map(([key, value]) => [key, typeof params[key] === 'string' ? params[key].slice(0, 100) : value]));
  const response = await apiRequest('users');
  if (!response.ok) throw new Error('Unable to load users');
  return <UserManagement page users={await readResponse<StaffUser[]>(response, 'users')} currentUserId={identity.user.id} filters={filters} />;
}
