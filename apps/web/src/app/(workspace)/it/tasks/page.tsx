import Link from 'next/link';
import { apiRequest, requirePage } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, Progress } from '@/components/ui/feedback';
import { Alert } from '@/components/ui/alert';
import { FilterBar } from '@/components/ui/filter-bar';
import { LocalTime } from '@/components/ui/local-time';
import { itTasksSchema, readResponse } from '@/lib/api-schemas';
import { IT_TASK_DEFAULTS, middayIso, queueHref } from '@/lib/navigation';
import { Person } from '@/components/ui/avatar';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { PageHeader, StatCard } from '@/components/workspace-ui';
import type { ItTasks } from '@/features/it/types';
export const metadata={title:'IT tasks'};
const VIEWS=['open','setup','removal','scheduled','finished','all'];
/**
 * IT tasks: accounts to set up for new dispatchers and to remove when someone leaves, in one list. Removals that are due
 * come first, removals not due yet last. Each row opens its checklist.
 */
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 await requirePage('it');const params=await searchParams;
 const filters=Object.fromEntries(Object.entries({...IT_TASK_DEFAULTS,page:'1'}).map(([key,value])=>[key,typeof params[key]==='string'?params[key].slice(0,100):value]));
 if(!VIEWS.includes(filters.view))filters.view=IT_TASK_DEFAULTS.view;
 const response=await apiRequest(`it/tasks?${new URLSearchParams({...filters,pageSize:'20'})}`);
 const header=<PageHeader title="IT tasks" description="Accounts to set up for new dispatchers and to remove when someone leaves. This checklist tracks your work; it doesn’t change accounts for you." />;
 if(response.status===400)return <div className="space-y-6">{header}<Alert tone="warning" title="These filters cannot be used" action={<Button asChild variant="outline" size="sm"><Link href="/it/tasks">Reset filters</Link></Button>}><p>Check the search length and page number.</p></Alert></div>;
 if(!response.ok)throw new Error('Unable to load IT tasks');const data=await readResponse<ItTasks>(response,'IT tasks',itTasksSchema);
 const {stats}=data,filtered=filters.search!==''||filters.view!==IT_TASK_DEFAULTS.view;
 const href=(view:string)=>queueHref('/it/tasks',filters,{view});
 return <div className="space-y-6">{header}
 <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
  <StatCard label="Removals due" value={stats.removalsDue} detail={stats.removalsDue?'Due today or earlier':'Nothing due'} href={href('removal')} tone="danger"/>
  <StatCard label="Scheduled removals" value={stats.scheduled} detail={stats.nextScheduled?<>Next: <LocalTime iso={middayIso(stats.nextScheduled)} format="date"/></>:'None coming up'} href={href('scheduled')} tone="info"/>
  <StatCard label="Setups waiting" value={stats.setupsWaiting} detail="Not started yet" href={href('setup')} tone="neutral"/>
  <StatCard label="Blocked" value={stats.blocked} detail="Waiting on someone else" href={href('open')} tone="warning"/>
 </div>
 <Card>
  <FilterBar path="/it/tasks" filters={filters} defaults={IT_TASK_DEFAULTS} statusKey="view" searchLabel="Search name, email or MC" statuses={[
   {key:'open',label:'Open',count:stats.open},{key:'setup',label:'Setup',count:stats.setup},{key:'removal',label:'Removal',count:stats.removal},{key:'scheduled',label:'Scheduled',count:stats.scheduled},
   {key:'finished',label:'Finished',count:stats.finished},{key:'all',label:'All',count:stats.all}]}/>
  <Table caption="IT tasks" className="border-t border-border" rows={data.items} rowKey={task=>`${task.kind}-${task.id}`} columns={[
   {key:'person',label:'Person',primary:true,cell:task=><Link href={task.kind==='REMOVAL'?`/it/tasks/removals/${task.id}`:`/it/tasks/${task.id}`} className="block rounded-sm hover:underline focus-visible:outline-2"><Person name={task.name??'Dispatcher'} secondary={task.email??undefined}/></Link>},
   {key:'kind',label:'Task',cell:task=><Badge label={task.kind==='REMOVAL'?'Removal':'Setup'} tone={task.kind==='REMOVAL'?'danger':'info'}/>},
   {key:'mc',label:'MC',hideBelow:'lg',cell:task=>task.mc??<span className="text-muted-foreground">Independent</span>},
   {key:'progress',label:'Progress',hideBelow:'md',cell:task=><Progress compact className="w-40" label={`${task.kind==='REMOVAL'?'Removal':'Setup'} for ${task.name??'dispatcher'}`} value={task.done} max={task.total}/>},
   {key:'status',label:'Status',cell:task=>task.scheduled?<Badge label="Scheduled" tone="info"/>:<StatusBadge status={task.status}/>},
   {key:'when',label:'Due or updated',nowrap:true,muted:true,cell:task=>task.kind==='REMOVAL'&&!task.completedAt&&task.dueOn?<>{task.scheduled?'Remove':'Due'} <LocalTime iso={middayIso(task.dueOn)} format="date"/></>:task.completedAt?<>Finished <LocalTime iso={task.completedAt} format="date"/></>:<>Updated <LocalTime iso={task.updatedAt} format="date"/></>},
  ]} empty={<EmptyState compact title={filtered?'Nothing matches these filters':'Nothing waiting for IT'} description={filtered?'Try another view or search.':'Approvals add setups and dispatchers who leave add removals here.'}/>}
  footer={<Pagination label="IT task pages" page={data.page} pageCount={data.pageCount} pageSize={data.pageSize} total={data.total} href={page=>queueHref('/it/tasks',filters,{page:String(page)})}/>}/>
 </Card>
 <p className="text-xs text-muted-foreground">All checklist updates are manual records; this workspace does not create or remove external accounts.</p></div>;
}
