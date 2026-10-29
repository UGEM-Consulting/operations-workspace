import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FilterBar } from '@/components/ui/filter-bar';
import { queueHref } from '@/lib/navigation';
import { Table } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Person } from '@/components/ui/avatar';
import { ApplicationList, ReviewSummary } from './types';
import { PageHeader } from '@/components/workspace-ui';
import { StatusBadge } from '@/components/ui/status-badge';
type ApplicationRow=ApplicationList['items'][number];
const PATH='/onboarding/applications';
/** The review inbox by default: applications waiting for a decision, oldest submission first. */
export const QUEUE_DEFAULTS:Record<string,string>={page:'1',pageSize:'20',status:'AWAITING_REVIEW',search:'',sort:'submittedAt',direction:'ASC'};
const SORTS=[{value:'submittedAt:ASC',label:'Oldest submitted first'},{value:'submittedAt:DESC',label:'Newest submitted first'},{value:'updatedAt:DESC',label:'Recently updated'},{value:'name:ASC',label:'Last name A–Z'}];

export function Applications({data,summary,filters}:{data:ApplicationList;summary:ReviewSummary|null;filters:Record<string,string>}) {
 const pageLink=(page:number)=>`${PATH}?${new URLSearchParams({...filters,page:String(page)})}`;
 const filtered=filters.search!==''||filters.status!==QUEUE_DEFAULTS.status;
 const name=(row:ApplicationRow)=>`${row.fields.firstName??''} ${row.fields.lastName??''}`.trim()||'Applicant';
 // Header sorting: the active column toggles direction; another column starts in its natural order.
 const sortBy=(field:string,natural:'ASC'|'DESC')=>({href:queueHref(PATH,filters,{sort:field,direction:filters.sort===field?(filters.direction==='ASC'?'DESC':'ASC'):natural}),
  direction:filters.sort===field?(filters.direction==='ASC'?'asc' as const:'desc' as const):undefined});
 const count=(value:number|undefined)=>summary?value:undefined;
 return <div className="space-y-6">
  <PageHeader title="Applications" description="Applications from dispatchers you invited. Correction drafts stay private until resubmitted."
   action={<Button asChild><Link href="/onboarding/invitations"><Plus aria-hidden="true" className="size-4"/>Create invitation</Link></Button>}/>
  <Card>
   <FilterBar path={PATH} filters={filters} defaults={QUEUE_DEFAULTS} searchLabel="Search name, email, MC or reference" sortOptions={SORTS} statuses={[
    {key:'AWAITING_REVIEW',label:'Awaiting review',count:count(summary?.awaitingReview)},{key:'CHANGES_REQUESTED',label:'Changes requested',count:count(summary?.changesRequested)},
    {key:'APPROVED',label:'Approved',count:count(summary?.approved)},{key:'REJECTED',label:'Rejected',count:count(summary?.rejected)},{key:'ALL',label:'All'}]}/>
   <Table caption="Dispatcher applications in your authorized scope" className="border-t border-border" rows={data.items} rowKey={row=>row.id} columns={[
    {key:'applicant',label:'Applicant',primary:true,sort:sortBy('name','ASC'),cell:row=>row.submittedAt?<Person name={name(row)} secondary={row.email}/>:<Person name={row.email||'Unclaimed invitation'} secondary="Awaiting submission" avatar={false}/>},
    {key:'employment',label:'Employment',hideBelow:'lg',cell:row=><><p>{row.mcName||'Not provided'}</p><p className="text-[13px] text-muted-foreground">Team lead: {row.teamLead||'Not provided'}</p></>},
    {key:'reference',label:'Reference',mono:true,nowrap:true,hideBelow:'xl',cell:row=><span title={row.id}>{row.id.slice(0,8)}</span>},
    {key:'submitted',label:'Submitted',nowrap:true,muted:true,hideBelow:'md',sort:sortBy('submittedAt','ASC'),cell:row=><LocalTime iso={row.submittedAt} format="date" fallback="Not yet"/>},
    {key:'status',label:'Status',cell:row=><StatusBadge status={row.status}/>},
    {key:'updated',label:'Last updated',nowrap:true,muted:true,hideBelow:'xl',sort:sortBy('updatedAt','DESC'),cell:row=><LocalTime iso={row.updatedAt} format="date"/>},
    {key:'action',label:'Action',srOnly:true,action:true,align:'right',cell:row=>row.submittedAt?<Button asChild variant="outline" size="sm"><Link href={`/onboarding/applications/${row.id}`}>Review<span className="sr-only"> {name(row)}</span></Link></Button>:<span className="whitespace-nowrap text-[13px] text-muted-foreground">Not submitted</span>},
   ]} empty={filtered
    ?<EmptyState compact title="Nothing matches these filters" description="Try another status or search." action={<Button asChild variant="outline"><Link href={PATH}>Clear filters</Link></Button>}/>
    :<EmptyState compact title="Nothing is waiting for review" description="New submissions and resubmissions appear here. See All for every application."/>}
   footer={<Pagination label="Application pages" page={data.page} pageCount={data.pageCount} pageSize={data.pageSize} total={data.total} href={pageLink}/>}/>
  </Card>
 </div>;
}
