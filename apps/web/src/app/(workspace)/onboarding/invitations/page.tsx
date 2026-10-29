import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { Invitations } from '@/features/onboarding/invitations';
import { INVITATION_DEFAULTS } from '@/lib/navigation';
import type { Invitation } from '@/features/onboarding/types';
export const metadata = { title: 'Invitations' };
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 await requirePage('invitations');
 const params=await searchParams;
 const filters=Object.fromEntries(Object.entries(INVITATION_DEFAULTS).map(([key,value])=>[key,typeof params[key]==='string'?params[key].slice(0,100):value]));
 const response=await apiRequest('onboarding/invitations');
 if(!response.ok)throw new Error('Unable to load invitations');
 return <Invitations initial={await readResponse<Invitation[]>(response,'invitations')} filters={filters}/>;
}
