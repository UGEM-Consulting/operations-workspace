'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, Layers, Menu, X } from 'lucide-react';
import type { Identity } from '@/lib/auth';
import { brand } from '@/lib/brand';
import { cn } from '@/lib/utils';
import { Navigation } from './navigation';
import { AppearanceSelect } from './appearance-select';
import { Button } from './ui/button';
import { roleLabel } from './ui/status-badge';
import { LogoutButton } from '@/features/auth/logout-button';

export function WorkspaceShell({ identity, children }: { identity: Identity; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const main = useRef<HTMLElement>(null);
  const pathname = usePathname();
  const current = identity.navigation.filter(item => pathname === item.href || pathname.startsWith(`${item.href}/`)).sort((a,b) => b.href.length - a.href.length)[0];
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
  function sidebar(compact: boolean) {
    return <><div className={cn('flex items-center gap-3 px-5 py-8', compact && 'justify-center px-2')}><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-orange text-brand-ink"><Layers aria-hidden="true" className="size-6" /></span>{!compact && <div><p className="font-display text-xl tracking-wide text-white">WORKSPACE</p><p className="mt-1 text-[10px] font-medium uppercase tracking-widest text-sidebar-muted">{brand.companyName}</p></div>}</div>
      {!compact && <p className="px-6 pb-3 text-[10px] font-semibold uppercase tracking-[.16em] text-sidebar-muted">Your workspace</p>}
      <Navigation items={identity.navigation} collapsed={compact} onNavigate={navigate} />
      <div className="mt-auto p-4">{!compact && <div className="mb-5 rounded-xl border border-sidebar-border bg-sidebar-hover p-4"><p className="text-xs font-medium text-white">A clearer path forward.</p><p className="mt-2 text-xs leading-5 text-sidebar-muted">People, onboarding, and next steps. All in one place.</p></div>}<div className={cn('flex items-center gap-3 border-t border-sidebar-border pt-5', compact && 'justify-center')}><span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sidebar-active text-xs font-semibold text-white">{identity.user.firstName.slice(0,1)}{identity.user.lastName.slice(0,1)}</span>{!compact && <div className="min-w-0"><p className="truncate text-xs font-semibold text-white">{identity.user.firstName} {identity.user.lastName}</p><p className="mt-1 text-[11px] text-sidebar-muted">{roleLabel(identity.user.role)}</p></div>}</div></div></>;
  }
  return <div className="min-h-dvh bg-background lg:flex">
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-card focus:p-4">Skip to content</a>
    <aside aria-label="Workspace sidebar" className={cn('sticky top-0 hidden h-dvh shrink-0 flex-col overflow-y-auto bg-sidebar lg:flex', collapsed ? 'w-20' : 'w-64')}>
      {sidebar(collapsed)}<button onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="m-3 flex min-h-11 items-center justify-center gap-2 rounded-lg border border-sidebar-muted/50 text-xs text-sidebar-foreground hover:bg-sidebar-active focus-visible:outline-sidebar-accent">{collapsed ? <ChevronRight aria-hidden="true" className="size-4" /> : <><ChevronLeft aria-hidden="true" className="size-4" />Collapse sidebar</>}</button>
    </aside>
    <div className="min-w-0 flex-1"><header className="flex min-h-20 flex-wrap items-center justify-between gap-3 border-b bg-card px-4 py-3 sm:px-8"><div className="flex items-center gap-3"><Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation" aria-expanded={open} aria-controls="workspace-drawer" onClick={() => { drawer.current?.showModal(); setOpen(true); }}><Menu aria-hidden="true" className="size-5" /></Button><div><p className="text-sm font-semibold">{brand.applicationName}</p><p className="mt-1 text-xs text-muted-foreground">{current?.label ?? 'Workspace'}</p></div></div><div className="flex items-center gap-2"><AppearanceSelect /><LogoutButton /></div></header>
      <main ref={main} id="main" tabIndex={-1} className="mx-auto max-w-[1500px] px-4 py-7 outline-none sm:px-8 sm:py-9 xl:px-10">{children}</main><footer className="mx-4 border-t py-5 text-[11px] text-muted-foreground sm:mx-8 xl:mx-10">{brand.displayName} · Internal workspace</footer>
    </div>
    <dialog ref={drawer} id="workspace-drawer" aria-label="Workspace navigation" onClose={() => setOpen(false)} className="fixed inset-y-0 left-0 right-auto m-0 h-dvh max-h-dvh w-[min(320px,90vw)] max-w-none border-0 bg-sidebar p-0 backdrop:bg-overlay"><div className="relative flex min-h-full flex-col"><button autoFocus onClick={() => drawer.current?.close()} aria-label="Close navigation" className="absolute right-2 top-1 flex size-11 items-center justify-center rounded-lg text-sidebar-active-foreground hover:bg-sidebar-active"><X aria-hidden="true" className="size-4" /></button>{sidebar(false)}</div></dialog>
  </div>;
}
