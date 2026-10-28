import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Loading, Skeleton } from '@/components/ui/feedback';

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: ReactNode; action?: ReactNode }) {
  return <div className="flex flex-wrap items-end justify-between gap-5"><div><p className="text-xs font-medium text-muted-foreground">{eyebrow}</p><h1 className="mt-1 font-sans text-[22px] font-semibold leading-[30px] tracking-[-0.01em]">{title}</h1><p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p></div>{action}</div>;
}
export function StatCard({ label, value, detail, href }: { label: string; value: number; detail: string; href: string }) {
  return <Link href={href} className="group rounded-lg border bg-card p-5 shadow-xs transition-colors hover:border-border-strong"><p className="text-xs font-medium text-muted-foreground">{label}</p><div className="mt-4 flex items-end justify-between gap-3"><span className="text-[28px] font-semibold leading-9 tracking-tight tabular-nums">{value}</span><ArrowUpRight aria-hidden="true" className="size-4 text-primary" /></div><p className="mt-3 text-xs text-muted-foreground">{detail}</p></Link>;
}
/** Page header, a row of cards and a table-shaped block: the layout most workspace pages load into. */
export function PageLoading({ label, header = true }: { label: string; header?: boolean }) {
  return <Loading label={label} className="space-y-6">
    {header && <div className="space-y-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-7 w-64 max-w-full" /><Skeleton className="h-4 w-96 max-w-full" /></div>}
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-[124px] rounded-lg" />)}</div>
    <div className="space-y-3 rounded-lg border bg-card p-5 shadow-xs">{[0, 1, 2, 3, 4].map(index => <div key={index} className="flex items-center gap-3"><Skeleton className="size-8 rounded-full" /><Skeleton lines={2} className="flex-1" /><Skeleton className="h-5 w-20 rounded-full" /></div>)}</div>
  </Loading>;
}
