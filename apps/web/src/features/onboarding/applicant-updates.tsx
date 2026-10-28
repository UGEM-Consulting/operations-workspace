'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/alert';
import { mutate } from '@/lib/client-api';
import { readApi } from './types';

interface Updates { email: boolean; telegram: boolean; emailAvailable: boolean; telegramAvailable: boolean; telegramConnected: boolean; telegramUsername: string | null }
type Pending = 'save' | 'link' | 'check' | 'disconnect' | null;

/** The applicant chooses email, Telegram or both for decision updates, and connects the company Telegram bot. */
export function ApplicantUpdates({ email }: { email: string | null }) {
 const [data, setData] = useState<Updates | null>(null), [pending, setPending] = useState<Pending>(null);
 const [message, setMessage] = useState(''), [error, setError] = useState(''), [link, setLink] = useState<string | null>(null);
 useEffect(() => { let active = true; readApi<Updates>('applicant/updates').then(value => { if (active) setData(value); }).catch(() => { if (active) setError('Your update choices could not be loaded. Refresh the page to try again.'); }); return () => { active = false; }; }, []);
 async function run(kind: Pending, action: () => Promise<Updates | null>, success: string | ((updated: Updates) => string)) {
  if (pending) return;
  setPending(kind); setMessage(''); setError('');
  try { const updated = await action(); if (updated) setData(updated); setMessage(typeof success === 'string' ? success : updated ? success(updated) : ''); }
  catch (failure) { setError(failure instanceof Error ? failure.message : 'Something went wrong. Please try again.'); }
  finally { setPending(null); }
 }
 if (!data) return error ? <Notice message={error} error /> : <p role="status" className="text-sm text-muted-foreground">Loading your update choices…</p>;
 const choose = (next: { email: boolean; telegram: boolean }) => {
  if (!next.email && !next.telegram) { setError('Choose at least one way to receive updates.'); return; }
  void run('save', () => mutate('applicant/updates', 'PATCH', next), 'Your update choices were saved.');
 };
 const busy = !!pending;
 return <fieldset className="space-y-4 rounded-md border border-border p-4" aria-describedby="updates-help">
  <legend className="px-1 text-sm font-semibold">How should we tell you about decisions?</legend>
  <p id="updates-help" className="text-sm text-muted-foreground">We send a short message when your manager approves your application, asks for changes or closes it. Messages include your application reference but never your personal details.</p>
  <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={data.email} disabled={busy} onChange={event => choose({ email: event.target.checked, telegram: data.telegram })} />
   <span>Email{email && <span className="text-muted-foreground"> to {email}</span>}{!data.emailAvailable && <span className="block text-muted-foreground">Email updates are not switched on yet; check this page instead.</span>}</span></label>
  <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={data.telegram} disabled={busy || (!data.telegramAvailable && !data.telegram)} onChange={event => choose({ email: data.email, telegram: event.target.checked })} />
   <span>Telegram{!data.telegramAvailable && <span className="block text-muted-foreground">Not available yet.</span>}</span></label>
  {data.telegram && data.telegramAvailable && (data.telegramConnected
   ? <div className="flex flex-wrap items-center justify-between gap-3 text-sm"><p>Connected to Telegram{data.telegramUsername ? ` as @${data.telegramUsername}` : ''}.</p>
     <Button type="button" variant="outline" disabled={busy} onClick={() => void run('disconnect', () => mutate('applicant/updates/telegram/disconnect', 'POST'), 'Telegram disconnected. We will email you instead.')}>{pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect Telegram'}</Button></div>
   : <div className="space-y-3 text-sm">
     {!data.email && <p className="text-warning">Until Telegram is connected, we can’t send you any updates.</p>}
     <ol className="list-decimal space-y-1 pl-5"><li>Press <strong>Connect Telegram</strong>, then open the link. It opens our company bot in Telegram.</li><li>Press <strong>Start</strong> in Telegram.</li><li>Come back here and press <strong>Check connection</strong>.</li></ol>
     <div className="flex flex-wrap gap-3">
      {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary-hover">Open Telegram</a>
       : <Button type="button" disabled={busy} onClick={() => void run('link', async () => { const result: { url: string } = await mutate('applicant/updates/telegram', 'POST'); setLink(result.url); return null; }, 'Your connect link is ready. It works once and expires in 30 minutes.')}>{pending === 'link' ? 'Preparing…' : 'Connect Telegram'}</Button>}
      <Button type="button" variant="outline" disabled={busy} onClick={() => void run('check', () => mutate('applicant/updates/telegram/check', 'POST'), updated => updated.telegramConnected ? 'Telegram is connected.' : 'Not connected yet. Press Start in Telegram, then check again.')}>{pending === 'check' ? 'Checking…' : 'Check connection'}</Button>
     </div></div>)}
  <Notice message={message} /><Notice message={error} error />
 </fieldset>;
}
