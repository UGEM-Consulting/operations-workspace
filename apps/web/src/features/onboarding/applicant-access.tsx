'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Card } from '@/components/ui/card';
import { mutate } from '@/lib/client-api';
import { inputClass } from './types';
// The API reports how codes are delivered, so this guidance always matches its real behaviour.
type Delivery = 'email' | 'manual';
const codeGuidance: Record<Delivery, string> = {
 email: 'Check your inbox for an email with your 8-digit code. It expires in 10 minutes. If it has not arrived after a few minutes, check your spam folder or select Start again.',
 manual: 'Local development: issue a code for the reference above with npm run verification:demo -- followed by the reference.',
};
export function ApplicantAccess({ token }: { token?: string }) {
 const router = useRouter();
 const [challenge,setChallenge] = useState(''), [delivery,setDelivery] = useState<Delivery>('email'), [message,setMessage] = useState(''), [busy,setBusy] = useState(false), [failed,setFailed] = useState(false);
 async function begin(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();setBusy(true);setFailed(false);setMessage('');const data=new FormData(event.currentTarget);
  try {const result=await mutate('applicant/begin','POST',{ email:data.get('email'), ...(token ? {token} : {applicationId:data.get('applicationId')}) });setChallenge(result.challengeId);setDelivery(result.delivery==='manual'?'manual':'email');setMessage(result.message);}
  catch(error){setFailed(true);setMessage(error instanceof Error ? error.message : 'Verification unavailable');}finally{setBusy(false);}
 }
 async function verify(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();setBusy(true);setFailed(false);setMessage('');const data=new FormData(event.currentTarget);
  try {await mutate('applicant/verify','POST',{challengeId:challenge,code:data.get('code')});router.replace('/apply/draft');}
  catch(error){setFailed(true);setMessage(error instanceof Error ? error.message : 'Invalid or expired verification');}finally{setBusy(false);}
 }
 return <Card className="space-y-5 p-6 sm:p-8"><h1 className="text-2xl font-normal">{token ? 'Your dispatcher invitation' : 'Resume your application'}</h1><p className="text-sm text-muted-foreground">Verify your personal email before accessing application information. If your manager specified an expected email, use that exact address. We will send you an 8-digit code.</p>
 {!challenge ? <form onSubmit={begin}><fieldset disabled={busy} className="space-y-4"><label className="block">Personal email<input className={inputClass} name="email" type="email" placeholder="name@example.com" required maxLength={254} autoComplete="email"/></label>{!token && <label className="block">Application reference<input className={inputClass} name="applicationId" required maxLength={36} placeholder="Reference saved after verification"/></label>}<Button disabled={busy}>{busy?'Requesting…':'Verify access'}</Button></fieldset></form>
 : <form onSubmit={verify}><fieldset disabled={busy} className="space-y-4">{delivery==='manual'&&<><p className="text-sm">Verification reference (expires in 10 minutes):</p><p className="break-all rounded-lg bg-accent p-3 font-mono text-sm">{challenge}</p></>}<p className="text-sm text-muted-foreground">{codeGuidance[delivery]}</p><label className="block">Verification code<input className={inputClass} name="code" inputMode="numeric" pattern="[0-9]{8}" minLength={8} maxLength={8} autoComplete="one-time-code" required/></label><Button disabled={busy}>{busy?'Verifying…':'Continue securely'}</Button><Button type="button" variant="ghost" onClick={()=>{setChallenge('');setMessage('');setFailed(false);}}>Start again</Button></fieldset></form>}
 <Notice message={message} error={failed}/><p className="text-sm text-muted-foreground">Expired, revoked, or invalid invitations cannot be used. Contact your manager for a new invitation.</p><Link className="text-sm text-primary underline" onClick={event=>{if(busy)event.preventDefault();}} href={token ? '/apply/resume' : '/apply/draft'}>{token ? 'Already verified? Resume a saved draft' : 'Continue with an existing verified session'}</Link></Card>;
}
