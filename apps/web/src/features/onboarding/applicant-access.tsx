'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { mutate } from '@/lib/client-api';
import { inputClass } from './types';
export function ApplicantAccess({ token }: { token?: string }) {
 const router = useRouter();
 const [challenge,setChallenge] = useState(''), [message,setMessage] = useState(''), [busy,setBusy] = useState(false);
 async function begin(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();setBusy(true);setMessage('');const data=new FormData(event.currentTarget);
  try {const result=await mutate('applicant/begin','POST',{ email:data.get('email'), ...(token ? {token} : {applicationId:data.get('applicationId')}) });setChallenge(result.challengeId);setMessage(result.message);}
  catch(error){setMessage(error instanceof Error ? error.message : 'Verification unavailable');}finally{setBusy(false);}
 }
 async function verify(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();setBusy(true);setMessage('');const data=new FormData(event.currentTarget);
  try {await mutate('applicant/verify','POST',{challengeId:challenge,code:data.get('code')});router.replace('/apply/draft');}
  catch(error){setMessage(error instanceof Error ? error.message : 'Invalid or expired verification');}finally{setBusy(false);}
 }
 return <Card className="space-y-5 p-6 sm:p-8"><h1 className="text-2xl font-semibold">{token ? 'Your dispatcher invitation' : 'Resume your application'}</h1><p className="text-sm text-muted-foreground">Verify your personal email before accessing application information. If your manager specified an expected email, use that exact address. For this local demo, use a fictional email ending in @example.test, such as applicant@example.test. No email is sent.</p>
 {!challenge ? <form onSubmit={begin} className="space-y-4"><label className="block">Personal email<input className={inputClass} name="email" type="email" placeholder="applicant@example.test" required maxLength={254} autoComplete="email"/></label>{!token && <label className="block">Application reference<input className={inputClass} name="applicationId" required maxLength={36} placeholder="Reference saved after verification"/></label>}<Button disabled={busy}>{busy?'Requesting…':'Verify access'}</Button></form>
 : <form onSubmit={verify} className="space-y-4"><p className="text-sm">Verification reference (expires in 10 minutes):</p><p className="break-all rounded-lg bg-accent p-3 font-mono text-sm">{challenge}</p><p className="text-sm text-muted-foreground">For this fictional demo, ask the local demo operator for your code using this reference. No email is sent.</p><label className="block">Verification code<input className={inputClass} name="code" inputMode="numeric" pattern="[0-9]{8}" minLength={8} maxLength={8} autoComplete="one-time-code" required/></label><Button disabled={busy}>{busy?'Verifying…':'Continue securely'}</Button><Button type="button" variant="ghost" onClick={()=>{setChallenge('');setMessage('');}}>Start again</Button></form>}
 <p role="status" className="text-sm">{message}</p><p className="text-sm text-muted-foreground">Expired, revoked, or invalid invitations cannot be used. Contact your manager for a new invitation.</p><Link className="text-sm text-primary underline" href={token ? '/apply/resume' : '/apply/draft'}>{token ? 'Already verified? Resume a saved draft' : 'Continue with an existing verified session'}</Link></Card>;
}
