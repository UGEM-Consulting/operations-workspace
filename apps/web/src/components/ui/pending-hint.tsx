'use client';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export const coldStartMessage = 'Starting the service, this can take up to a minute.';

/** True once `pending` has lasted `delay` ms; resets as soon as it ends. */
export function usePendingHint(pending: boolean, delay = 5000) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setSlow(true), delay);
    return () => { window.clearTimeout(timer); setSlow(false); };
  }, [pending, delay]);
  return pending && slow;
}

/**
 * Shown under a pending save, decision or load after ~5 seconds: the API may be waking from sleep.
 * The live region is always mounted so the message is announced when it appears.
 */
export function PendingHint({ pending, className }: { pending: boolean; className?: string }) {
  const slow = usePendingHint(pending);
  return <p role="status" aria-live="polite" className={cn('text-[13px] leading-5 text-muted-foreground', !slow && 'sr-only', className)}>{slow ? coldStartMessage : ''}</p>;
}
