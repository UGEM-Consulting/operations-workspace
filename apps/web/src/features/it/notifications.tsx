'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Bell, CircleCheck, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { cn } from '@/lib/utils';
import { readApi } from '@/features/onboarding/types';
import { Notifications } from './types';
/** The manager's IT completion updates on the dashboard; the bell's "See all" lands here. */
export function ManagerNotifications({initial}:{initial:Notifications}){
 const toast=useToast();
 const [data,setData]=useState(initial),[pending,setPending]=useState<string|null>(null);
 async function refresh(){setPending('refresh');try{setData(await readApi<Notifications>('notifications'));toast({title:'Updates refreshed'});}catch(error){toast({tone:'danger',title:'Updates not refreshed',description:errorMessage(error,'Please try again.')});}finally{setPending(null);}}
 async function read(id:string){setPending(id);try{await mutate(`notifications/${id}/read`,'POST');setData(current=>({...current,unread:Math.max(0,current.unread-1),items:current.items.map(item=>item.id===id?{...item,readAt:new Date().toISOString()}:item)}));}catch(error){toast({tone:'danger',title:'Notification not updated',description:errorMessage(error,'Please try again.')});}finally{setPending(null);}}
 return <Card id="updates" className="scroll-mt-20">
  <CardHeader title={<span className="flex items-center gap-2">Updates{data.unread>0&&<span className="rounded-full bg-brand-subtle px-2 text-xs font-semibold leading-5 text-brand-subtle-foreground tabular-nums">{data.unread}<span className="sr-only"> unread</span></span>}</span>}
   actions={<Button variant="ghost" size="sm" disabled={!!pending} onClick={()=>void refresh()}><RefreshCw aria-hidden="true" className="size-4"/>{pending==='refresh'?'Refreshing…':'Refresh'}</Button>}/>
  {data.items.length?<ul className="mt-3 divide-y divide-border border-t border-border">{data.items.map(item=><li key={item.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
   <span className="grid size-8 shrink-0 place-items-center rounded-full bg-success-background text-success"><CircleCheck aria-hidden="true" className="size-4"/></span>
   <div className="min-w-0 flex-1">
    <p className={cn('text-sm',!item.readAt&&'font-medium')}>IT setup completed</p>
    <p className="text-[13px] leading-5 text-muted-foreground">{item.displayName??'Dispatcher'} is ready to work.</p>
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><LocalTime iso={item.createdAt}/>
     <Link href={`/onboarding/applications/${item.applicationId}`} className="text-primary underline-offset-4 hover:underline">View application<span className="sr-only"> for {item.displayName??'dispatcher'}</span></Link>
     {!item.readAt&&<button type="button" disabled={!!pending} onClick={()=>void read(item.id)} className="text-primary underline-offset-4 hover:underline disabled:opacity-50">{pending===item.id?'Updating…':'Mark as read'}<span className="sr-only">: {item.displayName??'dispatcher'}</span></button>}</div>
   </div>
   {!item.readAt&&<span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"><span className="sr-only">Unread</span></span>}
  </li>)}</ul>:<EmptyState compact icon={Bell} title="You are all caught up" description="Completion updates from IT appear here."/>}
 </Card>;
}
