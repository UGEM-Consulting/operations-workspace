'use client';
import { useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Notice } from '@/components/ui/alert';
import { Badge } from '@/components/ui/status-badge';
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
export interface StaffTelegram { available: boolean; connected: boolean; username: string | null; alerts: ('REVIEW_WAITING' | 'IT_SETUP_WAITING')[] }
const alertText = { REVIEW_WAITING: 'an application assigned to you is waiting for review', IT_SETUP_WAITING: 'a new IT setup checklist is waiting' };
type Pending = 'link' | 'check' | 'disconnect' | null;

/** The staff member's own Telegram connection for workspace alerts, through the company bot. */
export function TelegramAlerts({ initial }: { initial: StaffTelegram }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [link, setLink] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState('');
  async function run(kind: Pending, action: () => Promise<StaffTelegram | null>, success: (updated: StaffTelegram | null) => string) {
    if (pending) return;
    setPending(kind); setError('');
    try { const updated = await action(); if (updated) setData(updated); const title = success(updated); if (title) toast({ title }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(null); }
  }
  const what = data.alerts.length ? `when ${data.alerts.map(alert => alertText[alert]).join(', or when ')}` : 'about work waiting for you';
  return <Card>
    <CardHeader title="Telegram alerts" description={`A Telegram message ${what}. Alerts link to the workspace and never include names or personal details.`}
      actions={<Badge label={data.connected ? 'Connected' : 'Off'} tone={data.connected ? 'success' : 'neutral'} />} />
    <CardBody className="space-y-4">
      {!data.available ? <p className="text-sm text-muted-foreground">Telegram alerts are not switched on for this workspace yet.</p>
        : data.connected ? <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p>Connected{data.username ? ` as @${data.username}` : ''}. Send /stop to the bot to turn alerts off from Telegram.</p>
          <Button type="button" variant="outline" disabled={!!pending} onClick={() => void run('disconnect', () => mutate<StaffTelegram>('staff/telegram/disconnect', 'POST'), () => 'Telegram alerts turned off.')}>{pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</Button>
        </div>
        : <div className="space-y-3 text-sm">
          <ol className="list-decimal space-y-1 pl-5">
            <li>Press <strong>Connect Telegram</strong>, then <strong>Open Telegram</strong>. It opens the company bot.</li>
            <li>Press <strong>Start</strong> in Telegram.</li>
            <li>Come back here and press <strong>Check connection</strong>.</li>
          </ol>
          <div className="flex flex-wrap gap-3">
            {link ? <Button asChild><a href={link} target="_blank" rel="noopener noreferrer"><Send aria-hidden="true" className="size-4" />Open Telegram</a></Button>
              : <Button type="button" disabled={!!pending} onClick={() => void run('link', async () => { setLink((await mutate<{ url: string }>('staff/telegram/connect', 'POST')).url); return null; }, () => 'Your connect link is ready. It works once, for 30 minutes.')}>{pending === 'link' ? 'Preparing…' : 'Connect Telegram'}</Button>}
            <Button type="button" variant="outline" disabled={!!pending} onClick={() => void run('check', () => mutate<StaffTelegram>('staff/telegram/check', 'POST'), updated => updated?.connected ? 'Telegram is connected.' : 'Not connected yet. Press Start in Telegram, then check again.')}>{pending === 'check' ? 'Checking…' : 'Check connection'}</Button>
          </div>
        </div>}
      <PendingHint pending={!!pending} /><Notice message={error} error />
    </CardBody>
  </Card>;
}
