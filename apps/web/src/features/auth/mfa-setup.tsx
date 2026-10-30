"use client";
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Download } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, RadioGroup } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { ApiError, errorMessage, mutate, readApi } from '@/lib/client-api';
import { ResendCode, type EmailCodeSent } from './email-code';
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


type Method = 'TOTP' | 'EMAIL';
type Started = ({ method: 'TOTP' } & Enrolment) | ({ method: 'EMAIL' } & EmailCodeSent);
const stepTitles: Record<Method, string> = { TOTP: 'Set up two-step verification', EMAIL: 'Turn on email codes' };

/**
 * Enrolment: choose a method when email codes are allowed (never for administrators), then confirm one code: from an
 * authenticator app (scan the QR code or type the key) or emailed to the account email. Then the recovery codes.
 * `signIn` renders the sign-in page's step count and headings; on Account security the surrounding card provides them.
 */
export function MfaSetup({ onComplete, onCancel, doneLabel = 'Continue to workspace', signIn = false }: { onComplete?: (landingPage: string) => void; onCancel?: () => void; doneLabel?: string; signIn?: boolean }) {
  const [options, setOptions] = useState<{ methods: Method[]; email: string } | null>(null);
  const [choice, setChoice] = useState<Method>('TOTP');
  const [started, setStarted] = useState<Started | null>(null);
  const [sentAt, setSentAt] = useState(0);
  const [result, setResult] = useState<{ codes: string[]; landingPage: string } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);
  const loaded = useRef(false);
  // Each start replaces the unconfirmed key, so a second start while one is in flight could leave a QR code for a
  // replaced secret. The ref stops re-entry at once; the state shows it.
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  async function begin(method: Method, resend = false) {
    if (startingRef.current) return;
    startingRef.current = true; setStarting(true);
    setError(''); setResending(resend);
    // Older clients sent no body, which the API still treats as an authenticator app.
    try { setStarted(await mutate<Started>('auth/mfa/enrolment', 'POST', method === 'EMAIL' ? { method } : {})); setSentAt(Date.now()); }
    catch (error) { setError(signInExpired(error instanceof Error ? error.message : 'Unable to start setup')); }
    finally { startingRef.current = false; setStarting(false); setResending(false); }
  }
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    // With one method there is nothing to choose: start at once. Each start replaces the unconfirmed key, so once per visit.
    readApi<{ methods: Method[]; email: string }>('auth/mfa/methods').then(data => {
      if (data.methods.length > 1) setOptions(data); else void begin('TOTP');
    }, error => {
      // An API older than email codes has no methods route; everyone uses an authenticator app there.
      if (error instanceof ApiError && error.status === 404) void begin('TOTP');
      else setError(signInExpired(errorMessage(error, 'Unable to start setup')));
    });
  }, []);
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
  const viaEmail = started?.method === 'EMAIL';
  const lost = viaEmail ? 'If you can’t get into your email' : 'If you lose your phone';
  if (result) return <div>
    {signIn ? <><StepCount current={1} /><SignInHeading title="Save your recovery codes" description={`${lost}, each code signs you in once instead.`} /></>
      : <><h3 className="font-semibold">Two-step verification is on. Save your recovery codes</h3><p className="mt-1 text-sm text-muted-foreground">{lost}, each code signs you in once instead.</p></>}
    <div className="mt-5"><RecoveryCodes codes={result.codes} onDone={done} doneLabel={doneLabel} /></div>
  </div>;
  const heading = signIn && <><StepCount current={0} /><SignInHeading title={stepTitles[viaEmail ? 'EMAIL' : 'TOTP']} description="Your account must use it. It takes about two minutes and protects the workspace if your password is ever stolen." /></>;
  const cancel = onCancel && <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancel</Button>;
  const back = signIn && <div className="mt-2"><BackToSignIn /></div>;
  if (!started && options) return <div>
    {heading}
    <div className="mt-6 space-y-5">
      <RadioGroup name="mfaMethod" label="How do you want to get your codes?" cards value={choice} onChange={value => setChoice(value as Method)} options={[
        { value: 'TOTP', label: 'Authenticator app (recommended)', description: 'Google Authenticator, Microsoft Authenticator or 1Password. Works even without email or signal.' },
        { value: 'EMAIL', label: 'Email codes', description: `We email a 6-digit code to ${options.email} each time you sign in.` },
      ]} />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-3"><Button type="button" size={signIn ? 'lg' : 'default'} className={signIn ? 'w-full' : undefined} disabled={starting} onClick={() => void begin(choice)}>{starting ? 'Starting…' : 'Continue'}</Button>{cancel}</div>
    </div>
    {back}
  </div>;
  if (!started) return <div>{heading}<div className="mt-6 space-y-4">{error ? <><p role="alert" className="text-sm text-danger">{error}</p>{signIn && <BackToSignIn />}</> : <p role="status" className="text-sm text-muted-foreground">Preparing your setup…</p>}</div></div>;
  const codeField = <Input id="mfa-setup-code" label="6-digit code" name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="123456" width="sm" className="[&_input]:font-mono [&_input]:text-lg [&_input]:tracking-[.3em]" error={error || undefined} />;
  const submit = <div className="flex flex-wrap gap-3">
    <Button type="submit" size={signIn ? 'lg' : 'default'} disabled={pending} className={signIn ? 'w-full' : undefined}>{pending ? 'Confirming…' : viaEmail ? 'Turn on email codes' : 'Turn on two-step verification'}</Button>
    {cancel}
  </div>;
  if (started.method === 'EMAIL') return <div>
    {heading}
    <form onSubmit={confirm} className="mt-6 space-y-4">
      <p className="text-sm leading-6">We emailed a 6-digit code to <span className="font-medium">{started.sentTo}</span>. Enter it to turn on email codes. It expires in 10 minutes.</p>
      {codeField}
      <ResendCode sent={started} sentAt={sentAt} pending={resending} onResend={() => void begin('EMAIL', true)} />
      {submit}
    </form>
    {back}
  </div>;
  return <div>
    {heading}
    <form onSubmit={confirm}>
      <ol className="my-6 grid gap-6">
        {[
          <><p className="text-[15px] font-semibold leading-6">Install an authenticator app</p><p className="text-[13px] leading-5 text-muted-foreground">Google Authenticator, Microsoft Authenticator or 1Password all work.</p></>,
          <><p className="text-[15px] font-semibold leading-6">Scan this QR code with the app</p>
            <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
              {/* eslint-disable-next-line @next/next/no-img-element -- server-generated data URL */}
              <img src={started.qrCode} alt={`QR code to add ${started.account} to your authenticator app`} width={168} height={168} className="size-42 rounded-md border border-border bg-white p-2 max-sm:mx-auto" />
              <div className="min-w-0 space-y-3">
                <p className="text-[13px] leading-5 text-muted-foreground">Can’t scan? In the app choose “Enter a setup key” and type this key.</p>
                <div><p className="text-sm font-medium">Setup key</p><code className="mt-1 block break-all rounded-sm border border-border bg-muted px-3 py-2 font-mono text-[15px] tracking-wider">{started.manualKey}</code></div>
                <div className="flex flex-wrap items-center gap-3"><CopyButton text={started.manualKey.replace(/\s+/g, '')} label="Copy key" /><a href={started.uri} className="text-sm text-primary underline-offset-4 hover:underline sm:hidden">Open in authenticator app</a></div>
                <p className="text-[13px] leading-5 text-muted-foreground">Account: {started.account} · time-based</p>
              </div>
            </div></>,
          <><p className="text-[15px] font-semibold leading-6">Enter the 6-digit code the app shows</p>{codeField}</>,
        ].map((content, index) => <li key={index} className="relative grid gap-3 pl-10"><span aria-hidden="true" className="absolute left-0 top-0 grid size-7 place-items-center rounded-full bg-muted text-[13px] font-semibold">{index + 1}</span>{content}</li>)}
      </ol>
      {submit}
    </form>
    {back}
  </div>;
}
