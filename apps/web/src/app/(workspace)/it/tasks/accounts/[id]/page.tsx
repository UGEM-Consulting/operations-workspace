import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { itAccountRequestSchema, readResponse } from '@/lib/api-schemas';
import { ItAccountRequestView, type AccountRequestDetail } from '@/features/it/accounts';
export const metadata={title:'Company accounts'};
/** IT's checklist for a request about company accounts (section 33). */
export default async function Page({params}:{params:Promise<{id:string}>}){
 await requirePage('it');const {id}=await params;if(!/^[0-9a-f-]{36}$/.test(id))notFound();
 const response=await apiRequest(`it/accounts/${id}`);if(response.status===404)notFound();if(!response.ok)throw new Error('Unable to load the request');
 return <ItAccountRequestView initial={await readResponse<AccountRequestDetail>(response,'IT account request',itAccountRequestSchema)}/>;
}
