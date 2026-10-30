'use client';
import { useCallback, useEffect, useState } from 'react';
import { Copy, Plus, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/status-badge';
import { Person } from '@/components/ui/avatar';
import { FilterBar } from '@/components/ui/filter-bar';
import { PageHeader } from '@/components/workspace-ui';
import { useLeaveGuard } from '@/components/shell-context';
import { EmptyState } from '@/components/ui/feedback';
import { Checkbox, Input, Select } from '@/components/ui/field';
import { Table } from '@/components/ui/table';
import { errorMessage, mutate } from '@/lib/client-api';
import { INVITATION_DEFAULTS } from '@/lib/navigation';
import { Invitation, readApi, type DispatcherOption } from './types';
import { EmploymentPicker, type Employment, type EmploymentOptions } from './employment-picker';
const NO_EMPLOYMENT: Employment = { mcName: '', teamLead: '', jobTitle: '' };
const PATH='/onboarding/invitations';
// Invitation states in the manager's words; the badges use the same labels as the tabs.
const STATUSES=[['PENDING','Not opened','neutral'],['OPENED','In progress','info'],['COMPLETED','Submitted','success'],['EXPIRED','Expired','neutral'],['REVOKED','Revoked','danger']] as const;
function InvitationBadge({status}:{status:string}){const [,label,tone]=STATUSES.find(([key])=>key===status)??[status,status,'neutral' as const];return <Badge label={label} tone={tone}/>;}
const EXPIRY=[3,7,14,30];

/**
 * Invitation links in the manager's scope (the most recent 200), filtered in the browser by the status and search in the URL.
 * Create invitation makes a seven-day link in one click; Create with options adds an expected email, another expiry
 * and, from the managed lists, the MC, team and job title to pre-fill (sent as the existing text fields).
 * The raw link is shown once, so leaving before copying it asks first.
 */
export function Invitations({initial,filters,options=null,dispatchers=null}:{initial:Invitation[];filters:Record<string,string>;options?:EmploymentOptions|null;dispatchers?:DispatcherOption[]|null}) {
 const [rows,setRows]=useState(initial),[server,setServer]=useState(initial);
 // A filter change re-renders the page with a fresh list from the server; take it without an effect.
 if(server!==initial){setServer(initial);setRows(initial);}
 const toast=useToast();
 const [pending,setPending]=useState<'create'|'revoke'|null>(null),[error,setError]=useState('');
 const [url,setUrl]=useState(''),[linkOpen,setLinkOpen]=useState(false),[copied,setCopied]=useState(false),[copyMessage,setCopyMessage]=useState('');
 const [revoking,setRevoking]=useState<Invitation|null>(null),[revokeError,setRevokeError]=useState('');
 const [position,setPosition]=useState<'DISPATCHER'|'SUPPORT'>('DISPATCHER'),[supportsId,setSupportsId]=useState('');
 const [optionsOpen,setOptionsOpen]=useState(false),[employment,setEmployment]=useState<Employment>(NO_EMPLOYMENT),[email,setEmail]=useState(''),[days,setDays]=useState(7),[linkDays,setLinkDays]=useState(7);
 useEffect(()=>{if(!url||copied)return;const warn=(event:BeforeUnloadEvent)=>event.preventDefault();window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[url,copied]);
 // Sidebar, breadcrumb and notification links navigate inside the app, which beforeunload never sees: the shell asks this guard.
 const leaveGuard=useCallback(()=>window.confirm('Leave without copying the invitation link? It can’t be shown again.'),[]);
 useLeaveGuard(url&&!copied?leaveGuard:null);
 async function refreshRows(){try{setRows(await readApi<Invitation[]>('onboarding/invitations'));}catch{setError('Your change was saved, but the list could not refresh. Reload the page to see the latest invitations.');}}
 async function create(withOptions:boolean) {
  if(pending)return;
  // The previous link has not been copied yet: show it again rather than replacing it.
  if(url&&!copied){setOptionsOpen(false);setLinkOpen(true);return;}
  const expiry=withOptions?days:7;
  setPending('create');setError('');
  try {
   // A support names the dispatcher they will assist and has no employment of their own; a dispatcher sends no position, as before.
   const support=withOptions&&position==='SUPPORT';
   if(support&&!supportsId){toast({tone:'danger',title:'Choose a dispatcher',description:'Pick the dispatcher this support will assist.'});setPending(null);return;}
   const assignments=support?{position:'SUPPORT',supportsMemberId:supportsId}:withOptions?Object.fromEntries(Object.entries(employment).filter(([,value])=>value)):{};
   const result=await mutate<{url:string}>('onboarding/invitations','POST',{...(withOptions&&email.trim()?{email:email.trim()}:{}),...assignments,expirationDays:expiry});
   setUrl(result.url);setLinkDays(expiry);setCopied(false);setCopyMessage('');setOptionsOpen(false);setEmail('');setEmployment(NO_EMPLOYMENT);setPosition('DISPATCHER');setSupportsId('');setLinkOpen(true);
   await refreshRows();
  }catch(error){toast({tone:'danger',title:'Invitation not created',description:errorMessage(error,'Unable to create invitation.')});}finally{setPending(null);}
 }
 async function revoke(){if(!revoking||pending)return;setPending('revoke');setRevokeError('');try{await mutate(`onboarding/invitations/${revoking.id}/revoke`,'POST');setRevoking(null);toast({title:'Invitation revoked',description:'Its link can no longer be used.'});await refreshRows();}catch(error){setRevokeError(errorMessage(error,'Unable to revoke invitation.'));}finally{setPending(null);}}
 const search=filters.search.toLowerCase();
 const matches=(row:Invitation)=>`${row.email??''} ${row.expectedEmail??''} ${row.mcName??''} ${row.teamLead??''}`.toLowerCase().includes(search);
 const searched=rows.filter(matches),visible=searched.filter(row=>filters.status==='ALL'||row.status===filters.status);
 const filtered=filters.search!==''||filters.status!=='ALL';
 return <div className="space-y-6">
  <PageHeader title="Invitations" description="Create a private link for each applicant. Links aren’t emailed: send them yourself."
   action={<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!!pending} onClick={()=>url&&!copied?setLinkOpen(true):setOptionsOpen(true)}><SlidersHorizontal aria-hidden="true" className="size-4"/>Create with options</Button>
    <Button disabled={!!pending} onClick={()=>void create(false)}><Plus aria-hidden="true" className="size-4"/>{pending==='create'&&!optionsOpen?'Creating…':'Create invitation'}</Button></div>}/>
  <PendingHint pending={pending==='create'}/>
  {error&&<Alert tone="warning"><p>{error}</p></Alert>}
  {url&&!linkOpen&&<Alert tone={copied?'info':'warning'} title={copied?'Latest invitation link':'Your new link has not been copied'} action={<Button size="sm" variant="outline" onClick={()=>setLinkOpen(true)}>Show link</Button>}><p>It expires in {linkDays} days and can’t be shown again after you leave this page.</p></Alert>}
  <Card>
   <FilterBar path={PATH} filters={filters} defaults={INVITATION_DEFAULTS} searchLabel="Search email or MC" statuses={[
    ...STATUSES.map(([key,label])=>({key,label,count:searched.filter(row=>row.status===key).length})),{key:'ALL',label:'All',count:searched.length}]}/>
   <Table caption="Invitations in your scope" className="border-t border-border" rows={visible} rowKey={row=>row.id} columns={[
    {key:'applicant',label:'Applicant',primary:true,cell:row=>row.consumedAt&&row.email?<Person name={row.email} secondary="Verified email" avatar={false}/>
     :<Person name={row.status==='PENDING'?'Not opened yet':'Not claimed yet'} secondary={row.expectedEmail?`For ${row.expectedEmail}`:'Anyone with the link'} avatar={false}/>},
    {key:'employment',label:'Employment',hideBelow:'xl',muted:true,cell:row=>row.position==='SUPPORT'?`Support for ${row.supports?.name??'a dispatcher'}`:[row.jobTitle,row.mcName,row.teamLead].filter(Boolean).join(' · ')||'Applicant provides'},
    {key:'status',label:'Status',cell:row=><InvitationBadge status={row.status}/>},
    {key:'created',label:'Created',nowrap:true,muted:true,hideBelow:'lg',cell:row=><LocalTime iso={row.createdAt} format="date"/>},
    {key:'expires',label:'Expires',nowrap:true,muted:true,hideBelow:'md',cell:row=>row.status==='COMPLETED'?'Used':<LocalTime iso={row.expiresAt} format="date"/>},
    {key:'action',label:'Action',srOnly:true,action:true,align:'right',cell:row=>['PENDING','OPENED'].includes(row.status)&&<Button variant="ghost" size="sm" className="text-danger" disabled={!!pending} onClick={()=>{setRevoking(row);setRevokeError('');}}>Revoke<span className="sr-only"> invitation created <LocalTime iso={row.createdAt}/></span></Button>},
   ]} empty={filtered?<EmptyState compact title="No matching invitations" description="Try another status or search."/>
    :<EmptyState compact title="Create your first invitation" description="Each link lets one applicant verify their email and fill in their application." action={<Button disabled={!!pending} onClick={()=>void create(false)}><Plus aria-hidden="true" className="size-4"/>Create invitation</Button>}/>}
   footer={<p className="text-[13px] text-muted-foreground">{visible.length} invitation{visible.length===1?'':'s'} · the most recent 200 in your scope.</p>}/>
  </Card>
  {optionsOpen&&<Dialog open onClose={()=>setOptionsOpen(false)} busy={pending==='create'} title="Create an invitation" description="Every setting is optional. The applicant fills in everything else."
   actions={<Button type="submit" form="invitation-options">{pending==='create'?'Creating…':'Create invitation'}</Button>}>
   <form id="invitation-options" onSubmit={event=>{event.preventDefault();void create(true);}} className="space-y-4">
    <Input label="Applicant’s personal email" optional name="expectedEmail" type="email" value={email} onChange={event=>setEmail(event.target.value)} maxLength={254} placeholder="name@example.com" hint="If you add one, only that person can use the link. Otherwise the first applicant to verify their email claims it." width="full"/>
    {dispatchers&&<Select label="Position" name="position" value={position} onChange={event=>setPosition(event.target.value as 'DISPATCHER'|'SUPPORT')} width="sm"
     options={[{value:'DISPATCHER',label:'Dispatcher'},{value:'SUPPORT',label:'Support (updater)'}]} hint={position==='SUPPORT'?'Supports assist one dispatcher. They skip the employment questions and need no IT setup.':undefined}/>}
    {dispatchers&&position==='SUPPORT'&&<Select label="Supports" name="supportsMemberId" value={supportsId} onChange={event=>setSupportsId(event.target.value)} required placeholder="Choose a dispatcher" width="full"
     options={dispatchers.map(option=>({value:option.id,label:[option.name,option.mc??'Independent',option.team].filter(Boolean).join(' · ')}))} hint={dispatchers.length?undefined:'There are no dispatcher records yet.'}/>}
    {options&&position==='DISPATCHER'&&<fieldset className="space-y-3 border-t border-border pt-4"><legend className="float-left mb-1 w-full text-sm font-medium">Employment</legend>
     <p className="text-[13px] leading-5 text-muted-foreground">Pre-fills the applicant’s answers. You confirm them again at approval.</p>
     <EmploymentPicker optional options={options} original={NO_EMPLOYMENT} onChange={setEmployment}/></fieldset>}
    <Select label="Expires after" name="expirationDays" value={String(days)} onChange={event=>setDays(Number(event.target.value))} width="sm" options={EXPIRY.map(value=>({value:String(value),label:`${value} days`}))}/>
   </form>
  </Dialog>}
  {linkOpen&&<Dialog open onClose={()=>setLinkOpen(false)} title="Invitation link ready" description={`Copy the link and send it to the applicant. It expires in ${linkDays} days, and you won’t see it again after you leave this page.`} protectChanges={false} closeLabel="Done">
   <div className="space-y-4"><Input label="Invitation link" name="invitationLink" autoComplete="off" value={url} readOnly onFocus={event=>event.currentTarget.select()} width="full"/>
    <Button onClick={async()=>{try{await navigator.clipboard.writeText(url);setCopied(true);setCopyMessage('Link copied. You can now share it privately.');}catch{setCopyMessage('Select the link above and copy it manually, then confirm below.');}}}><Copy aria-hidden="true" className="size-4"/>{copied?'Copy link again':'Copy link'}</Button>
    <p role="status" className="text-sm">{copyMessage}</p>{!copied&&<Checkbox label="I have copied the link manually." onChange={event=>setCopied(event.target.checked)}/>}</div>
  </Dialog>}
  {revoking&&<Dialog open size="sm" tone="danger" onClose={()=>setRevoking(null)} title="Revoke invitation?" description="This link will stop working. You will need to create a new invitation if the applicant still needs access." busy={pending==='revoke'} protectChanges={false} actions={<Button variant="destructive" onClick={()=>void revoke()}>{pending==='revoke'?'Revoking…':'Revoke invitation'}</Button>}>
   <div className="space-y-4"><p className="break-words font-medium">{revoking.expectedEmail??revoking.email??'Unclaimed invitation'}</p><p className="text-sm text-muted-foreground">Created <LocalTime iso={revoking.createdAt}/></p><p className="break-all text-xs text-muted-foreground">Reference: {revoking.id}</p><Notice message={revokeError} error/><PendingHint pending={pending==='revoke'}/></div>
  </Dialog>}
 </div>;
}
