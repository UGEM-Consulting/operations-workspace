import { apiRequest, requirePage, type StaffUser } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { UserManagement } from '@/features/users/user-management';
import { MfaAdministration } from '@/features/users/mfa-administration';
import { PageHeader } from '@/components/workspace-ui';
export const metadata = { title: 'Settings' };
export default async function SettingsPage() {
  const identity = await requirePage('settings');
  const [response, security] = await Promise.all([apiRequest('users'), apiRequest('settings/security')]);
  if (!response.ok) throw new Error('Unable to load users');
  if (!security.ok) throw new Error('Unable to load security settings');
  const [users, { mfaRequiredFor }] = await Promise.all([readResponse<StaffUser[]>(response, 'users'), readResponse<{ mfaRequiredFor: string }>(security, 'security settings')]);
  return <div><PageHeader eyebrow="Administration" title="Workspace settings" description="Manage internal accounts and workspace access." /><UserManagement users={users} currentUserId={identity.user.id} /><MfaAdministration users={users} currentUserId={identity.user.id} policy={mfaRequiredFor} /></div>;
}
