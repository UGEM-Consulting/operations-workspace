"use client";
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/feedback';
import { Input } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { errorMessage, mutate } from '@/lib/client-api';
import { ResendCode, type EmailCodeSent } from './email-code';
import { MfaSetup, RecoveryCodes } from './mfa-setup';
import { PasswordChangeForm } from './password-change-form';
export interface MfaStatus { enabled: boolean; required: boolean; policy: string; enabledAt: string | null; recoveryCodesRemaining: number;
  method?: 'TOTP' | 'EMAIL' | null; emailCodesAvailable?: boolean; email?: string }

/**
 * Confirms an action with a current code: from the authenticator app, or (email codes) one emailed when the dialog
 * opens for this purpose. Recovery codes look like XXXXX-XXXXX, so those forms use a text keyboard.
 */
function CodeDialog({ title, description, action, pendingLabel, viaEmail, danger = false, recovery = false, onSubmit, onClose }: {
  title: string; description: string; action: string; pendingLabel: string; viaEmail: boolean; danger?: boolean; recovery?: boolean; onSubmit: (code: string) => Promise<void>; onClose: () => void;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<EmailCodeSent | null>(null);
  const [sentAt, setSentAt] = useState(0);
  const [sending, setSending] = useState(false);
  const requested = useRef(false);
  async function send() {
    setSending(true); setError('');
    try { setSent(await mutate<EmailCodeSent>('auth/mfa/email-code', 'POST')); setSentAt(Date.now()); }
    catch (error) { setError(errorMessage(error, 'The code could not be emailed.')); }
    finally { setSending(false); }
  }
  useEffect(() => { if (viaEmail && !requested.current) { requested.current = true; void send(); } }, [viaEmail]);
  const label = viaEmail ? 'Email code' : 'Authenticator code';
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPending(true);
    try { await onSubmit(String(new FormData(event.currentTarget).get('code') ?? '').trim()); }
    catch (error) { setError(error instanceof Error ? error.message : 'Request failed'); setPending(false); }
  }
  return <Dialog open size="sm" tone={danger ? 'danger' : undefined} onClose={onClose} busy={pending} protectChanges={false} title={title} description={description}
    actions={<Button type="submit" form="code-dialog" variant={danger ? 'destructive' : 'default'} disabled={pending}>{pending ? pendingLabel : action}</Button>}>
    <form id="code-dialog" onSubmit={submit} className="space-y-3">
      {viaEmail && <p role="status" className="text-sm">{sent ? <>We emailed a 6-digit code to <span className="font-medium">{sent.sentTo}</span>.</> : sending ? 'Sending a code to your email…' : null}</p>}
      <Input label={label} name="code" required autoFocus inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" pattern={recovery ? '[0-9A-Za-z-]{6,11}' : '[0-9]{6}'} maxLength={recovery ? 11 : 6}
        placeholder={recovery ? '123456 or ABCDE-23456' : '123456'} hint={recovery ? 'Or enter one of your recovery codes.' : undefined} width="sm" className="[&_input]:font-mono [&_input]:tracking-wider" error={error || undefined} />
      {viaEmail && sent && <ResendCode sent={sent} sentAt={sentAt} pending={sending} onResend={() => void send()} />}
    </form>
  </Dialog>;
}

/** Own password: other sessions end, this one continues. */
export function PasswordSettings({ account }: { account: string }) {
  return <Card>
    <CardHeader title="Password" description="Changing it signs you out everywhere else." />
    <CardBody><PasswordChangeForm account={account} /></CardBody>
  </Card>;
}

export function AccountSecurity({ status }: { status: MfaStatus }) {
  const router = useRouter();
  const [settingUp, setSettingUp] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [dialog, setDialog] = useState<'codes' | 'off' | null>(null);
  // Turning MFA on or off regenerates this session; a full navigation discards the old router cache.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  const reload = () => window.location.assign('/account/security');
  const low = status.recoveryCodesRemaining <= 3;
  const viaEmail = status.method === 'EMAIL';
  const lost = viaEmail ? 'if you can’t get into your email' : 'if you lose your phone';
  return <>
    <Card>
      <CardHeader title="Two-step verification" description={`${viaEmail ? 'A code by email' : 'A code from your phone'} after your password.${status.required ? ' Your role requires it.' : ''}`} actions={<Badge label={status.enabled ? 'On' : 'Off'} tone={status.enabled ? 'success' : 'neutral'} />} />
      <CardBody>
        {status.enabled ? <DescriptionList layout="rows" items={[
          { label: 'Method', value: viaEmail ? `Email codes to ${status.email ?? 'your account email'}` : 'Authenticator app' },
          { label: 'Turned on', value: status.enabledAt ? <LocalTime iso={status.enabledAt} format="date" /> : null },
        ]} />
          : settingUp ? <MfaSetup doneLabel="Done" onComplete={reload} onCancel={() => setSettingUp(false)} />
          : <div className="space-y-3"><p className="text-sm text-muted-foreground">Turning it on ends your other signed-in sessions.</p><Button onClick={() => setSettingUp(true)}>Set up two-step verification</Button></div>}
      </CardBody>
    </Card>
    {status.enabled && (codes ? <Card>
      <CardHeader title="New recovery codes" description="Your old codes no longer work." />
      <CardBody><RecoveryCodes codes={codes} doneLabel="Done" onDone={() => { setCodes(null); router.refresh(); }} /></CardBody>
    </Card> : <Card>
      <CardHeader title="Recovery codes" description={`Each code signs you in once ${lost}.`} />
      <CardBody className="space-y-2"><Progress label="Codes left" value={status.recoveryCodesRemaining} max={10} />{low && <p className="text-[13px] leading-5 text-warning">Few codes left. Make new codes soon.</p>}</CardBody>
      <CardFooter><p className="text-[13px] leading-5 text-muted-foreground">Making new codes cancels the old ones.</p><Button variant="outline" onClick={() => setDialog('codes')}><RefreshCw aria-hidden="true" className="size-4" />Make new codes</Button></CardFooter>
    </Card>)}
    {status.enabled && !status.required && <Card>
      <CardHeader title="Turn off two-step verification" description="Your role doesn’t require it. Your other signed-in sessions will end." />
      <CardBody><Button variant="outline" className="text-danger" onClick={() => setDialog('off')}>Turn off</Button></CardBody>
    </Card>}
    {dialog === 'codes' && <CodeDialog viaEmail={viaEmail} title="Make new recovery codes?" description={`Your current recovery codes stop working. Enter ${viaEmail ? 'the code we email you' : 'a code from your authenticator app'} to continue.`} action="Make new codes" pendingLabel="Making codes…"
      onClose={() => setDialog(null)} onSubmit={async code => { const result = await mutate('auth/mfa/recovery-codes', 'POST', { code }); setDialog(null); setCodes(result.recoveryCodes); }} />}
    {dialog === 'off' && <CodeDialog viaEmail={viaEmail} danger recovery title="Turn off two-step verification?" description="Your other signed-in sessions will end, and only your password will protect your account." action="Turn off" pendingLabel="Turning off…"
      onClose={() => setDialog(null)} onSubmit={async code => { await mutate('auth/mfa/disable', 'POST', { code }); reload(); }} />}
  </>;
}
