"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, UserPlus, Mail, Files, FileSignature, Monitor, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
const icons: Record<string, typeof LayoutDashboard> = { dashboard: LayoutDashboard, onboarding: UserPlus, invitations: Mail, applications: Files, documents: FileSignature, it: Monitor, settings: Settings };
export function Navigation({ items, collapsed = false, onNavigate }: { items: { key: string; href: string; label: string }[]; collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  // Highlight the most specific authorized destination, including its detail pages.
  const activeHref = items.filter(({ href }) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return <nav aria-label="Main navigation" className="flex flex-col gap-1 px-3">
    {items.map(({ key, href, label }) => {
      const Icon = icons[key] ?? LayoutDashboard;
      // The collapsed rail shows icons only; the tooltip names each one on hover and keyboard focus.
      return <Tooltip key={href} label={label} side="right" disabled={!collapsed}><Link href={href} onClick={onNavigate} aria-label={collapsed ? label : undefined} aria-current={activeHref === href ? "page" : undefined}
        className={cn("flex min-h-12 shrink-0 items-center gap-3 rounded-md px-3 py-3 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-hover hover:text-sidebar-active-foreground focus-visible:outline-sidebar-accent", activeHref === href && "bg-sidebar-active font-semibold text-sidebar-active-foreground", collapsed && 'justify-center px-1')}>
        <Icon aria-hidden="true" className={cn("size-[18px] shrink-0", activeHref === href && 'text-sidebar-accent')} />{!collapsed && label}
      </Link></Tooltip>;
    })}
  </nav>;
}
