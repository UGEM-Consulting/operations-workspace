import Link from 'next/link';
import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/workspace-ui';
import { Applications, QUEUE_DEFAULTS } from '@/features/onboarding/applications';
import type { ApplicationList, ReviewSummary } from '@/features/onboarding/types';
export const metadata = { title: 'Applications' };
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 await requirePage('applications');
 const params=await searchParams;
 const filters=Object.fromEntries(Object.entries(QUEUE_DEFAULTS).map(([key,value])=>[key,typeof params[key]==='string'?params[key]:value]));
 // The status tab counts cover every application in the manager's scope, like the overview page.
 const [response,summaryResponse]=await Promise.all([apiRequest(`onboarding/review-queue?${new URLSearchParams(filters)}`),apiRequest('onboarding/summary')]);
 if(response.status===400)return <div className="space-y-6"><PageHeader title="Applications" description="Applications from dispatchers you invited."/>
  <Alert tone="warning" title="These filters cannot be used" action={<Button asChild variant="outline" size="sm"><Link href="/onboarding/applications">Clear filters</Link></Button>}><p>Check the search length, page number and selected filters.</p></Alert></div>;
 if(!response.ok)throw new Error('Unable to load applications');
 const summary=summaryResponse.ok?await readResponse<ReviewSummary>(summaryResponse,'onboarding summary'):null;
 return <Applications data={await readResponse<ApplicationList>(response,'application list')} summary={summary} filters={filters}/>;
}
