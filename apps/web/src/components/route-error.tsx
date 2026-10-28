'use client';
import { useTransition } from 'react';
import { RefreshCw } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PendingHint } from '@/components/ui/pending-hint';

/** The body of every error.tsx: cold-start wording and a retry that re-fetches the server data, never a raw error message. */
export function RouteError({ retry, title = 'This page could not load', className }: { retry: () => void; title?: string; className?: string }) {
  const [pending, startTransition] = useTransition();
  return <div className={className}>
    <Alert tone="warning" role="alert" title={title}>
      <p>The service may be starting up, which can take up to a minute. Your saved work is safe. Try again in a moment; if the problem continues, contact your workspace administrator.</p>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <Button type="button" disabled={pending} onClick={() => startTransition(() => retry())}><RefreshCw aria-hidden="true" className="size-4" />{pending ? 'Trying again…' : 'Try again'}</Button>
      </div>
      <PendingHint pending={pending} />
    </Alert>
  </div>;
}
