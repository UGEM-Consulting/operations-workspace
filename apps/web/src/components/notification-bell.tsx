'use client';
import * as Popover from '@radix-ui/react-popover';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Bell, CircleCheck } from 'lucide-react';
import { errorMessage, mutate, readApi } from '@/lib/client-api';
import type { Notifications } from '@/features/it/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { EmptyState, Skeleton } from './ui/feedback';
import { LocalTime } from './ui/local-time';
import { Tooltip } from './ui/tooltip';
import { useGuardedLink, useShell } from './shell-context';

/**
 * The signed-in manager's portal notifications in a popover. The badge counts unread items from the server; the list
 * loads when opened, and opening an item marks it read before going to the application.
 */
export function NotificationBell({ unread: initialUnread }: { unread: number }) {
  const router = useRouter();
  const { guard } = useShell();
  const guarded = useGuardedLink();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Notifications | null>(null);
  const [error, setError] = useState('');
  const unread = data?.unread ?? initialUnread;
  async function load() {
    setError('');
    try { setData(await readApi<Notifications>('notifications')); } catch (error) { setError(errorMessage(error, 'Notifications could not be loaded.')); }
  }
  async function openItem(item: Notifications['items'][number]) {
    const href = `/onboarding/applications/${item.applicationId}`;
    if (guard.current && !guard.current(href)) return;
    setOpen(false);
    // Reading is best effort: the application opens even if marking it read fails.
    if (!item.readAt) await mutate(`notifications/${item.id}/read`, 'POST').catch(() => undefined);
    router.push(href); router.refresh();
  }
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) void load(); }}>
    <Tooltip label="Notifications" side="bottom">
      <Popover.Trigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
          <Bell aria-hidden="true" className="size-[18px]" />
          {unread > 0 && <span aria-hidden="true" className="absolute right-0.5 top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground shadow-[0_0_0_2px_var(--card)] tabular-nums">{unread > 99 ? '99+' : unread}</span>}
        </Button>
      </Popover.Trigger>
    </Tooltip>
    <Popover.Portal>
      <Popover.Content align="end" sideOffset={8} collisionPadding={12} aria-label="Notifications"
        className="z-50 flex max-h-[min(480px,calc(100dvh-80px))] w-[min(380px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <p className="flex items-center gap-2 text-[15px] font-semibold">Notifications{unread > 0 && <span className="rounded-full bg-brand-subtle px-2 text-xs font-semibold leading-5 text-brand-subtle-foreground tabular-nums">{unread}</span>}</p>
          <Link href="/dashboard#updates" onClick={event => { guarded('/dashboard#updates')(event); if (!event.defaultPrevented) setOpen(false); }} className="text-[13px] text-primary underline-offset-4 hover:underline">See all</Link>
        </div>
        <div className="overflow-y-auto">
          {error ? <div className="space-y-3 p-4"><p role="alert" className="text-sm text-danger">{error}</p><Button size="sm" variant="outline" onClick={() => void load()}>Try again</Button></div>
            : !data ? <div className="space-y-4 p-4" role="status" aria-label="Loading notifications">{[0, 1, 2].map(index => <div key={index} className="flex gap-3"><Skeleton className="size-8 rounded-full" /><Skeleton lines={2} className="flex-1" /></div>)}</div>
            : data.items.length ? <ul className="divide-y divide-border">{data.items.map(item => <li key={item.id}>
              <button type="button" onClick={() => void openItem(item)} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-success-background text-success"><CircleCheck aria-hidden="true" className="size-4" /></span>
                <span className="grid min-w-0 flex-1">
                  <span className={cn('text-sm', !item.readAt && 'font-medium')}>IT setup completed</span>
                  <span className="truncate text-[13px] leading-5 text-muted-foreground">{item.displayName ?? 'Dispatcher'} is ready to work.</span>
                  <LocalTime iso={item.createdAt} className="mt-0.5 text-xs text-muted-foreground" />
                </span>
                {!item.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"><span className="sr-only">Unread</span></span>}
              </button>
            </li>)}</ul>
            : <EmptyState compact icon={Bell} title="You are all caught up" description="Completion updates from IT appear here." />}
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
