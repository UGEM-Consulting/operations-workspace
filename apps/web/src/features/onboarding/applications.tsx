import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ApplicationList, applicationStatuses, inputClass } from './types';
import { StatusBadge } from './status-badge';
export function Applications({data,filters}:{data:ApplicationList;filters:Record<string,string>}) {
 const pageLink=(page:number)=>`/onboarding/applications?${new URLSearchParams({...filters,page:String(page)})}`;
 return <div className="space-y-6">
  <div><h1 className="text-2xl font-semibold">Application review</h1><p className="mt-2 text-muted-foreground">Review submissions in your scope. Correction drafts stay private until resubmitted.</p></div>
  <Card className="p-5"><form action="/onboarding/applications" className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-5">
   <label className="text-sm lg:col-span-2">Search<input name="search" defaultValue={filters.search} placeholder="Name, email, MC, team lead or reference" maxLength={100} className={inputClass}/></label>
   <label className="text-sm">Status<select name="status" defaultValue={filters.status} className={inputClass}><option value="ALL">All statuses</option><option value="AWAITING_REVIEW">Awaiting review</option>{applicationStatuses.map(status=><option key={status} value={status}>{status.replaceAll('_',' ')}</option>)}</select></label>
   <label className="text-sm">Sort by<select name="sort" defaultValue={filters.sort} className={inputClass}><option value="updatedAt">Last updated</option><option value="submittedAt">Submission date</option><option value="name">Last name</option><option value="status">Status</option></select></label>
   <label className="text-sm">Direction<select name="direction" defaultValue={filters.direction} className={inputClass}><option value="DESC">Descending</option><option value="ASC">Ascending</option></select></label>
   <label className="text-sm">Per page<select name="pageSize" defaultValue={filters.pageSize} className={inputClass}>{[10,20,50].map(size=><option key={size}>{size}</option>)}</select></label>
   <div className="flex items-center gap-3"><Button>Apply filters</Button><Link href="/onboarding/applications" className="text-sm underline">Reset</Link></div>
  </form></Card>
  <p className="text-sm text-muted-foreground">{data.total} matching application{data.total===1?'':'s'}</p>
  {data.items.length ? <Card className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Dispatcher applications in your authorized scope</caption><thead className="border-b border-border bg-accent/50"><tr>{['Applicant','Employment','Submitted','Status','Last updated','Action'].map(label=><th key={label} scope="col" className="px-5 py-4 font-medium">{label}</th>)}</tr></thead><tbody>{data.items.map(row=><tr key={row.id} className="border-b border-border last:border-0">
   <td className="px-5 py-4"><p className="font-medium">{row.submittedAt?`${row.fields.firstName??''} ${row.fields.lastName??''}`:'Awaiting submission'}</p><p className="mt-1 text-muted-foreground">{row.email}</p></td>
   <td className="px-5 py-4"><p>{row.mcName}</p><p className="mt-1 text-xs text-muted-foreground">Team lead: {row.teamLead}</p></td>
   <td className="whitespace-nowrap px-5 py-4">{row.submittedAt?new Date(row.submittedAt).toLocaleDateString():'—'}</td>
   <td className="px-5 py-4"><StatusBadge status={row.status}/></td><td className="whitespace-nowrap px-5 py-4">{new Date(row.updatedAt).toLocaleDateString()}</td>
   <td className="px-5 py-4">{row.submittedAt?<Link href={`/onboarding/applications/${row.id}`} className="font-medium text-primary underline">Review details</Link>:<span className="text-muted-foreground">Not submitted</span>}</td>
  </tr>)}</tbody></table></Card>:<Card className="p-10 text-center text-muted-foreground">No applications match these filters.</Card>}
  <nav aria-label="Application pagination" className="flex items-center justify-between gap-4"><span className="text-sm">Page {data.page} of {Math.max(data.pageCount,1)}</span><div className="flex gap-4">{data.page>1&&<Link className="text-sm text-primary underline" href={pageLink(data.page-1)}>Previous</Link>}{data.page<data.pageCount&&<Link className="text-sm text-primary underline" href={pageLink(data.page+1)}>Next</Link>}</div></nav>
 </div>;
}
