'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { useLeaveGuard } from '@/components/shell-context';

// A team lead's sign-in names it so, and labels the email as the company email they sign in with.
export interface ReadyPassword { kind: 'created' | 'reset'; name: string; firstName: string; email: string; password: string; title?: string; emailLabel?: string }
const WARNING = 'Leave without copying this password? It can’t be shown again.';

function CopyRow({ label, value, onCopied }: { label: string; value: string; onCopied?: () => void }) {
  return <div><p className="mb-1 text-sm font-medium">{label}</p><div className="flex flex-wrap items-center gap-2"><p className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-[13px]">{value}</p><CopyButton text={value} label="Copy" size="sm" onCopied={onCopied} /></div></div>;
}
/**
 * A generated staff password, shown once and held only here. Until it is copied, closing, reloading or leaving the page asks first
 * (shell links never fire beforeunload, so the shell asks the leave guard), like an uncopied invitation link.
 */
export function PasswordReadyDialog({ ready, onClose }: { ready: ReadyPassword; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (copied) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [copied]);
  const leaveGuard = useCallback(() => window.confirm(WARNING), []);
  useLeaveGuard(copied ? null : leaveGuard);
  const close = () => { if (copied || window.confirm(WARNING)) onClose(); };
  const label = ready.kind === 'created' ? 'First password' : 'New password';
  const signIn = `${window.location.origin}/login`;
  return <Dialog open onClose={close} protectChanges={false} closeLabel="Close" title={ready.title ?? (ready.kind === 'created' ? `Account created for ${ready.name}` : `New password for ${ready.name}`)}
    description={`Copy these and send them to ${ready.firstName}.`} actions={<Button type="button" onClick={close}>I’ve copied it</Button>}>
    <div className="space-y-3">
      <CopyRow label="Sign-in page" value={signIn} />
      <CopyRow label={ready.emailLabel ?? 'Email'} value={ready.email} />
      <CopyRow label={label} value={ready.password} onCopied={() => setCopied(true)} />
      <CopyButton text={`Sign-in page: ${signIn}\n${ready.emailLabel ?? 'Email'}: ${ready.email}\n${label}: ${ready.password}`} label="Copy all three" onCopied={() => setCopied(true)} />
      <Alert tone="warning" title="You won’t see this password again"><p>Send it to them privately, not in a group chat. They choose their own password when they first sign in.</p></Alert>
    </div>
  </Dialog>;
}
