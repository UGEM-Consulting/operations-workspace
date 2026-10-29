"use client";
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { mutate } from '@/lib/client-api';
import { BackToSignIn, signInExpired } from './mfa-verify-form';
import { SignInHeading } from './sign-in-frame';
interface Enrolment { qrCode: string; uri: string; manualKey: string; issuer: string; account: string }
const STEPS = ['Add the app', 'Save recovery codes'];

/** "Step 1 of 2" with a bar per step, for short flows on one page. */
function StepCount({ current }: { current: number }) {
  return <div className="mb-6">
    <p className="text-xs font-medium text-muted-foreground">Step {current + 1} of {STEPS.length}</p>
    <p className="text-sm font-semibold">{STEPS[current]}</p>
    <div aria-hidden="true" className="mt-2 flex gap-1">{STEPS.map((step, index) => <span key={step} className={`h-1 flex-1 rounded-full ${index <= current ? 'bg-primary' : 'bg-muted'}`} />)}</div>
  </div>;
}
function CopyButton({ text, label, copiedLabel = 'Copied' }: { text: string; label: string; copiedLabel?: string }) {
  const [copied, setCopied] = useState(false);
  return <Button type="button" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } }}>
    {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}{copied ? copiedLabel : label}
  </Button>;
}

/** One-time display of recovery codes with copy and download. */
export function RecoveryCodes({ codes, onDone, doneLabel }: { codes: string[]; onDone: () => void; doneLabel: string }) {
  const [saved, setSaved] = useState(false);
  const text = `UGEM Workspace recovery codes\nEach code works once.\n\n${codes.join('\n')}\n`;
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: 'ugem-workspace-recovery-codes.txt' });
    link.click(); URL.revokeObjectURL(url);
  }
  return <div className="space-y-4">
    <Alert tone="warning" title="They won’t be shown again"><p>Keep them in your password manager or another safe place, not on your phone.</p></Alert>
    <ol aria-label="Recovery codes" className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border bg-muted px-4 py-3 font-mono text-[15px] font-medium leading-6 tracking-[.04em] sm:px-5 sm:py-4">{codes.map(code => <li key={code}>{code}</li>)}</ol>
    <div className="flex flex-wrap gap-2 [&>*]:max-sm:flex-1">
      <CopyButton text={text} label="Copy codes" />
      <Button type="button" variant="outline" onClick={download}><Download aria-hidden="true" className="size-4" />Download</Button>
    </div>
    <div className="space-y-4 pt-1">
      <Checkbox checked={saved} onChange={event => setSaved(event.target.checked)} label="I have saved my recovery codes" />
      <Button type="button" size="lg" className="w-full" disabled={!saved} onClick={onDone}>{doneLabel}<ArrowRight aria-hidden="true" className="size-4" /></Button>
    </div>
  </div>;
}

/**
 * Authenticator enrolment: install, scan the QR code or type the key, confirm one code; then the recovery codes.
 * `signIn` renders the sign-in page's step count and headings; on Account security the surrounding card provides them.
 */
