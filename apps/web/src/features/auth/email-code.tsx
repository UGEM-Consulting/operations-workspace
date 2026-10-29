"use client";
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
/** Where an emailed code went and when another may be requested (the API's resendAfter, in seconds). */
export interface EmailCodeSent { sentTo: string; resendAfter: number }

/** Counts down from `seconds` each time `sentAt` changes. */
function useCountdown(seconds: number, sentAt: number) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, seconds - Math.floor((Date.now() - sentAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [seconds, sentAt]);
  return left;
}

/** "Send a new code", available once the short wait after the previous code has passed. */
export function ResendCode({ sent, sentAt, pending, onResend }: { sent: EmailCodeSent; sentAt: number; pending: boolean; onResend: () => void }) {
  const left = useCountdown(sent.resendAfter, sentAt);
  return <p className="text-[13px] leading-5 text-muted-foreground">
    Didn’t get it? Check your Spam folder, or{' '}
    <Button type="button" variant="link" className="inline min-h-0 px-0 align-baseline text-[13px]" disabled={pending || left > 0} onClick={onResend}>{pending ? 'sending…' : 'send a new code'}</Button>
    {left > 0 && <span aria-live="off"> in {left} s</span>}.
  </p>;
}
