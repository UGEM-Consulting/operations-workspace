'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SESSION_ENDED_EVENT } from '@/lib/client-api';

/** Appears when any staff request reports an ended session. Unsaved entries stay on the page; sign-in opens in the same tab. */
export function SessionEndedAlert() {
  const [ended, setEnded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const show = () => setEnded(true);
    window.addEventListener(SESSION_ENDED_EVENT, show);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, show);
  }, []);
  useEffect(() => { if (ended) ref.current?.scrollIntoView({ block: 'nearest' }); }, [ended]);
  if (!ended) return null;
  return <div ref={ref} className="mb-6"><Alert tone="warning" role="alert" title="Your session ended. Sign in again."
    action={<Button asChild size="sm"><Link href="/login">Sign in</Link></Button>}>
    <p>Copy anything you have not saved before signing in; changes on this page were not sent.</p>
  </Alert></div>;
}
