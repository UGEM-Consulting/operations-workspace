import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { itRemovalSchema, readResponse } from '@/lib/api-schemas';
import { ItRemoval } from '@/features/it/removal';
import type { RemovalDetail } from '@/features/it/types';
export const metadata={title:'Remove access'};
export default async function Page({params}:{params:Promise<{id:string}>}){
 await requirePage('it');const {id}=await params;if(!/^[0-9a-f-]{36}$/.test(id))notFound();
 const response=await apiRequest(`it/removals/${id}`);if(response.status===404)notFound();if(!response.ok)throw new Error('Unable to load the removal request');
 return <ItRemoval initial={await readResponse<RemovalDetail>(response,'IT removal request',itRemovalSchema)}/>;
}
