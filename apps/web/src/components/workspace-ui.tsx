import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Loading, Skeleton } from '@/components/ui/feedback';

/** Page title block. `badge` sits beside the title; `meta` is a row of short facts (reference, dates) for record pages. */
export function PageHeader({ eyebrow, title, description, action, badge, meta }: { eyebrow?: string; title: string; description?: ReactNode; action?: ReactNode; badge?: ReactNode; meta?: ReactNode[] }) {
  return <div className="flex flex-wrap items-end justify-between gap-5"><div className="min-w-0">{eyebrow && <p className="text-xs font-medium text-muted-foreground">{eyebrow}</p>}
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1"><h1 className="font-sans text-[22px] font-semibold leading-[30px] tracking-[-0.01em]">{title}</h1>{badge}</div>
    {description && <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>}
    {meta && <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] leading-5 text-muted-foreground">{meta.map((item, index) => <li key={index} className="min-w-0 break-all sm:break-normal">{item}</li>)}</ul>}
  </div>{action}</div>;
}
const statDots = { neutral: 'bg-muted-foreground', info: 'bg-info', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' };
/** A count that links to the filtered list it counts. The dot matches the tone of that list's status badge. */
export function StatCard({ label, value, detail, href, tone }: { label: string; value: number; detail: string; href: string; tone?: keyof typeof statDots }) {
  return <Link href={href} className="group rounded-lg border bg-card p-5 shadow-xs transition-colors hover:border-border-strong"><p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">{tone && <span aria-hidden="true" className={`size-1.5 rounded-full ${statDots[tone]}`} />}{label}</p><div className="mt-4 flex items-end justify-between gap-3"><span className="text-[28px] font-semibold leading-9 tracking-tight tabular-nums">{value}</span><ArrowUpRight aria-hidden="true" className="size-4 text-primary" /></div><p className="mt-3 text-xs text-muted-foreground">{detail}</p></Link>;
}
/** Page header, a row of cards and a table-shaped block: the layout most workspace pages load into. */
export function PageLoading({ label, header = true }: { label: string; header?: boolean }) {
  return <Loading label={label} className="space-y-6">
    {header && <div className="space-y-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-7 w-64 max-w-full" /><Skeleton className="h-4 w-96 max-w-full" /></div>}
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-[124px] rounded-lg" />)}</div>
    <div className="space-y-3 rounded-lg border bg-card p-5 shadow-xs">{[0, 1, 2, 3, 4].map(index => <div key={index} className="flex items-center gap-3"><Skeleton className="size-8 rounded-full" /><Skeleton lines={2} className="flex-1" /><Skeleton className="h-5 w-20 rounded-full" /></div>)}</div>
  </Loading>;
}
