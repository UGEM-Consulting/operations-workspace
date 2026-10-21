'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { mutate } from '@/lib/client-api';
import { Invitation, inputClass, readApi } from './types';
export function Invitations({ initial }: { initial: Invitation[] }) {
 const [rows,setRows]=useState(initial),[query,setQuery]=useState(''),[filter,setFilter]=useState('ALL');
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[url,setUrl]=useState('');
 const [email,setEmail]=useState(''),[days,setDays]=useState(7);
 async function create() {
  setBusy(true);setMessage('');
  try {
   const result=await mutate('onboarding/invitations','POST',{...(email.trim()?{email:email.trim()}:{}),expirationDays:days});
   setUrl(result.url);setMessage('Invitation created. Copy the link now; it is shown only once.');
   setRows(await readApi<Invitation[]>('onboarding/invitations'));
  }catch(error){setMessage(error instanceof Error?error.message:'Unable to create invitation');}finally{setBusy(false);}
 }
 async function revoke(id:string){setBusy(true);try{await mutate(`onboarding/invitations/${id}/revoke`,'POST');setRows(await readApi<Invitation[]>('onboarding/invitations'));setMessage('Invitation revoked.');}catch(error){setMessage(error instanceof Error?error.message:'Unable to revoke');}finally{setBusy(false);}}
 const visible=rows.filter(row=>(filter==='ALL'||row.status===filter)&&`${row.email??''} ${row.expectedEmail??''} ${row.mcName??''} ${row.teamLead??''}`.toLowerCase().includes(query.toLowerCase()));
 return <div className="space-y-6"><div><h1 className="text-2xl font-normal">Dispatcher invitations</h1><p className="mt-2 text-muted-foreground">Create a link. The applicant verifies their email and completes their details.</p></div>
 <Card className="space-y-4 p-5"><form onSubmit={event=>{event.preventDefault();void create();}} className="space-y-4"><div className="flex flex-wrap items-center gap-4"><Button disabled={busy}>{busy?'Creating…':'Create Invitation'}</Button><p className="text-sm text-muted-foreground">Expires in {days} days. No applicant details required.</p></div><details><summary className="cursor-pointer text-sm font-medium">Optional settings</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-sm">Expected personal email (optional)<input type="email" value={email} onChange={event=>setEmail(event.target.value)} maxLength={254} placeholder="applicant@example.test" className={inputClass}/></label><label className="text-sm">Expiration in days<input type="number" min={1} max={30} required value={days} onChange={event=>setDays(Number(event.target.value))} className={inputClass}/></label></div><p className="mt-3 text-xs text-muted-foreground">If you enter an expected email, only that address can claim the link. Otherwise, the first successfully verified applicant claims it. Share privately.</p></details></form></Card>
 <p role="status" className="text-sm">{message}</p>
 {url&&<Card className="space-y-3 p-5"><p className="font-medium">Your invitation link</p><p className="text-sm text-muted-foreground">Share privately. This link cannot be recovered after leaving this page.</p><input aria-label="Invitation URL" className={inputClass} value={url} readOnly/><Button onClick={async()=>{try{await navigator.clipboard.writeText(url);setMessage('Link copied.');}catch{setMessage('Select the link above and copy it manually.');}}}>Copy link</Button></Card>}
 <div className="flex flex-wrap gap-3"><input aria-label="Search invitations" placeholder="Search email, MC, or team lead" className={`${inputClass} sm:max-w-sm`} value={query} onChange={event=>setQuery(event.target.value)}/><select aria-label="Filter status" className={`${inputClass} sm:max-w-48`} value={filter} onChange={event=>setFilter(event.target.value)}>{['ALL','PENDING','OPENED','EXPIRED','REVOKED','COMPLETED'].map(status=><option key={status}>{status}</option>)}</select></div>
 <div className="grid gap-3">{visible.map(row=><Card key={row.id} className="flex flex-wrap items-center justify-between gap-4 p-5"><div className="min-w-0"><p className="break-all font-medium">{row.consumedAt?row.email:row.expectedEmail?`Expected: ${row.expectedEmail}`:'Awaiting verified applicant'}</p><p className="text-sm text-muted-foreground">{[row.jobTitle,row.mcName,row.teamLead].filter(Boolean).join(' · ')||'Applicant will provide employment details'}</p><p className="mt-2 text-xs text-muted-foreground">Expires {new Date(row.expiresAt).toLocaleDateString()}</p></div><div className="flex items-center gap-3"><span className="rounded-full bg-accent px-3 py-1 text-xs font-medium">{row.status}</span>{['PENDING','OPENED'].includes(row.status)&&<Button variant="outline" disabled={busy} onClick={()=>void revoke(row.id)}>Revoke</Button>}</div></Card>)}{!visible.length&&<Card className="p-8 text-center text-muted-foreground">No matching invitations. Create a link to get started.</Card>}</div><p className="text-xs text-muted-foreground">Most recent 200 invitations in your scope. No emails are sent automatically.</p></div>;
}
