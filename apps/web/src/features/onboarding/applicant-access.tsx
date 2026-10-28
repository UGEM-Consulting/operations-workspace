'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import { PendingHint } from '@/components/ui/pending-hint';
import { errorMessage, mutate } from '@/lib/client-api';
import { markApplicantVerified } from '@/lib/applicant-session';
// The API reports how codes are delivered, so this guidance always matches its real behaviour.
type Delivery = 'email' | 'manual';
const codeGuidance: Record<Delivery, string> = {
 email: 'Check your inbox for an email with your 8-digit code. It expires in 10 minutes. If it has not arrived after a few minutes, check your spam folder or select Start again.',
 manual: 'Local development: issue a code for the reference above with npm run verification:demo -- followed by the reference.',
};

/**
 * Email verification: begin (email plus invitation token or application reference), then the 8-digit code.
 * Used by the invitation and resume pages and by the in-place re-verification dialog on the application form.
 * The invitation token stays in memory only.
 */
export function VerifyAccess({ token, applicationId, email, onVerified }: { token?: string; applicationId?: string; email?: string | null; onVerified: () => void }) {
 const [challenge,setChallenge] = useState(''), [delivery,setDelivery] = useState<Delivery>('email'), [message,setMessage] = useState(''), [busy,setBusy] = useState(false), [failed,setFailed] = useState(false);
 const code = useRef<HTMLInputElement>(null);
 // Move focus to the code as soon as it is requested, so keyboard and screen-reader users land on the next step.
 useEffect(() => { if (challenge) code.current?.focus(); }, [challenge]);
 async function begin(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();setBusy(true);setFailed(false);setMessage('');const data=new FormData(event.currentTarget);
  try {const result=await mutate<{challengeId:string;delivery?:string;message:string}>('applicant/begin','POST',{ email:data.get('email'), ...(token ? {token} : {applicationId:data.get('applicationId')}) });setChallenge(result.challengeId);setDelivery(result.delivery==='manual'?'manual':'email');setMessage(result.message);}
  catch(error){setFailed(true);setMessage(errorMessage(error,'Verification unavailable. Please try again.'));}finally{setBusy(false);}
 }
 async function verify(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();setBusy(true);setFailed(false);setMessage('');const data=new FormData(event.currentTarget);
  try {await mutate('applicant/verify','POST',{challengeId:challenge,code:data.get('code')});markApplicantVerified();onVerified();}
  catch(error){setFailed(true);setMessage(errorMessage(error,'Invalid or expired verification.'));}finally{setBusy(false);}
 }
 return <div className="space-y-4">
  {!challenge ? <form onSubmit={begin}><fieldset disabled={busy} className="space-y-4">
   <Input label="Personal email" name="email" type="email" placeholder="name@example.com" required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} defaultValue={email ?? undefined} width="md"/>
   {!token && <Input label="Application reference" name="applicationId" required maxLength={36} placeholder="Reference saved after verification" autoComplete="off" autoCapitalize="none" spellCheck={false} defaultValue={applicationId} readOnly={!!applicationId} width="md"/>}
   <Button disabled={busy}>{busy?'Requesting…':'Send verification code'}</Button></fieldset></form>
  : <form onSubmit={verify}><fieldset disabled={busy} className="space-y-4">{delivery==='manual'&&<><p className="text-sm">Verification reference (expires in 10 minutes):</p><p className="break-all rounded-md bg-muted p-3 font-mono text-sm">{challenge}</p></>}<p className="text-sm text-muted-foreground">{codeGuidance[delivery]}</p>
   <Input ref={code} label="Verification code" name="code" inputMode="numeric" pattern="[0-9]{8}" minLength={8} maxLength={8} autoComplete="one-time-code" required width="sm"/>
   <div className="flex flex-wrap gap-3"><Button disabled={busy}>{busy?'Verifying…':'Continue securely'}</Button><Button type="button" variant="ghost" onClick={()=>{setChallenge('');setMessage('');setFailed(false);}}>Start again</Button></div></fieldset></form>}
  <PendingHint pending={busy}/>
  <Notice message={message} error={failed}/>
 </div>;
}

export function ApplicantAccess({ token }: { token?: string }) {
 const router = useRouter();
 return <Card className="space-y-5 p-6 sm:p-8"><h1 className="text-2xl font-normal">{token ? 'Your dispatcher invitation' : 'Resume your application'}</h1><p className="text-sm text-muted-foreground">Verify your personal email before accessing application information. If your manager specified an expected email, use that exact address. We will send you an 8-digit code.</p>
 <VerifyAccess token={token} onVerified={()=>router.replace('/apply/draft')}/>
 <p className="text-sm text-muted-foreground">Expired, revoked, or invalid invitations cannot be used. Contact your manager for a new invitation.</p><Link className="text-sm text-primary underline" href={token ? '/apply/resume' : '/apply/draft'}>{token ? 'Already verified? Resume a saved draft' : 'Continue with an existing verified session'}</Link></Card>;
}
