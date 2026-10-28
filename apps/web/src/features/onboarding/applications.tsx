import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Table } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Person } from '@/components/ui/avatar';
import { ApplicationList, applicationStatuses } from './types';
import { PageHeader } from '@/components/workspace-ui';
import { StatusBadge, statusLabel } from '@/components/ui/status-badge';
type ApplicationRow=ApplicationList['items'][number];
export function Applications({data,filters}:{data:ApplicationList;filters:Record<string,string>}) {
 const pageLink=(page:number)=>`/onboarding/applications?${new URLSearchParams({...filters,page:String(page)})}`;
 const filtered=filters.search||filters.status!=='ALL';
 const name=(row:ApplicationRow)=>row.submittedAt?`${row.fields.firstName??''} ${row.fields.lastName??''}`.trim():'Awaiting submission';
 return <div className="space-y-6">
  <PageHeader eyebrow="Onboarding" title="Application review" description="Review submitted applications and request corrections or make a final decision. Correction drafts stay private until resubmitted."/>
  <Card className="p-4 sm:p-5"><form action="/onboarding/applications" className="flex flex-wrap items-end gap-4">
   <Input label="Search" name="search" type="search" defaultValue={filters.search} placeholder="Name, email, MC, team lead or reference" maxLength={100} width="md"/>
   <Select label="Status" name="status" defaultValue={filters.status} width="sm" options={[{value:'ALL',label:'All statuses'},{value:'AWAITING_REVIEW',label:'Awaiting review'},...applicationStatuses.map(status=>({value:status,label:statusLabel(status)}))]}/>
   <Select label="Sort by" name="sort" defaultValue={filters.sort} width="sm" options={[{value:'updatedAt',label:'Last updated'},{value:'submittedAt',label:'Submission date'},{value:'name',label:'Last name'},{value:'status',label:'Status'}]}/>
   <Select label="Direction" name="direction" defaultValue={filters.direction} width="sm" options={[{value:'DESC',label:'Descending'},{value:'ASC',label:'Ascending'}]}/>
   <Select label="Per page" name="pageSize" defaultValue={filters.pageSize} width="xs" options={['10','20','50']}/>
   <div className="flex items-center gap-3"><Button>Apply filters</Button><Button asChild variant="ghost"><Link href="/onboarding/applications">Reset</Link></Button></div>
  </form></Card>
  <Card>
   <Table caption="Dispatcher applications in your authorized scope" rows={data.items} rowKey={row=>row.id} columns={[
    {key:'applicant',label:'Applicant',primary:true,cell:row=>row.submittedAt?<Person name={name(row)} secondary={row.email}/>:<Person name={row.email||'Unclaimed invitation'} secondary="Awaiting submission" avatar={false}/>},
    {key:'employment',label:'Employment',hideBelow:'lg',cell:row=><><p>{row.mcName||'Not provided'}</p><p className="text-[13px] text-muted-foreground">Team lead: {row.teamLead||'Not provided'}</p></>},
    {key:'submitted',label:'Submitted',nowrap:true,muted:true,hideBelow:'md',cell:row=><LocalTime iso={row.submittedAt} format="date"/>},
    {key:'status',label:'Status',cell:row=><StatusBadge status={row.status}/>},
    {key:'updated',label:'Last updated',nowrap:true,muted:true,hideBelow:'xl',cell:row=><LocalTime iso={row.updatedAt} format="date"/>},
    {key:'action',label:'Action',srOnly:true,action:true,align:'right',cell:row=>row.submittedAt?<Button asChild variant="outline" size="sm"><Link href={`/onboarding/applications/${row.id}`}>Review<span className="sr-only"> {name(row)}</span></Link></Button>:<span className="text-[13px] text-muted-foreground">Not submitted</span>},
   ]} empty={<EmptyState compact title={filtered?'No matching applications':'No applications yet'} description={filtered?'Try another search or reset filters to see all applications in your scope.':'Applications appear here once applicants start their invitations.'} action={filtered&&<Button asChild variant="outline"><Link href="/onboarding/applications">Reset filters</Link></Button>}/>}
   footer={<Pagination label="Application pages" page={data.page} pageCount={data.pageCount} pageSize={data.pageSize} total={data.total} href={pageLink}/>}/>
  </Card>
 </div>;
}
