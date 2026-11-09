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
import { SignInTaskButton } from '@/features/it/sign-in-task';
export const metadata={title:'IT tasks'};
const VIEWS=['open','setup','signin','removal','scheduled','finished','all'];
// What a team lead sign-in's dialog needs from its row.
const signInTask=(task:ItTasks['items'][number])=>({id:task.id,signIn:task.signIn??'CREATE',name:task.name??'Dispatcher',email:task.email,team:task.team??null,mc:task.mc});
/**
 * IT tasks: accounts to set up for new dispatchers and to remove when someone leaves, in one list. Removals that are due
 * come first, removals not due yet last. Each row opens its checklist.
 */
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 await requirePage('it');const params=await searchParams;
 const filters=Object.fromEntries(Object.entries({...IT_TASK_DEFAULTS,page:'1'}).map(([key,value])=>[key,typeof params[key]==='string'?params[key].slice(0,100):value]));
 if(!VIEWS.includes(filters.view))filters.view=IT_TASK_DEFAULTS.view;
 const query=new URLSearchParams({...filters,pageSize:'20',signIns:'1'});let response=await apiRequest(`it/tasks?${query}`);
 // An older API refuses signIns, so the page asks again without it (no Sign-ins rows) until the API is updated.
 if(response.status===400){query.delete('signIns');if(filters.view==='signin')query.set('view',IT_TASK_DEFAULTS.view);const older=await apiRequest(`it/tasks?${query}`);if(older.ok){response=older;filters.view=query.get('view')??IT_TASK_DEFAULTS.view;}}
 const header=<PageHeader title="IT tasks" description="Accounts to set up for new dispatchers, sign-ins for team leads, and accounts to remove when someone leaves." />;
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
   {key:'open',label:'Open',count:stats.open},{key:'setup',label:'Setup',count:stats.setup},{key:'signin',label:'Sign-ins',count:stats.signIns??0},{key:'removal',label:'Removal',count:stats.removal},{key:'scheduled',label:'Scheduled',count:stats.scheduled},
   {key:'finished',label:'Finished',count:stats.finished},{key:'all',label:'All',count:stats.all}]}/>
  <Table caption="IT tasks" className="border-t border-border" rows={data.items} rowKey={task=>`${task.kind}-${task.id}`} columns={[
   {key:'person',label:'Person',primary:true,cell:task=>task.kind==='SIGN_IN'?<div className="space-y-2"><Person name={task.name??'Dispatcher'} secondary={task.signIn==='TURN_OFF'?'No longer a team lead':task.signIn==='TURN_ON'?`Team lead again${task.team?`, ${task.team}`:''}`:`New team lead${task.team?`, ${task.team}`:''}`}/>
    {/* Phones hide the Progress column, so the step's button sits under the name there. */}
    {!task.completedAt&&<div className="md:hidden"><SignInTaskButton task={signInTask(task)}/></div>}</div>:<Link href={task.kind==='REMOVAL'?`/it/tasks/removals/${task.id}`:`/it/tasks/${task.id}`} className="block rounded-sm hover:underline focus-visible:outline-2"><Person name={task.name??'Dispatcher'} secondary={task.email??undefined}/></Link>},
   {key:'kind',label:'Task',cell:task=><Badge label={task.kind==='REMOVAL'?'Removal':task.kind==='SIGN_IN'?'Sign-in':'Setup'} tone={task.kind==='REMOVAL'||task.signIn==='TURN_OFF'?'danger':'info'}/>},
   // Snapshots keep what they said: a removal recorded before 2026-11-09 left the MC empty for Independent; later ones say No MC yet.
   {key:'mc',label:'MC',hideBelow:'lg',cell:task=>task.mc??<span className="text-muted-foreground">Independent</span>},
   {key:'progress',label:'Progress',hideBelow:'md',cell:task=>task.kind==='SIGN_IN'?(task.completedAt?<span className="text-muted-foreground">Done</span>:<SignInTaskButton task={signInTask(task)}/>):<Progress compact className="w-40" label={`${task.kind==='REMOVAL'?'Removal':'Setup'} for ${task.name??'dispatcher'}`} value={task.done} max={task.total}/>},
   {key:'status',label:'Status',cell:task=>task.scheduled?<Badge label="Scheduled" tone="info"/>:<StatusBadge status={task.status}/>},
   {key:'when',label:'Due or updated',nowrap:true,muted:true,cell:task=>task.kind==='REMOVAL'&&!task.completedAt&&task.dueOn?<>{task.scheduled?'Remove':'Due'} <LocalTime iso={middayIso(task.dueOn)} format="date"/></>:task.completedAt?<>Finished <LocalTime iso={task.completedAt} format="date"/></>:task.kind==='SIGN_IN'?<>Asked <LocalTime iso={task.updatedAt} format="date"/></>:<>Updated <LocalTime iso={task.updatedAt} format="date"/></>},
  ]} empty={<EmptyState compact title={filtered?'Nothing matches these filters':'Nothing waiting for IT'} description={filtered?'Try another view or search.':'Approvals add setups, new team leads add sign-ins, and dispatchers who leave add removals here.'}/>}
  footer={<Pagination label="IT task pages" page={data.page} pageCount={data.pageCount} pageSize={data.pageSize} total={data.total} href={page=>queueHref('/it/tasks',filters,{page:String(page)})}/>}/>
 </Card>
 <p className="text-xs text-muted-foreground">All checklist updates are manual records; this workspace does not create or remove external accounts.</p></div>;
}
