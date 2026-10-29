'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { ChevronsUpDown, FileSignature, Files, Layers, LayoutDashboard, LogOut, Mail, Monitor, PanelLeftClose, PanelLeftOpen, Settings, ShieldCheck, UserPlus, Users } from 'lucide-react';
import type { Identity } from '@/lib/auth';
import { brand } from '@/lib/brand';
import { cn } from '@/lib/utils';
import { activeNavigationItem, navigationSections } from '@/lib/navigation';
import { useSignOut } from '@/features/auth/logout-button';
import { Avatar } from './ui/avatar';
import { DropdownMenu } from './ui/dropdown-menu';
import { roleLabel } from './ui/status-badge';
import { useToast } from './ui/toast';
import { Tooltip } from './ui/tooltip';
import { useGuardedLink, useShell } from './shell-context';

const icons: Record<string, typeof LayoutDashboard> = { dashboard: LayoutDashboard, onboarding: UserPlus, invitations: Mail, applications: Files, documents: FileSignature, it: Monitor, users: Users, settings: Settings, security: ShieldCheck };
const wide = '(min-width: 1280px)';
function useWide() {
  return useSyncExternalStore(change => { const media = window.matchMedia(wide); media.addEventListener('change', change); return () => media.removeEventListener('change', change); },
    () => window.matchMedia(wide).matches, () => true);
}

/**
 * Grouped destinations from /auth/me with counts of waiting work, and the account menu. On the desktop it is 248px wide
 * from 1280px and an icon rail below that (or when collapsed), with labels kept for screen readers; in the drawer it is
 * always full width and the account actions are listed inline.
 */
