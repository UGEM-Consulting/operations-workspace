import { apiRequest, requirePage } from '@/lib/auth';
import { Invitations } from '@/features/onboarding/invitations';
export const metadata = { title: 'Invitations' };
export default async function Page() { await requirePage('invitations'); const response=await apiRequest('onboarding/invitations'); if(!response.ok)throw new Error('Unable to load invitations');return <Invitations initial={await response.json()}/>; }
