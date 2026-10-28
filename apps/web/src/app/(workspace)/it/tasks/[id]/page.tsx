import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { itDetailSchema, readResponse } from '@/lib/api-schemas';
import { ItOnboarding } from '@/features/it/onboarding';
import type { ItDetail } from '@/features/it/types';
export default async function Page({params}:{params:Promise<{id:string}>}){
 await requirePage('it');const {id}=await params;if(!/^[0-9a-f-]{36}$/.test(id))notFound();
 const response=await apiRequest(`it/onboarding/${id}`);if(response.status===404)notFound();if(!response.ok)throw new Error('Unable to load IT onboarding');
 return <ItOnboarding initial={await readResponse<ItDetail>(response,'IT onboarding request',itDetailSchema)}/>;
}
