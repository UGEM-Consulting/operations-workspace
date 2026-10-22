import Link from 'next/link';
import { apiRequest, requirePage } from '@/lib/auth';
import { Invitations } from '@/features/onboarding/invitations';
export const metadata = { title: 'Invitations' };
export default async function Page() { const identity = await requirePage('invitations'); const response=await apiRequest('onboarding/invitations'); if(!response.ok)throw new Error('Unable to load invitations');return <>{identity.demoEmailEnabled && <Link href="/onboarding/demo-mailbox" className="mb-4 inline-block text-sm text-primary underline">Open demo verification codes</Link>}<Invitations initial={await response.json()}/></>; }
