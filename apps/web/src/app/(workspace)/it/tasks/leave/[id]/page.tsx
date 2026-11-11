import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { itLeaveSchema, readResponse } from '@/lib/api-schemas';
import { ItLeave } from '@/features/it/leave';
import type { LeaveDetail } from '@/features/it/types';
export const metadata={title:'Leave'};
export default async function Page({params}:{params:Promise<{id:string}>}){
 await requirePage('it');const {id}=await params;if(!/^[0-9a-f-]{36}$/.test(id))notFound();
 const response=await apiRequest(`it/leave/${id}`);if(response.status===404)notFound();if(!response.ok)throw new Error('Unable to load the leave checklist');
 return <ItLeave initial={await readResponse<LeaveDetail>(response,'IT leave checklist',itLeaveSchema)}/>;
}
