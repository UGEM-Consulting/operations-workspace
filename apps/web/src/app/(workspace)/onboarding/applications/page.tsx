import Link from 'next/link';
import { apiRequest, requirePage } from '@/lib/auth';
import { Applications } from '@/features/onboarding/applications';
export const metadata = { title: 'Application review' };
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 await requirePage('applications');
 const params=await searchParams;
 const defaults:Record<string,string>={page:'1',pageSize:'20',status:'ALL',search:'',sort:'updatedAt',direction:'DESC'};
 const filters=Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,typeof params[key]==='string'?params[key]:value]));
 const response=await apiRequest(`onboarding/review-queue?${new URLSearchParams(filters)}`);
 if(response.status===400)return <div className="space-y-4"><h1 className="text-xl font-normal">Invalid filters</h1><p>Check the search length, page number and selected filters.</p><Link className="underline" href="/onboarding/applications">Reset filters</Link></div>;
 if(!response.ok)throw new Error('Unable to load applications');
 return <Applications data={await response.json()} filters={filters}/>;
}
