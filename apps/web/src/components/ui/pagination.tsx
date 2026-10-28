import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// First, last, current and its neighbours; the rest collapse to an ellipsis.
function pages(page: number, count: number): (number | 'gap')[] {
  const keep = [...new Set([1, page - 1, page, page + 1, count])].filter(item => item >= 1 && item <= count).sort((a, b) => a - b);
  return keep.flatMap((item, index) => index > 0 && item - keep[index - 1] > 1 ? ['gap' as const, item] : [item]);
}
const pageClass = 'inline-flex h-8 min-w-8 items-center justify-center rounded-sm border border-transparent px-2 text-[13px] font-medium tabular-nums';

/** "Showing 51–75 of 287" and links between pages of a server-paginated list. Page and size live in the URL. */
export function Pagination({ page, pageCount, pageSize, total, href, label }: { page: number; pageCount: number; pageSize: number; total: number; href: (page: number) => string; label: string }) {
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);
  const count = Math.max(pageCount, 1);
  return <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-3">
    <p className="text-[13px] text-muted-foreground">Showing <strong className="font-medium tabular-nums text-foreground">{first}–{last}</strong> of <strong className="font-medium tabular-nums text-foreground">{total}</strong></p>
    {count > 1 && <ul className="flex items-center gap-0.5">
      <li>{page > 1 ? <Link href={href(page - 1)} aria-label="Previous page" className={cn(pageClass, 'hover:bg-accent')}><ChevronLeft aria-hidden="true" className="size-4" /></Link> : <span aria-hidden="true" className={cn(pageClass, 'text-muted-foreground opacity-50')}><ChevronLeft className="size-4" /></span>}</li>
      {pages(page, count).map((item, index) => item === 'gap'
        ? <li key={`gap-${index}`} aria-hidden="true" className="min-w-6 text-center text-muted-foreground max-sm:hidden">…</li>
        : <li key={item} className={cn(item !== page && 'max-sm:hidden')}>{item === page
          ? <span aria-current="page" className={cn(pageClass, 'border-input bg-card shadow-xs')}><span className="sr-only">Page </span>{item}<span className="sr-only"> of {count}</span></span>
          : <Link href={href(item)} aria-label={`Page ${item}`} className={cn(pageClass, 'hover:bg-accent')}>{item}</Link>}</li>)}
      <li>{page < count ? <Link href={href(page + 1)} aria-label="Next page" className={cn(pageClass, 'hover:bg-accent')}><ChevronRight aria-hidden="true" className="size-4" /></Link> : <span aria-hidden="true" className={cn(pageClass, 'text-muted-foreground opacity-50')}><ChevronRight className="size-4" /></span>}</li>
    </ul>}
  </nav>;
}
