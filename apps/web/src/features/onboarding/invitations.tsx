'use client';
import { useEffect, useState } from 'react';
import { Copy, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { StatusBadge, statusLabel } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { EmptyState } from '@/components/ui/feedback';
import { Checkbox, Input, Select } from '@/components/ui/field';
import { Table } from '@/components/ui/table';
import { errorMessage, mutate } from '@/lib/client-api';
import { Invitation, readApi } from './types';
export function Invitations({ initial }: { initial: Invitation[] }) {
 const [rows,setRows]=useState(initial),[query,setQuery]=useState(''),[filter,setFilter]=useState('ALL');
 const toast=useToast();
 const [pending,setPending]=useState<'create'|'revoke'|null>(null),[error,setError]=useState('');
 const [url,setUrl]=useState(''),[linkOpen,setLinkOpen]=useState(false),[copied,setCopied]=useState(false),[copyMessage,setCopyMessage]=useState('');
 const [revoking,setRevoking]=useState<Invitation|null>(null),[revokeError,setRevokeError]=useState('');
 const [email,setEmail]=useState(''),[days,setDays]=useState(7),[linkDays,setLinkDays]=useState(7);
 useEffect(()=>{if(!url||copied)return;const warn=(event:BeforeUnloadEvent)=>event.preventDefault();window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[url,copied]);
 async function refreshRows(){try{setRows(await readApi<Invitation[]>('onboarding/invitations'));}catch{setError('Your change was saved, but the list could not refresh. Reload the page to see the latest invitations.');}}
 async function create() {
  if(pending)return;
  if(url&&!copied){setLinkOpen(true);return;}
  setPending('create');setError('');
  try {
   const result=await mutate<{url:string}>('onboarding/invitations','POST',{...(email.trim()?{email:email.trim()}:{}),expirationDays:days});
   setUrl(result.url);setLinkDays(days);setCopied(false);setCopyMessage('');setLinkOpen(true);
   toast({title:'Invitation created',description:'Copy the link and share it privately.'});
   await refreshRows();
  }catch(error){toast({tone:'danger',title:'Invitation not created',description:errorMessage(error,'Unable to create invitation.')});}finally{setPending(null);}
 }
 async function revoke(){if(!revoking||pending)return;setPending('revoke');setRevokeError('');try{await mutate(`onboarding/invitations/${revoking.id}/revoke`,'POST');setRevoking(null);toast({title:'Invitation revoked',description:'Its link can no longer be used.'});await refreshRows();}catch(error){setRevokeError(errorMessage(error,'Unable to revoke invitation.'));}finally{setPending(null);}}
 const visible=rows.filter(row=>(filter==='ALL'||row.status===filter)&&`${row.email??''} ${row.expectedEmail??''} ${row.mcName??''} ${row.teamLead??''}`.toLowerCase().includes(query.toLowerCase()));
 return <div className="space-y-6">
 <PageHeader eyebrow="Onboarding" title="Dispatcher invitations" description="Create a link, share it privately, and let the applicant verify their email and complete their details." />
 <Card className="space-y-4 p-5"><form onSubmit={event=>{event.preventDefault();void create();}}><fieldset disabled={!!pending} className="space-y-4"><div className="flex flex-wrap items-center gap-4"><Button><Plus aria-hidden="true" className="size-4" />{pending==='create'?'Creating…':url&&!copied?'Copy your invitation link':'Create invitation'}</Button><p className="text-sm text-muted-foreground">Expires in {days} days. No applicant details required.</p></div><PendingHint pending={pending==='create'}/><details><summary className="cursor-pointer text-sm font-medium">Optional settings</summary><div className="mt-4 flex flex-wrap gap-4"><Input label="Expected personal email" optional name="expectedEmail" type="email" value={email} onChange={event=>setEmail(event.target.value)} maxLength={254} placeholder="name@example.com" width="md"/><Input label="Expires in (days)" name="expirationDays" type="number" min={1} max={30} required value={days} onChange={event=>setDays(Number(event.target.value))} width="xs"/></div><p className="mt-3 text-sm text-muted-foreground">An expected email restricts who can claim the link. Otherwise, the first successfully verified applicant claims it.</p></details></fieldset></form></Card>
 {error&&<Alert tone="warning"><p>{error}</p></Alert>}
 {url&&<Button variant="outline" onClick={()=>setLinkOpen(true)}>View latest invitation link</Button>}
 <div className="flex flex-wrap items-end gap-4"><Input label="Search invitations" name="search" type="search" placeholder="Email, MC, or team lead" value={query} onChange={event=>setQuery(event.target.value)} width="md"/><Select label="Status" name="status" value={filter} onChange={event=>setFilter(event.target.value)} width="sm" options={['ALL','PENDING','OPENED','EXPIRED','REVOKED','COMPLETED'].map(status=>({value:status,label:status==='ALL'?'All statuses':statusLabel(status)}))}/></div>
 <Card><Table caption="Dispatcher invitations in your scope" rows={visible} rowKey={row=>row.id} columns={[
  {key:'applicant',label:'Applicant',primary:true,cell:row=><span className="break-all font-medium">{row.consumedAt?row.email:row.expectedEmail?`Expected: ${row.expectedEmail}`:'Awaiting verified applicant'}</span>},
  {key:'employment',label:'Employment',hideBelow:'xl',muted:true,cell:row=>[row.jobTitle,row.mcName,row.teamLead].filter(Boolean).join(' · ')||'Applicant provides'},
  {key:'created',label:'Created',nowrap:true,muted:true,hideBelow:'lg',cell:row=><LocalTime iso={row.createdAt} format="date"/>},
  {key:'expires',label:'Expires',nowrap:true,muted:true,hideBelow:'md',cell:row=><LocalTime iso={row.expiresAt} format="date"/>},
  {key:'status',label:'Status',cell:row=><StatusBadge status={row.status}/>},
  {key:'action',label:'Action',srOnly:true,action:true,align:'right',cell:row=>['PENDING','OPENED'].includes(row.status)&&<Button variant="outline" size="sm" disabled={!!pending} onClick={()=>{setRevoking(row);setRevokeError('');}}>Revoke<span className="sr-only"> invitation created <LocalTime iso={row.createdAt}/></span></Button>},
 ]} empty={<EmptyState compact title={query||filter!=='ALL'?'No matching invitations':'Create your first invitation'} description={query||filter!=='ALL'?'Try another search or reset your filters.':'Create a link above to start the applicant onboarding process.'} action={(query||filter!=='ALL')&&<Button variant="outline" onClick={()=>{setQuery('');setFilter('ALL');}}>Reset filters</Button>}/>}
 footer={<p className="text-[13px] text-muted-foreground">{visible.length} matching invitation{visible.length===1?'':'s'} · Most recent 200 in your scope. No emails are sent automatically.</p>}/></Card>
 {linkOpen&&<Dialog open onClose={()=>setLinkOpen(false)} title="Your invitation link is ready" description={`Expires in ${linkDays} days. Copy and share privately. This link cannot be recovered after leaving this page.`} protectChanges={false} closeLabel="Done">
 <div className="space-y-4"><Input label="Invitation link" name="invitationLink" autoComplete="off" value={url} readOnly onFocus={event=>event.currentTarget.select()} width="full"/><Button onClick={async()=>{try{await navigator.clipboard.writeText(url);setCopied(true);setCopyMessage('Link copied. You can now share it privately.');}catch{setCopyMessage('Select the link above and copy it manually, then confirm below.');}}}><Copy aria-hidden="true" className="size-4" />{copied?'Copy link again':'Copy link'}</Button><p role="status" className="text-sm">{copyMessage}</p>{!copied&&<Checkbox label="I have copied the link manually." onChange={event=>setCopied(event.target.checked)}/>}</div>
 </Dialog>}
 {revoking&&<Dialog open size="sm" tone="danger" onClose={()=>setRevoking(null)} title="Revoke invitation?" description="This link will stop working. You will need to create a new invitation if the applicant still needs access." busy={pending==='revoke'} protectChanges={false} actions={<Button variant="destructive" onClick={()=>void revoke()}>{pending==='revoke'?'Revoking…':'Revoke invitation'}</Button>}>
 <div className="space-y-4"><p className="break-words font-medium">{revoking.expectedEmail??revoking.email??'Unclaimed invitation'}</p><p className="text-sm text-muted-foreground">Created <LocalTime iso={revoking.createdAt}/></p><p className="break-all text-xs text-muted-foreground">Reference: {revoking.id}</p><Notice message={revokeError} error/><PendingHint pending={pending==='revoke'}/></div>
 </Dialog>}
 </div>;
}
