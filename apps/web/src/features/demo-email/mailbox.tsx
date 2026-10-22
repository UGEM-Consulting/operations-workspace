'use client';
import { useEffect, useState } from 'react';
import { mutate } from '@/lib/client-api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
interface Message { id: string; challengeId: string; email: string; expiresAt: string; createdAt: string; }
export function DemoMailbox({ messages }: { messages: Message[] }) {
  const [revealed, setRevealed] = useState<{ id: string; code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!revealed) return;
    // Clear the visible code after at most 30 seconds. Nothing enters storage.
    const timer = setTimeout(() => setRevealed(null), Math.max(0, Math.min(30000, Date.parse(revealed.expiresAt) - Date.now())));
    const hide = () => { if (document.hidden) setRevealed(null); };
    document.addEventListener('visibilitychange', hide);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', hide); };
  }, [revealed]);
  async function reveal(id: string) {
    setBusy(true); setError(''); setRevealed(null);
    try { const result = await mutate(`demo-mailbox/${id}/reveal`, 'POST'); setRevealed({ id, ...result }); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to reveal code'); }
    finally { setBusy(false); }
  }
  return <div className="mt-6 space-y-4">
    <p className="text-sm text-muted-foreground">Demo-only simulated delivery. Managers can access only their own invitations; administrators can access all demo invitations. Use the applicant’s verification reference to locate their fictional message. Each reveal is audited. Codes remain valid for ten minutes and one successful verification.</p>
    <Button variant="outline" onClick={() => window.location.reload()}>Refresh mailbox</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!messages.length && <Card className="p-6">No pending verification messages. Ask the applicant to select Verify access.</Card>}
    {messages.map(message => <Card key={message.id} className="space-y-3 p-6">
      <p className="font-medium">{message.email}</p><p className="break-all font-mono text-xs">Reference: {message.challengeId}</p>
      <p className="text-sm text-muted-foreground">Expires: {new Date(message.expiresAt).toLocaleString()}</p>
      {revealed?.id === message.id ? <div className="space-y-2"><p aria-live="polite" className="font-mono text-2xl tracking-widest">{revealed.code}</p><Button variant="outline" onClick={() => setRevealed(null)}>Hide code</Button><p className="text-xs text-muted-foreground">Automatically hidden after 30 seconds. Share only with this fictional applicant during the demonstration.</p></div>
        : <Button disabled={busy} onClick={() => reveal(message.id)}>Reveal verification code</Button>}
    </Card>)}
  </div>;
}
