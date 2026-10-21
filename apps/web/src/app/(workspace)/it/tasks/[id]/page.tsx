import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { ItOnboarding } from '@/features/it/onboarding';
export default async function Page({params}:{params:Promise<{id:string}>}){
 await requirePage('it');const {id}=await params;if(!/^[0-9a-f-]{36}$/.test(id))notFound();
 const response=await apiRequest(`it/onboarding/${id}`);if(response.status===404)notFound();if(!response.ok)throw new Error('Unable to load IT onboarding');
 return <ItOnboarding initial={await response.json()}/>;
}