export function Sidebar({ identity, counts, drawer = false, collapsed = false, onToggle, onNavigate }: {
  identity: Identity; counts: Record<string, number>; drawer?: boolean; collapsed?: boolean; onToggle?: () => void; onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const { guard } = useShell();
  const guarded = useGuardedLink();
  const { signOut, pending, error } = useSignOut();
  const isWide = useWide();
  const railNow = !drawer && (collapsed || !isWide);
  useEffect(() => { if (error) toast({ tone: 'danger', title: error }); }, [error, toast]);
  const activeHref = activeNavigationItem(identity.navigation, pathname)?.href;
  const security = identity.navigation.find(item => item.key === 'security');
  const name = `${identity.user.firstName} ${identity.user.lastName}`;
  // Classes for the rail: hidden visually (not from screen readers) on the desktop when narrow or collapsed.
  const railHide = drawer ? '' : collapsed ? 'sr-only' : 'max-xl:sr-only';
  const railOnly = drawer ? 'hidden' : collapsed ? '' : 'xl:hidden';
  const railCenter = drawer ? '' : collapsed ? 'justify-center px-0' : 'max-xl:justify-center max-xl:px-0';
  function openSecurity() {
    if (!security || (guard.current && !guard.current(security.href))) return;
    onNavigate?.(); router.push(security.href);
  }
  return <div className="flex min-h-full flex-1 flex-col">
    <div className={cn('flex h-14 shrink-0 items-center gap-3 border-b border-sidebar-border px-4', railCenter)}>
      <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-brand-orange text-brand-ink"><Layers aria-hidden="true" className="size-4" /></span>
      <div className={railHide}><p className="font-display text-[17px] leading-5 tracking-[.06em] text-sidebar-active-foreground">WORKSPACE</p><p className="text-[11px] font-medium leading-3.5 text-sidebar-muted">{brand.companyName}</p></div>
    </div>
    <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-2 py-3">
      {navigationSections(identity.navigation).map((section, index) => <div key={section.label ?? index} className={cn(index > 0 && 'mt-4')}>
        {section.label && <p className={cn('px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase leading-4 tracking-[.08em] text-sidebar-muted', railHide)}>{section.label}</p>}
        <ul className="grid gap-0.5">{section.items.map(({ key, href, label }) => {
          const Icon = icons[key] ?? LayoutDashboard, active = activeHref === href, count = counts[key] ?? 0;
          return <li key={key}><Tooltip label={count ? `${label} (${count})` : label} side="right" disabled={!railNow}>
            <Link href={href} aria-current={active ? 'page' : undefined} onClick={event => { guarded(href)(event); if (!event.defaultPrevented) onNavigate?.(); }}
              className={cn('relative flex items-center gap-3 rounded-sm px-3 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-hover hover:text-sidebar-active-foreground focus-visible:outline-sidebar-accent',
                drawer ? 'min-h-11' : 'h-9', active && 'bg-sidebar-active font-medium text-sidebar-active-foreground', railCenter)}>
              <Icon aria-hidden="true" className={cn('size-[18px] shrink-0', active && 'text-sidebar-accent')} />
              <span className={cn('flex-1 truncate', railHide)}>{label}{count > 0 && <span className="sr-only">, {count} waiting</span>}</span>
              {count > 0 && <span aria-hidden="true" className={cn('min-w-5 rounded-full bg-sidebar-active px-1.5 text-center text-[11px] font-semibold leading-5 text-sidebar-active-foreground tabular-nums', railHide)}>{count}</span>}
              {count > 0 && <span aria-hidden="true" className={cn('absolute right-2.5 top-1.5 size-[7px] rounded-full bg-sidebar-accent', railOnly)} />}
            </Link>
          </Tooltip></li>;
        })}</ul>
      </div>)}
    </nav>
    {drawer ? <div className="border-t border-sidebar-border p-3">
      <div className="flex items-center gap-3 px-2 py-2"><Avatar name={name} size="md" className="bg-sidebar-active text-sidebar-active-foreground shadow-none" />
        <div className="min-w-0"><p className="truncate text-[13px] font-medium text-sidebar-active-foreground">{name}</p><p className="truncate text-xs text-sidebar-muted">{roleLabel(identity.user.role)}</p></div></div>
      {security && <Link href={security.href} aria-current={activeHref === security.href ? 'page' : undefined} onClick={event => { guarded(security.href)(event); if (!event.defaultPrevented) onNavigate?.(); }}
        className="flex min-h-11 items-center gap-3 rounded-sm px-3 text-sm text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-active-foreground focus-visible:outline-sidebar-accent"><ShieldCheck aria-hidden="true" className="size-[18px]" />{security.label}</Link>}
      <button type="button" disabled={pending} onClick={() => void signOut()} className="flex min-h-11 w-full items-center gap-3 rounded-sm px-3 text-left text-sm text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-active-foreground focus-visible:outline-sidebar-accent disabled:opacity-60"><LogOut aria-hidden="true" className="size-[18px]" />{pending ? 'Signing out…' : 'Sign out'}</button>
    </div> : <div className={cn('flex items-center gap-1 border-t border-sidebar-border p-2', collapsed ? 'flex-col' : 'max-xl:flex-col')}>
      <DropdownMenu side={railNow ? 'right' : 'top'} align={railNow ? 'end' : 'start'} trigger={
        <button type="button" aria-label={`Account menu for ${name}`} className={cn('flex min-w-0 flex-1 items-center gap-3 rounded-sm p-2 text-left hover:bg-sidebar-hover focus-visible:outline-sidebar-accent', railCenter)}>
          <Avatar name={name} size="md" className="bg-sidebar-active text-sidebar-active-foreground shadow-none" />
          <span className={cn('grid min-w-0 flex-1', railHide)}><span className="truncate text-[13px] font-medium leading-[18px] text-sidebar-active-foreground">{name}</span><span className="truncate text-xs text-sidebar-muted">{roleLabel(identity.user.role)}</span></span>
          <ChevronsUpDown aria-hidden="true" className={cn('size-4 shrink-0 text-sidebar-muted', collapsed ? 'hidden' : 'hidden xl:block')} />
        </button>}
        items={[{ caption: identity.user.email }, ...(security ? [{ label: security.label, icon: ShieldCheck, onSelect: openSecurity }] : []), { separator: true }, { label: pending ? 'Signing out…' : 'Sign out', icon: LogOut, disabled: pending, onSelect: () => void signOut() }]} />
      {onToggle && <Tooltip label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="right">
        <button type="button" onClick={onToggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed}
          className="hidden size-9 shrink-0 place-items-center rounded-sm text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-active-foreground focus-visible:outline-sidebar-accent xl:grid">
          {collapsed ? <PanelLeftOpen aria-hidden="true" className="size-[18px]" /> : <PanelLeftClose aria-hidden="true" className="size-[18px]" />}
        </button>
      </Tooltip>}
    </div>}
  </div>;
}
