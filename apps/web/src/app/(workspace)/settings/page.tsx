import { apiRequest, requirePage, type StaffUser } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { UserManagement } from '@/features/users/user-management';
import { USER_DEFAULTS } from '@/lib/navigation';
import { MfaAdministration } from '@/features/users/mfa-administration';
import { PageHeader } from '@/components/workspace-ui';
export const metadata = { title: 'Settings' };
export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requirePage('settings');
  const params = await searchParams;
  const filters = Object.fromEntries(Object.entries(USER_DEFAULTS).map(([key, value]) => [key, typeof params[key] === 'string' ? params[key].slice(0, 100) : value]));
  const [response, security] = await Promise.all([apiRequest('users'), apiRequest('settings/security')]);
  if (!response.ok) throw new Error('Unable to load users');
  if (!security.ok) throw new Error('Unable to load security settings');
  const [users, { mfaRequiredFor }] = await Promise.all([readResponse<StaffUser[]>(response, 'users'), readResponse<{ mfaRequiredFor: string }>(security, 'security settings')]);
  // Staff accounts has its own page; an older API without that navigation item still gets the list here.
  const separate = identity.navigation.some(item => item.key === 'users');
  return <div><PageHeader title="Settings" description="Workspace-wide security settings." />{!separate && <UserManagement users={users} currentUserId={identity.user.id} filters={filters} />}<MfaAdministration users={users} currentUserId={identity.user.id} policy={mfaRequiredFor} /></div>;
}
