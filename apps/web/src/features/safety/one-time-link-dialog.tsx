'use client';
import { useCallback, useEffect, useState } from 'react';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { LocalTime } from '@/components/ui/local-time';
import { useLeaveGuard } from '@/components/shell-context';

const WARNING = 'Leave without copying the driver’s link? It can’t be shown again.';

/**
 * A driver application link, shown once. Until it is copied, closing the dialog, reloading or leaving the page (shell
 * links never fire beforeunload, so the shell asks the leave guard) asks first, like an uncopied invitation link.
 */
export function OneTimeLinkDialog({ link, email, title, description, onClose, children }: {
  link: { url: string; expiresAt: string }; email: string | null; title: string; description: string; onClose: () => void; children?: React.ReactNode;
}) {
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
  return <Dialog open onClose={close} title={title} description={description} closeLabel="Done" protectChanges={false}>
    <div className="space-y-3">
      {children}
      <p className="break-all rounded-md bg-muted p-3 font-mono text-[13px]">{link.url}</p>
      <CopyButton text={link.url} label="Copy link" onCopied={() => setCopied(true)} />
      <p className="text-sm text-muted-foreground">It works until <LocalTime iso={link.expiresAt} format="date" /> and only with {email}; the driver gets a code by email each time they open it.</p>
    </div>
  </Dialog>;
}