export function MfaSetup({ onComplete, onCancel, doneLabel = 'Continue to workspace', signIn = false }: { onComplete?: (landingPage: string) => void; onCancel?: () => void; doneLabel?: string; signIn?: boolean }) {
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [result, setResult] = useState<{ codes: string[]; landingPage: string } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const started = useRef(false);
  async function begin() {
    setError('');
    try { setEnrolment(await mutate('auth/mfa/enrolment', 'POST')); }
    catch (error) { setError(signInExpired(error instanceof Error ? error.message : 'Unable to start setup')); }
  }
  // Each start replaces the unconfirmed key, so request it once per visit.
  useEffect(() => { if (!started.current) { started.current = true; void begin(); } }, []);
  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPending(true);
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim();
    try {
      const data = await mutate('auth/mfa/enrolment/confirm', 'POST', { code });
      setResult({ codes: data.recoveryCodes, landingPage: data.landingPage });
    } catch (error) {
      setError(signInExpired(error instanceof Error ? error.message : 'Unable to confirm the code'));
      // After the error renders, so the message is read with the field.
      setTimeout(() => document.querySelector<HTMLInputElement>('#mfa-setup-code')?.select(), 0);
    } finally { setPending(false); }
  }
  // A full navigation picks up the regenerated session cookie.
  const done = () => onComplete ? onComplete(result!.landingPage) : window.location.assign(result!.landingPage);
  if (result) return <div>
    {signIn ? <><StepCount current={1} /><SignInHeading title="Save your recovery codes" description="If you lose your phone, each code signs you in once instead of an authenticator code." /></>
      : <><h3 className="font-semibold">Two-step verification is on. Save your recovery codes</h3><p className="mt-1 text-sm text-muted-foreground">If you lose your phone, each code signs you in once instead of an authenticator code.</p></>}
    <div className="mt-5"><RecoveryCodes codes={result.codes} onDone={done} doneLabel={doneLabel} /></div>
  </div>;
  const heading = signIn && <><StepCount current={0} /><SignInHeading title="Set up two-step verification" description="Your account must use it. It takes about two minutes and protects the workspace if your password is ever stolen." /></>;
  if (!enrolment) return <div>{heading}<div className="mt-6 space-y-4">{error ? <><p role="alert" className="text-sm text-danger">{error}</p>{signIn && <BackToSignIn />}</> : <p role="status" className="text-sm text-muted-foreground">Preparing your setup key…</p>}</div></div>;
  return <div>
    {heading}
    <form onSubmit={confirm}>
      <ol className="my-6 grid gap-6">
        {[
          <><p className="text-[15px] font-semibold leading-6">Install an authenticator app</p><p className="text-[13px] leading-5 text-muted-foreground">Google Authenticator, Microsoft Authenticator or 1Password all work.</p></>,
          <><p className="text-[15px] font-semibold leading-6">Scan this QR code with the app</p>
            <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
              {/* eslint-disable-next-line @next/next/no-img-element -- server-generated data URL */}
              <img src={enrolment.qrCode} alt={`QR code to add ${enrolment.account} to your authenticator app`} width={168} height={168} className="size-42 rounded-md border border-border bg-white p-2 max-sm:mx-auto" />
              <div className="min-w-0 space-y-3">
                <p className="text-[13px] leading-5 text-muted-foreground">Can’t scan? In the app choose “Enter a setup key” and type this key.</p>
                <div><p className="text-sm font-medium">Setup key</p><code className="mt-1 block break-all rounded-sm border border-border bg-muted px-3 py-2 font-mono text-[15px] tracking-wider">{enrolment.manualKey}</code></div>
                <div className="flex flex-wrap items-center gap-3"><CopyButton text={enrolment.manualKey.replace(/\s+/g, '')} label="Copy key" /><a href={enrolment.uri} className="text-sm text-primary underline-offset-4 hover:underline sm:hidden">Open in authenticator app</a></div>
                <p className="text-[13px] leading-5 text-muted-foreground">Account: {enrolment.account} · time-based</p>
              </div>
            </div></>,
          <><p className="text-[15px] font-semibold leading-6">Enter the 6-digit code the app shows</p>
            <Input id="mfa-setup-code" label="6-digit code" name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="123456" width="sm" className="[&_input]:font-mono [&_input]:text-lg [&_input]:tracking-[.3em]" error={error || undefined} /></>,
        ].map((content, index) => <li key={index} className="relative grid gap-3 pl-10"><span aria-hidden="true" className="absolute left-0 top-0 grid size-7 place-items-center rounded-full bg-muted text-[13px] font-semibold">{index + 1}</span>{content}</li>)}
      </ol>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size={signIn ? 'lg' : 'default'} disabled={pending} className={signIn ? 'w-full' : undefined}>{pending ? 'Confirming…' : 'Turn on two-step verification'}</Button>
        {onCancel && <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
    {signIn && <div className="mt-2"><BackToSignIn /></div>}
  </div>;
}
