import { apiRequest, requirePage, type StaffUser } from '@/lib/auth';
import { UserManagement } from '@/features/users/user-management';
export const metadata = { title: 'Settings' };
export default async function SettingsPage() {
  const identity = await requirePage('settings');
  const response = await apiRequest('users');
  if (!response.ok) throw new Error('Unable to load users');
  const users: StaffUser[] = await response.json();
  return <div><p className="text-xs font-semibold uppercase tracking-widest text-primary">Administration</p><h1 className="mt-3 text-3xl font-normal">Settings</h1><p className="mt-3 text-sm text-muted-foreground">Manage internal accounts and workspace access.</p><UserManagement users={users} currentUserId={identity.user.id} /></div>;
}
