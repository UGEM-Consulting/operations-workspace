import { apiRequest, requirePage } from '@/lib/auth';
import { PageHeader } from '@/components/workspace-ui';
import { AccountSecurity, type MfaStatus } from '@/features/auth/account-security';
export const metadata = { title: 'Account security' };
export default async function AccountSecurityPage() {
  await requirePage('security');
  const response = await apiRequest('auth/mfa');
  if (!response.ok) throw new Error('Unable to load account security');
  const status: MfaStatus = await response.json();
  return <div><PageHeader eyebrow="Your account" title="Account security" description="Protect your sign-in with a code from your phone." /><AccountSecurity status={status} /></div>;
}
