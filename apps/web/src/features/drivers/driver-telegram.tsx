'use client';
import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/alert';
import { errorMessage, mutate, readApi } from '@/lib/client-api';

interface TelegramView { available: boolean; connected: boolean }
// The connect link works once, for 30 minutes; after that it is dropped from the page.
const LINK_MS = 30 * 60_000;

/**
 * Get reminders on Telegram (designed as ReminderConnectPhoneScreen), offered once the driver has sent their application
 * or a renewed document, while their verified session lasts. It shows nothing when Telegram isn't switched on, the API
 * doesn't have it yet, or the session ended. Without Telegram, reminders come by email.
 */
export function DriverTelegram() {
  const [view, setView] = useState<TelegramView | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [pending, setPending] = useState<'link' | 'check' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    // Any failure (an older API, Telegram off, the session over) leaves the section out.
    readApi<TelegramView>('driver/telegram').then(result => { if (live) setView(result); }, () => undefined);
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!link) return;
    const timer = window.setTimeout(() => setLink(null), LINK_MS);
    return () => window.clearTimeout(timer);
  }, [link]);
  if (!view?.available) return null;
  async function run(kind: 'link' | 'check') {
    if (pending) return;
    setPending(kind); setError(''); setMessage('');
    try {
      if (kind === 'link') setLink((await mutate<{ url: string }>('driver/telegram/connect', 'POST')).url);
      else {
        const updated = await mutate<TelegramView>('driver/telegram/check', 'POST');
        setView(updated);
        if (updated.connected) setLink(null); else setMessage('Not connected yet. Tap Start in Telegram, then check again.');
      }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(null); }
  }
  return <section className="space-y-3 border-t border-border pt-5" aria-labelledby="driver-telegram">
    <h2 id="driver-telegram" className="text-lg font-medium">Get reminders on Telegram</h2>
    {view.connected ? <p className="text-sm">Connected. We’ll remind you on Telegram before your license or medical card expires. Send /stop to the bot to turn this off.</p> : <>
      <p className="text-sm text-muted-foreground">We’ll message you before your license or medical card expires, with a link to send the new one. Nothing else, and never your personal details.</p>
      {link ? <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="lg" asChild><a href={link} target="_blank" rel="noopener noreferrer"><Send aria-hidden="true" className="size-4" />Open Telegram</a></Button>
        <Button size="lg" variant="outline" disabled={!!pending} onClick={() => void run('check')}>{pending === 'check' ? 'Checking…' : 'I tapped Start'}</Button>
      </div> : <Button size="lg" className="w-full" disabled={!!pending} onClick={() => void run('link')}><Send aria-hidden="true" className="size-4" />{pending === 'link' ? 'Preparing…' : 'Connect Telegram'}</Button>}
      <p className="text-[13px] text-muted-foreground">Opens Telegram. Tap Start there. Send /stop any time to turn reminders off. Without Telegram we email you instead.</p>
    </>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    <Notice message={error} error />
  </section>;
}
