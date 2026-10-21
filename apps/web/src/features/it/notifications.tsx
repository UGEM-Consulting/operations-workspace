'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { mutate } from '@/lib/client-api';
import { readApi } from '@/features/onboarding/types';
import { Notifications } from './types';
export function ManagerNotifications({initial}:{initial:Notifications}){
 const [data,setData]=useState(initial),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 async function read(id:string){setBusy(true);try{await mutate(`notifications/${id}/read`,'POST');setData(await readApi<Notifications>('notifications'));setMessage('Notification marked as read.');}catch(error){setMessage(error instanceof Error?error.message:'Unable to update notification.');}finally{setBusy(false);}}
 return <Card className="space-y-4 p-6"><div className="flex flex-wrap justify-between gap-3"><h2 className="font-semibold">IT onboarding updates</h2><span className="text-sm text-muted-foreground">{data.unread} unread</span></div>{data.items.length?data.items.map(item=><article key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"><div><p className="text-sm font-medium">IT onboarding completed · {item.displayName??'Dispatcher'}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</p><Link href={`/onboarding/applications/${item.applicationId}`} className="mt-2 inline-block text-sm text-primary underline">View application</Link></div>{!item.readAt&&<Button variant="outline" disabled={busy} onClick={()=>void read(item.id)}>Mark as read</Button>}</article>):<p className="text-sm text-muted-foreground">No IT completion updates yet. New completions appear here when you refresh the page.</p>}<p role="status" className="text-sm">{message}</p></Card>;
}
