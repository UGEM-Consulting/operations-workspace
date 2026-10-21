"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, UserPlus, Mail, Files, Monitor, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
const icons: Record<string, typeof LayoutDashboard> = { dashboard: LayoutDashboard, onboarding: UserPlus, invitations: Mail, applications: Files, it: Monitor, settings: Settings };
export function Navigation({ items }: { items: { key: string; href: string; label: string }[] }) {
  const pathname = usePathname();
  return <nav aria-label="Main navigation" className="flex gap-1 overflow-x-auto p-3 md:flex-col md:overflow-visible md:p-4">{items.map(({ key, href, label }) => { const Icon = icons[key] ?? LayoutDashboard; return <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} className={cn("flex shrink-0 items-center gap-3 rounded-lg px-3 py-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", pathname === href && "bg-accent font-semibold text-primary")}><Icon className="size-4 shrink-0" />{label}</Link>; })}</nav>;
}
