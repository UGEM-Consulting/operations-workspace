"use client";
import { useState } from 'react';
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
import { mutate } from '@/lib/client-api';
import { MfaSetup, RecoveryCodes } from './mfa-setup';
import { PasswordChangeForm } from './password-change-form';
export interface MfaStatus { enabled: boolean; required: boolean; policy: string; enabledAt: string | null; recoveryCodesRemaining: number }

/** Confirms an action with an authenticator code. Recovery codes look like XXXXX-XXXXX, so those forms use a text keyboard. */
function CodeDialog({ title, description, label, action, pendingLabel, danger = false, recovery = false, onSubmit, onClose }: {
  title: string; description: string; label: string; action: string; pendingLabel: string; danger?: boolean; recovery?: boolean; onSubmit: (code: string) => Promise<void>; onClose: () => void;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPending(true);
    try { await onSubmit(String(new FormData(event.currentTarget).get('code') ?? '').trim()); }
    catch (error) { setError(error instanceof Error ? error.message : 'Request failed'); setPending(false); }
  }
  return <Dialog open size="sm" tone={danger ? 'danger' : undefined} onClose={onClose} busy={pending} protectChanges={false} title={title} description={description}
    actions={<Button type="submit" form="code-dialog" variant={danger ? 'destructive' : 'default'} disabled={pending}>{pending ? pendingLabel : action}</Button>}>
    <form id="code-dialog" onSubmit={submit}>
      <Input label={label} name="code" required autoFocus inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" pattern={recovery ? '[0-9A-Za-z-]{6,11}' : '[0-9]{6}'} maxLength={recovery ? 11 : 6}
        placeholder={recovery ? '123456 or ABCDE-23456' : '123456'} hint={recovery ? 'Or enter one of your recovery codes.' : undefined} width="sm" className="[&_input]:font-mono [&_input]:tracking-wider" error={error || undefined} />
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
  return <>
    <Card>
      <CardHeader title="Two-step verification" description={`A code from your phone after your password.${status.required ? ' Your role requires it.' : ''}`} actions={<Badge label={status.enabled ? 'On' : 'Off'} tone={status.enabled ? 'success' : 'neutral'} />} />
      <CardBody>
        {status.enabled ? <DescriptionList layout="rows" items={[{ label: 'Authenticator app', value: status.enabledAt ? <>Added <LocalTime iso={status.enabledAt} format="date" /></> : 'Added' }]} />
          : settingUp ? <MfaSetup doneLabel="Done" onComplete={reload} onCancel={() => setSettingUp(false)} />
          : <div className="space-y-3"><p className="text-sm text-muted-foreground">Turning it on ends your other signed-in sessions.</p><Button onClick={() => setSettingUp(true)}>Set up two-step verification</Button></div>}
      </CardBody>
    </Card>
    {status.enabled && (codes ? <Card>
      <CardHeader title="New recovery codes" description="Your old codes no longer work." />
      <CardBody><RecoveryCodes codes={codes} doneLabel="Done" onDone={() => { setCodes(null); router.refresh(); }} /></CardBody>
    </Card> : <Card>
      <CardHeader title="Recovery codes" description="Each code signs you in once if you lose your phone." />
      <CardBody className="space-y-2"><Progress label="Codes left" value={status.recoveryCodesRemaining} max={10} />{low && <p className="text-[13px] leading-5 text-warning">Few codes left. Make new codes soon.</p>}</CardBody>
      <CardFooter><p className="text-[13px] leading-5 text-muted-foreground">Making new codes cancels the old ones.</p><Button variant="outline" onClick={() => setDialog('codes')}><RefreshCw aria-hidden="true" className="size-4" />Make new codes</Button></CardFooter>
    </Card>)}
    {status.enabled && !status.required && <Card>
      <CardHeader title="Turn off two-step verification" description="Your role doesn’t require it. Your other signed-in sessions will end." />
      <CardBody><Button variant="outline" className="text-danger" onClick={() => setDialog('off')}>Turn off</Button></CardBody>
    </Card>}
    {dialog === 'codes' && <CodeDialog title="Make new recovery codes?" description="Your current recovery codes stop working. Enter a code from your authenticator app to continue." label="Authenticator code" action="Make new codes" pendingLabel="Making codes…"
      onClose={() => setDialog(null)} onSubmit={async code => { const result = await mutate('auth/mfa/recovery-codes', 'POST', { code }); setDialog(null); setCodes(result.recoveryCodes); }} />}
    {dialog === 'off' && <CodeDialog danger recovery title="Turn off two-step verification?" description="Your other signed-in sessions will end, and only your password will protect your account." label="Authenticator code" action="Turn off" pendingLabel="Turning off…"
      onClose={() => setDialog(null)} onSubmit={async code => { await mutate('auth/mfa/disable', 'POST', { code }); reload(); }} />}
  </>;
}
