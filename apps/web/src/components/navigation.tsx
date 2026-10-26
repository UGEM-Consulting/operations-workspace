"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, UserPlus, Mail, Files, FileSignature, Monitor, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
const icons: Record<string, typeof LayoutDashboard> = { dashboard: LayoutDashboard, onboarding: UserPlus, invitations: Mail, applications: Files, documents: FileSignature, it: Monitor, settings: Settings };
export function Navigation({ items, collapsed = false, onNavigate }: { items: { key: string; href: string; label: string }[]; collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  // Highlight the most specific authorized destination, including its detail pages.
  const activeHref = items.filter(({ href }) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return <nav aria-label="Main navigation" className="flex flex-col gap-1 px-3">
    {items.map(({ key, href, label }) => {
      const Icon = icons[key] ?? LayoutDashboard;
      return <Link key={href} href={href} onClick={onNavigate} title={collapsed ? label : undefined} aria-label={collapsed ? label : undefined} aria-current={activeHref === href ? "page" : undefined}
        className={cn("flex min-h-12 shrink-0 items-center gap-3 rounded-xl px-3 py-3 text-sm text-[#c6c2bf] transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-[#ffad87]", activeHref === href && "bg-white/10 font-semibold text-white", collapsed && 'justify-center px-1')}>
        <Icon aria-hidden="true" className={cn("size-[18px] shrink-0", activeHref === href && 'text-[#ffad87]')} />{!collapsed && label}
      </Link>;
    })}
  </nav>;
}
