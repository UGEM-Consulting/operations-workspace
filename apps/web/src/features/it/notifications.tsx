'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Notice } from '@/components/ui/alert';
import { Badge } from '@/components/ui/status-badge';
import { mutate } from '@/lib/client-api';
import { readApi } from '@/features/onboarding/types';
import { Notifications } from './types';
export function ManagerNotifications({initial}:{initial:Notifications}){
 const [data,setData]=useState(initial),[pending,setPending]=useState<string|null>(null),[message,setMessage]=useState(''),[error,setError]=useState('');
 async function refresh(){setPending('refresh');setError('');try{setData(await readApi<Notifications>('notifications'));setMessage('Updates refreshed.');}catch{setError('Unable to refresh updates. Please try again.');}finally{setPending(null);}}
 async function read(id:string){setPending(id);setError('');try{await mutate(`notifications/${id}/read`,'POST');setData(current=>({...current,unread:Math.max(0,current.unread-1),items:current.items.map(item=>item.id===id?{...item,readAt:new Date().toISOString()}:item)}));setMessage('Notification marked as read.');}catch(error){setError(error instanceof Error?error.message:'Unable to update notification.');}finally{setPending(null);}}
 return <Card className="space-y-4 p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">IT onboarding updates</h2><p className="mt-1 text-sm text-muted-foreground">{data.unread} unread</p></div><Button variant="outline" disabled={!!pending} onClick={()=>void refresh()}>{pending==='refresh'?'Refreshing…':'Refresh updates'}</Button></div>{data.items.length?data.items.map(item=><article key={item.id} className={`space-y-3 rounded-md border p-4 ${!item.readAt?'border-info/30 bg-info-background/40':''}`}><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">IT onboarding completed · {item.displayName??'Dispatcher'}</p>{!item.readAt&&<Badge label="Unread" tone="info"/>}</div><p className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</p><div className="flex flex-wrap items-center justify-between gap-3"><Link href={`/onboarding/applications/${item.applicationId}`} className="inline-flex min-h-11 items-center text-sm text-primary underline">View application<span className="sr-only"> for {item.displayName??'dispatcher'}</span></Link>{!item.readAt&&<Button variant="outline" disabled={!!pending} onClick={()=>void read(item.id)}>{pending===item.id?'Updating…':'Mark as read'}<span className="sr-only">: {item.displayName??'dispatcher'}</span></Button>}</div></article>):<p className="text-sm text-muted-foreground">No IT completion updates yet. Refresh to check for new completions.</p>}<Notice message={message}/><Notice message={error} error/></Card>;
}
