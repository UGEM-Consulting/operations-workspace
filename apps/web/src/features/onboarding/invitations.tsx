'use client';
import { useEffect, useState } from 'react';
import { Copy, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { StatusBadge, statusLabel } from '@/components/ui/status-badge';
import { PageHeader, EmptyState } from '@/components/workspace-ui';
import { mutate } from '@/lib/client-api';
import { Invitation, inputClass, readApi } from './types';
export function Invitations({ initial }: { initial: Invitation[] }) {
 const [rows,setRows]=useState(initial),[query,setQuery]=useState(''),[filter,setFilter]=useState('ALL');
 const [pending,setPending]=useState<'create'|'revoke'|null>(null),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [url,setUrl]=useState(''),[linkOpen,setLinkOpen]=useState(false),[copied,setCopied]=useState(false),[copyMessage,setCopyMessage]=useState('');
 const [revoking,setRevoking]=useState<Invitation|null>(null),[revokeError,setRevokeError]=useState('');
 const [email,setEmail]=useState(''),[days,setDays]=useState(7),[linkDays,setLinkDays]=useState(7);
 useEffect(()=>{if(!url||copied)return;const warn=(event:BeforeUnloadEvent)=>event.preventDefault();window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[url,copied]);
 async function refreshRows(){try{setRows(await readApi<Invitation[]>('onboarding/invitations'));}catch{setError('Your change was saved, but the list could not refresh. Reload the page to see the latest invitations.');}}
 async function create() {
  if(pending)return;
  if(url&&!copied){setLinkOpen(true);return;}
  setPending('create');setMessage('');setError('');
  try {
   const result=await mutate('onboarding/invitations','POST',{...(email.trim()?{email:email.trim()}:{}),expirationDays:days});
   setUrl(result.url);setLinkDays(days);setCopied(false);setCopyMessage('');setLinkOpen(true);
   setMessage('Invitation created. Copy the link and share it privately.');
   await refreshRows();
  }catch(error){setError(error instanceof Error?error.message:'Unable to create invitation.');}finally{setPending(null);}
 }
 async function revoke(){if(!revoking||pending)return;setPending('revoke');setRevokeError('');try{await mutate(`onboarding/invitations/${revoking.id}/revoke`,'POST');setRevoking(null);setMessage('Invitation revoked. Its link can no longer be used.');await refreshRows();}catch(error){setRevokeError(error instanceof Error?error.message:'Unable to revoke invitation.');}finally{setPending(null);}}
 const visible=rows.filter(row=>(filter==='ALL'||row.status===filter)&&`${row.email??''} ${row.expectedEmail??''} ${row.mcName??''} ${row.teamLead??''}`.toLowerCase().includes(query.toLowerCase()));
 return <div className="space-y-6">
 <PageHeader eyebrow="Onboarding" title="Dispatcher invitations" description="Create a link, share it privately, and let the applicant verify their email and complete their details." />
 <Card className="space-y-4 p-5"><form onSubmit={event=>{event.preventDefault();void create();}}><fieldset disabled={!!pending} className="space-y-4"><div className="flex flex-wrap items-center gap-4"><Button><Plus aria-hidden="true" className="size-4" />{pending==='create'?'Creating…':url&&!copied?'Copy your invitation link':'Create invitation'}</Button><p className="text-sm text-muted-foreground">Expires in {days} days. No applicant details required.</p></div><details><summary className="cursor-pointer text-sm font-medium">Optional settings</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-sm">Expected personal email (optional)<input type="email" value={email} onChange={event=>setEmail(event.target.value)} maxLength={254} placeholder="name@example.com" className={inputClass}/></label><label className="text-sm">Expiration in days<input type="number" min={1} max={30} required value={days} onChange={event=>setDays(Number(event.target.value))} className={inputClass}/></label></div><p className="mt-3 text-sm text-muted-foreground">An expected email restricts who can claim the link. Otherwise, the first successfully verified applicant claims it.</p></details></fieldset></form></Card>
 <Notice message={message}/><Notice message={error} error/>
 {url&&<Button variant="outline" onClick={()=>setLinkOpen(true)}>View latest invitation link</Button>}
 <div className="flex flex-wrap gap-4"><label className="w-full text-sm sm:max-w-sm">Search invitations<input type="search" placeholder="Email, MC, or team lead" className={inputClass} value={query} onChange={event=>setQuery(event.target.value)}/></label><label className="w-full text-sm sm:max-w-48">Status<select className={inputClass} value={filter} onChange={event=>setFilter(event.target.value)}>{['ALL','PENDING','OPENED','EXPIRED','REVOKED','COMPLETED'].map(status=><option key={status} value={status}>{status==='ALL'?'All statuses':statusLabel(status)}</option>)}</select></label></div>
 <p className="text-sm text-muted-foreground">{visible.length} matching invitation{visible.length===1?'':'s'}</p>
 <div className="grid gap-3">{visible.map(row=><Card key={row.id} className="flex flex-wrap items-center justify-between gap-4 p-5"><div className="min-w-0"><p className="break-all font-medium">{row.consumedAt?row.email:row.expectedEmail?`Expected: ${row.expectedEmail}`:'Awaiting verified applicant'}</p><p className="text-sm text-muted-foreground">{[row.jobTitle,row.mcName,row.teamLead].filter(Boolean).join(' · ')||'Applicant will provide employment details'}</p><p className="mt-2 text-xs text-muted-foreground">Created {new Date(row.createdAt).toLocaleString()} · Expires {new Date(row.expiresAt).toLocaleDateString()}</p></div><div className="flex items-center gap-3"><StatusBadge status={row.status}/>{['PENDING','OPENED'].includes(row.status)&&<Button variant="outline" disabled={!!pending} onClick={()=>{setRevoking(row);setRevokeError('');}}>Revoke<span className="sr-only"> invitation created {new Date(row.createdAt).toLocaleString()}</span></Button>}</div></Card>)}{!visible.length&&<Card><EmptyState title={query||filter!=='ALL'?'No matching invitations':'Create your first invitation'} description={query||filter!=='ALL'?'Try another search or reset your filters.':'Create a link above to start the applicant onboarding process.'}/>{(query||filter!=='ALL')&&<div className="pb-6 text-center"><Button variant="outline" onClick={()=>{setQuery('');setFilter('ALL');}}>Reset filters</Button></div>}</Card>}</div>
 <p className="text-xs text-muted-foreground">Most recent 200 invitations in your scope. No emails are sent automatically.</p>
 {linkOpen&&<Dialog open onClose={()=>setLinkOpen(false)} title="Your invitation link is ready" description={`Expires in ${linkDays} days. Copy and share privately. This link cannot be recovered after leaving this page.`} protectChanges={false} closeLabel="Done">
 <div className="space-y-4"><label className="block text-sm">Invitation link<input autoComplete="off" className={inputClass} value={url} readOnly onFocus={event=>event.currentTarget.select()}/></label><Button onClick={async()=>{try{await navigator.clipboard.writeText(url);setCopied(true);setCopyMessage('Link copied. You can now share it privately.');}catch{setCopyMessage('Select the link above and copy it manually, then confirm below.');}}}><Copy aria-hidden="true" className="size-4" />{copied?'Copy link again':'Copy link'}</Button><p role="status" className="text-sm">{copyMessage}</p>{!copied&&<label className="flex items-start gap-3 text-sm"><input type="checkbox" onChange={event=>setCopied(event.target.checked)} className="mt-1"/>I have copied the link manually.</label>}</div>
 </Dialog>}
 {revoking&&<Dialog open onClose={()=>setRevoking(null)} title="Revoke invitation?" description="This link will stop working. You will need to create a new invitation if the applicant still needs access." busy={pending==='revoke'} protectChanges={false} actions={<Button variant="destructive" onClick={()=>void revoke()}>{pending==='revoke'?'Revoking…':'Revoke invitation'}</Button>}>
 <div className="space-y-4"><p className="break-words font-medium">{revoking.expectedEmail??revoking.email??'Unclaimed invitation'}</p><p className="text-sm text-muted-foreground">Created {new Date(revoking.createdAt).toLocaleString()}</p><p className="break-all text-xs text-muted-foreground">Reference: {revoking.id}</p><Notice message={revokeError} error/></div>
 </Dialog>}
 </div>;
}
