import Link from 'next/link';
import { apiRequest, requirePage, type StaffUser } from '@/lib/auth';
import { UserManagement } from '@/features/users/user-management';
import { PageHeader } from '@/components/workspace-ui';
export const metadata = { title: 'Settings' };
export default async function SettingsPage() {
  const identity = await requirePage('settings');
  const response = await apiRequest('users');
  if (!response.ok) throw new Error('Unable to load users');
  const users: StaffUser[] = await response.json();
  return <div><PageHeader eyebrow="Administration" title="Workspace settings" description="Manage internal accounts and workspace access." />{identity.demoEmailEnabled && <Link href="/settings/demo-mailbox" className="mt-4 inline-block text-sm text-primary underline">Open demo mailbox</Link>}<UserManagement users={users} currentUserId={identity.user.id} /></div>;
}
