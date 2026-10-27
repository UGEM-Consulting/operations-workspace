import Link from 'next/link';
import { ArrowUpRight, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="flex flex-wrap items-end justify-between gap-5"><div><p className="text-xs font-semibold uppercase tracking-[.16em] text-primary">{eyebrow}</p><h1 className="mt-3 text-3xl tracking-tight sm:text-4xl">{title}</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p></div>{action}</div>;
}
export function StatCard({ label, value, detail, href }: { label: string; value: number; detail: string; href: string }) {
  return <Link href={href} className="group rounded-2xl border bg-card p-5 transition-colors hover:border-primary/50 sm:p-6"><p className="text-xs font-medium text-muted-foreground">{label}</p><div className="mt-4 flex items-end justify-between gap-3"><span className="text-4xl font-semibold tracking-tight tabular-nums">{value}</span><ArrowUpRight aria-hidden="true" className="size-4 text-primary" /></div><p className="mt-3 text-xs text-muted-foreground">{detail}</p></Link>;
}
export function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="flex flex-col items-center px-6 py-10 text-center"><span className="mb-4 rounded-2xl bg-brand-subtle p-3 text-brand-subtle-foreground"><Inbox aria-hidden="true" className="size-6" /></span><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p></div>;
}
export function PanelLoading() {
  return <div role="status" aria-busy="true" className="space-y-4 rounded-2xl border bg-card p-6"><p className="text-sm text-muted-foreground">Loading your workspace…</p><div className="h-24 animate-pulse rounded-xl bg-muted" /><div className="h-40 animate-pulse rounded-xl bg-muted" /></div>;
}
