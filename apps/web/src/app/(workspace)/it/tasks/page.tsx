import Link from 'next/link';
import { apiRequest, requirePage } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { statusLabel } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { inputClass } from '@/features/onboarding/types';
import { ItQueue, ProgressBadge, taskStatuses } from '@/features/it/types';
export const metadata={title:'IT onboarding'};
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 await requirePage('it');const params=await searchParams;
 const filters=Object.fromEntries(Object.entries({page:'1',pageSize:'20',status:'ALL',search:''}).map(([key,value])=>[key,typeof params[key]==='string'?params[key]:value]));
 const response=await apiRequest(`it/onboarding?${new URLSearchParams(filters)}`);
 if(response.status===400)return <div className="space-y-4"><p>Invalid queue filters.</p><Link href="/it/tasks" className="underline">Reset filters</Link></div>;
 if(!response.ok)throw new Error('Unable to load IT onboarding requests');const data:ItQueue=await response.json();
 const pageLink=(page:number)=>`/it/tasks?${new URLSearchParams({...filters,page:String(page)})}`;
 return <div className="space-y-7"><PageHeader eyebrow="IT & access" title="IT onboarding" description="Approved dispatchers ready for the manual setup checklist." />
 <Card className="p-5"><form action="/it/tasks" className="grid items-end gap-4 sm:grid-cols-3"><label className="text-sm">Search<input name="search" defaultValue={filters.search} maxLength={100} placeholder="American name, email or MC" className={inputClass}/></label><label className="text-sm">Status<select name="status" defaultValue={filters.status} className={inputClass}><option value="ALL">All statuses</option>{taskStatuses.map(status=><option key={status} value={status}>{statusLabel(status)}</option>)}</select></label><div className="flex flex-wrap items-center gap-3"><Button>Filter requests</Button><Link href="/it/tasks" className="inline-flex min-h-11 items-center text-sm underline">Reset</Link></div></form></Card>
 <p className="text-sm text-muted-foreground">{data.total} request{data.total===1?'':'s'}</p>
 {data.items.map(request=><Card key={request.id} className="flex flex-wrap items-center justify-between gap-4 p-5"><div><Link className="font-semibold text-primary underline" href={`/it/tasks/${request.id}`}>{request.profile.proposedDisplayName??'Approved dispatcher'}</Link><p className="mt-1 text-sm text-muted-foreground">{request.profile.jobTitle} · {request.profile.mcName} · {request.profile.teamLead}</p><p className="mt-2 text-xs text-muted-foreground">Updated {new Date(request.updatedAt).toLocaleDateString()}</p></div><ProgressBadge status={request.status}/></Card>)}
 {!data.items.length&&<Card className="p-10 text-center text-muted-foreground">No matching IT requests. Try another search or reset filters. New manager approvals create requests automatically.</Card>}
 <nav aria-label="IT queue pagination" className="flex justify-between gap-4 text-sm"><span>Page {data.page} of {Math.max(1,data.pageCount)}</span><div className="flex gap-4">{data.page>1&&<Link className="inline-flex min-h-11 items-center underline" href={pageLink(data.page-1)}>Previous</Link>}{data.page<data.pageCount&&<Link className="inline-flex min-h-11 items-center underline" href={pageLink(data.page+1)}>Next</Link>}</div></nav>
 <p className="text-xs text-muted-foreground">All checklist updates are manual records; this portal does not create external accounts.</p></div>;
}
