import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { Invitations } from '@/features/onboarding/invitations';
import type { Invitation } from '@/features/onboarding/types';
export const metadata = { title: 'Invitations' };
export default async function Page() { await requirePage('invitations'); const response=await apiRequest('onboarding/invitations'); if(!response.ok)throw new Error('Unable to load invitations');return <Invitations initial={await readResponse<Invitation[]>(response,'invitations')}/>; }
