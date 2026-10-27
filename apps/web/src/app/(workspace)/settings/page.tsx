import { apiRequest, requirePage, type StaffUser } from '@/lib/auth';
import { UserManagement } from '@/features/users/user-management';
import { MfaAdministration } from '@/features/users/mfa-administration';
import { PageHeader } from '@/components/workspace-ui';
export const metadata = { title: 'Settings' };
export default async function SettingsPage() {
  const identity = await requirePage('settings');
  const response = await apiRequest('users');
  if (!response.ok) throw new Error('Unable to load users');
  const users: StaffUser[] = await response.json();
  const security = await apiRequest('settings/security');
  if (!security.ok) throw new Error('Unable to load security settings');
  const { mfaRequiredFor }: { mfaRequiredFor: string } = await security.json();
  return <div><PageHeader eyebrow="Administration" title="Workspace settings" description="Manage internal accounts and workspace access." /><UserManagement users={users} currentUserId={identity.user.id} /><MfaAdministration users={users} currentUserId={identity.user.id} policy={mfaRequiredFor} /></div>;
}
