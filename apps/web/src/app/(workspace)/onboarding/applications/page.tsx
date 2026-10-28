import Link from 'next/link';
import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/workspace-ui';
import { Applications } from '@/features/onboarding/applications';
import type { ApplicationList } from '@/features/onboarding/types';
export const metadata = { title: 'Application review' };
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 await requirePage('applications');
 const params=await searchParams;
 const defaults:Record<string,string>={page:'1',pageSize:'20',status:'ALL',search:'',sort:'updatedAt',direction:'DESC'};
 const filters=Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,typeof params[key]==='string'?params[key]:value]));
 const response=await apiRequest(`onboarding/review-queue?${new URLSearchParams(filters)}`);
 if(response.status===400)return <div className="space-y-6"><PageHeader eyebrow="Onboarding" title="Application review" description="Review submitted applications and request corrections or make a final decision."/>
  <Alert tone="warning" title="These filters cannot be used" action={<Button asChild variant="outline" size="sm"><Link href="/onboarding/applications">Reset filters</Link></Button>}><p>Check the search length, page number and selected filters.</p></Alert></div>;
 if(!response.ok)throw new Error('Unable to load applications');
 return <Applications data={await readResponse<ApplicationList>(response,'application list')} filters={filters}/>;
}
