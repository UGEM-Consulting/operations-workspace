import Link from 'next/link';
import { apiRequest, requirePage } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Table } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState } from '@/components/ui/feedback';
import { Alert } from '@/components/ui/alert';
import { LocalTime } from '@/components/ui/local-time';
import { readResponse } from '@/lib/api-schemas';
import { Person } from '@/components/ui/avatar';
import { StatusBadge, statusLabel } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { ItQueue, taskStatuses } from '@/features/it/types';
export const metadata={title:'IT onboarding'};
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 await requirePage('it');const params=await searchParams;
 const filters=Object.fromEntries(Object.entries({page:'1',pageSize:'20',status:'ALL',search:''}).map(([key,value])=>[key,typeof params[key]==='string'?params[key]:value]));
 const response=await apiRequest(`it/onboarding?${new URLSearchParams(filters)}`);
 const header=<PageHeader eyebrow="IT & access" title="IT onboarding" description="Approved dispatchers ready for the manual setup checklist." />;
 if(response.status===400)return <div className="space-y-6">{header}<Alert tone="warning" title="These filters cannot be used" action={<Button asChild variant="outline" size="sm"><Link href="/it/tasks">Reset filters</Link></Button>}><p>Check the search length, page number and selected status.</p></Alert></div>;
 if(!response.ok)throw new Error('Unable to load IT onboarding requests');const data=await readResponse<ItQueue>(response,'IT queue');
 const pageLink=(page:number)=>`/it/tasks?${new URLSearchParams({...filters,page:String(page)})}`;
 const filtered=filters.search||filters.status!=='ALL';
 return <div className="space-y-6">{header}
 <Card className="p-4 sm:p-5"><form action="/it/tasks" className="flex flex-wrap items-end gap-4"><Input label="Search" name="search" type="search" defaultValue={filters.search} maxLength={100} placeholder="American name, email or MC" width="md"/><Select label="Status" name="status" defaultValue={filters.status} width="sm" options={[{value:'ALL',label:'All statuses'},...taskStatuses.map(status=>({value:status,label:statusLabel(status)}))]}/><div className="flex flex-wrap items-center gap-3"><Button>Filter requests</Button><Button asChild variant="ghost"><Link href="/it/tasks">Reset</Link></Button></div></form></Card>
 <Card><Table caption="Approved dispatchers waiting for IT setup" rows={data.items} rowKey={request=>request.id} columns={[
  {key:'person',label:'Dispatcher',primary:true,cell:request=><Person name={request.profile.proposedDisplayName??'Approved dispatcher'} secondary={request.profile.personalEmail??undefined}/>},
  {key:'employment',label:'Employment',hideBelow:'lg',cell:request=><><p>{request.profile.jobTitle}</p><p className="text-[13px] text-muted-foreground">{request.profile.mcName} · {request.profile.teamLead}</p></>},
  {key:'status',label:'Status',cell:request=><StatusBadge status={request.status}/>},
  {key:'updated',label:'Updated',nowrap:true,muted:true,hideBelow:'md',cell:request=><LocalTime iso={request.updatedAt} format="date"/>},
  {key:'action',label:'Action',srOnly:true,action:true,align:'right',cell:request=><Button asChild variant="outline" size="sm"><Link href={`/it/tasks/${request.id}`}>Open<span className="sr-only"> {request.profile.proposedDisplayName??'request'}</span></Link></Button>},
 ]} empty={<EmptyState compact title={filtered?'No matching IT requests':'No IT requests yet'} description={filtered?'Try another search or reset filters.':'New manager approvals create requests automatically.'} action={filtered&&<Button asChild variant="outline"><Link href="/it/tasks">Reset filters</Link></Button>}/>}
 footer={<Pagination label="IT request pages" page={data.page} pageCount={data.pageCount} pageSize={data.pageSize} total={data.total} href={pageLink}/>}/></Card>
 <p className="text-xs text-muted-foreground">All checklist updates are manual records; this portal does not create external accounts.</p></div>;
}
