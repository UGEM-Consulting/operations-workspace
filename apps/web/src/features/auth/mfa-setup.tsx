"use client";
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { inputClass } from '@/components/ui/field';
import { mutate } from '@/lib/client-api';
import { signInExpired } from './mfa-verify-form';
interface Enrolment { qrCode: string; uri: string; manualKey: string; issuer: string; account: string }

/** One-time display of recovery codes with copy and download. */
export function RecoveryCodes({ codes, onDone, doneLabel }: { codes: string[]; onDone: () => void; doneLabel: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `UGEM Workspace recovery codes\nEach code works once.\n\n${codes.join('\n')}\n`;
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: 'ugem-workspace-recovery-codes.txt' });
    link.click(); URL.revokeObjectURL(url);
  }
  return <div className="space-y-4">
    <p className="rounded-lg bg-warning-background p-3 text-sm text-warning">Save these recovery codes somewhere safe, such as your password manager. Each one signs you in once if you lose your phone. They will not be shown again.</p>
    <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-lg border bg-muted p-4 font-mono text-sm">{codes.map(code => <li key={code}>{code}</li>)}</ul>
    <div className="flex flex-wrap gap-3">
      <Button type="button" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Copied' : 'Copy codes'}</Button>
      <Button type="button" variant="outline" onClick={download}>Download</Button>
    </div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} className="size-4" />I have saved my recovery codes</label>
    <Button type="button" className="w-full" disabled={!saved} onClick={onDone}>{doneLabel}</Button>
  </div>;
}

/** Authenticator enrolment: QR code or manual key, then one code to confirm. */
export function MfaSetup({ onComplete, doneLabel = 'Continue to workspace' }: { onComplete?: (landingPage: string) => void; doneLabel?: string }) {
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
    } catch (error) { setError(signInExpired(error instanceof Error ? error.message : 'Unable to confirm the code')); }
    finally { setPending(false); }
  }
  // A full navigation picks up the regenerated session cookie.
  const done = () => onComplete ? onComplete(result!.landingPage) : window.location.assign(result!.landingPage);
  if (result) return <div className="mt-7"><h2 className="mb-4 text-lg font-semibold">Two-step verification is on</h2><RecoveryCodes codes={result.codes} onDone={done} doneLabel={doneLabel} /></div>;
  if (!enrolment) return <div className="mt-7 space-y-4">{error ? <><p role="alert" className="text-sm text-danger">{error}</p><Button asChild variant="outline"><a href="/login">Back to sign in</a></Button></> : <p role="status" className="text-sm text-muted-foreground">Preparing your setup key…</p>}</div>;
  return <div className="mt-7 space-y-6">
    <ol className="list-decimal space-y-2 pl-5 text-sm leading-6">
      <li>Install an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password.</li>
      <li>Scan this QR code with the app, or enter the setup key below.</li>
      <li>Enter the 6-digit code the app shows.</li>
    </ol>
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      {/* eslint-disable-next-line @next/next/no-img-element -- server-generated data URL */}
      <img src={enrolment.qrCode} alt={`QR code to add ${enrolment.account} to your authenticator app`} width={176} height={176} className="rounded-lg border bg-white p-2" />
      <div className="min-w-0 space-y-2 text-sm">
        <p className="text-muted-foreground">Can’t scan? Choose “enter a setup key” in the app.</p>
        <p><span className="text-muted-foreground">Account:</span> {enrolment.issuer} ({enrolment.account})</p>
        <p className="text-muted-foreground">Key (time-based):</p>
        <code className="block break-all rounded-lg bg-muted px-3 py-2 font-mono text-base">{enrolment.manualKey}</code>
        <a href={enrolment.uri} className="inline-block text-primary underline-offset-4 hover:underline sm:hidden">Open in authenticator app</a>
      </div>
    </div>
    <form onSubmit={confirm} className="space-y-4">
      <label className="block text-sm font-medium">6-digit code<input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="123456" className={`${inputClass} font-mono text-lg tracking-[.3em]`} /></label>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending} className="w-full">{pending ? 'Confirming…' : 'Turn on two-step verification'}</Button>
    </form>
  </div>;
}
