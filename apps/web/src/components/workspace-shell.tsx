'use client';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import type { Identity } from '@/lib/auth';
import { brand } from '@/lib/brand';
import { cn } from '@/lib/utils';
import { breadcrumbTrail, SIDEBAR_COOKIE, type WorkspaceCounts } from '@/lib/navigation';
import { SessionEndedAlert } from './session-ended-alert';
import { AppearanceSelect } from './appearance-select';
import { NotificationBell } from './notification-bell';
import { Sidebar } from './sidebar';
import { ShellProvider, useGuardedLink, useShell } from './shell-context';
import { Breadcrumbs } from './ui/breadcrumbs';
import { Button } from './ui/button';

/** Sidebar, top bar (breadcrumbs, notifications, appearance) and page. Counts are null when they could not be loaded. */
export function WorkspaceShell({ identity, counts, collapsed = false, children }: { identity: Identity; counts: WorkspaceCounts | null; collapsed?: boolean; children: ReactNode }) {
  return <ShellProvider><Shell identity={identity} counts={counts} initiallyCollapsed={collapsed}>{children}</Shell></ShellProvider>;
}
const subscribeNothing = () => () => undefined;
function Shell({ identity, counts, initiallyCollapsed, children }: { identity: Identity; counts: WorkspaceCounts | null; initiallyCollapsed: boolean; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  // Remembered per browser for a year; a display preference only, never read for access decisions.
  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`;
  }
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const main = useRef<HTMLElement>(null);
  const pathname = usePathname();
  const { pageLabel } = useShell();
  const guarded = useGuardedLink();
  // The server cannot know a record page's name (its PageCrumb runs in the browser), so until hydration the record
  // crumb is a blank placeholder (see Breadcrumbs) instead of announcing the generic "Details" first.
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const crumbs = breadcrumbTrail(identity.navigation, pathname, pageLabel ?? (hydrated ? null : ' '));
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const close = () => { if (media.matches) drawer.current?.close(); };
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  function navigate() { drawer.current?.close(); requestAnimationFrame(() => main.current?.focus()); }
  const navigationCounts = counts?.navigation ?? {};
  return <div data-density="compact" className="min-h-dvh bg-background lg:flex">
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:p-4">Skip to content</a>
    <aside aria-label="Workspace" className={cn('sticky top-0 hidden h-dvh shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar lg:flex lg:w-16', !collapsed && 'xl:w-62')}>
      <Sidebar identity={identity} counts={navigationCounts} collapsed={collapsed} onToggle={toggleCollapsed} />
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-card px-3 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button variant="ghost" size="icon" className="shrink-0 lg:hidden" aria-label="Open navigation" aria-expanded={open} aria-controls="workspace-drawer" onClick={() => { drawer.current?.showModal(); setOpen(true); }}><Menu aria-hidden="true" className="size-5" /></Button>
          <Breadcrumbs items={crumbs} onLinkClick={guarded} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {counts && counts.unreadNotifications !== null && <NotificationBell unread={counts.unreadNotifications} />}
          <AppearanceSelect />
        </div>
      </header>
      <main ref={main} id="main" tabIndex={-1} className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 outline-none sm:px-8 sm:py-8 xl:px-10"><SessionEndedAlert />{children}</main>
      <footer className="mx-4 border-t py-5 text-xs text-muted-foreground sm:mx-8 xl:mx-10">{brand.displayName} · Internal workspace</footer>
    </div>
    <dialog ref={drawer} id="workspace-drawer" aria-label="Workspace navigation" onClose={() => setOpen(false)} className="fixed inset-y-0 left-0 right-auto m-0 h-dvh max-h-dvh w-[min(320px,90vw)] max-w-none border-0 bg-sidebar p-0 backdrop:bg-overlay">
      <div className="relative flex min-h-full flex-col">
        <button autoFocus onClick={() => drawer.current?.close()} aria-label="Close navigation" className="absolute right-2 top-1.5 z-10 grid size-11 place-items-center rounded-md text-sidebar-active-foreground hover:bg-sidebar-active focus-visible:outline-sidebar-accent"><X aria-hidden="true" className="size-4" /></button>
        {open && <Sidebar drawer identity={identity} counts={navigationCounts} onNavigate={navigate} />}
      </div>
    </dialog>
  </div>;
}
