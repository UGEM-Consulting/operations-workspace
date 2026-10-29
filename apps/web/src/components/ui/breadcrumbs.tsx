import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Crumb } from '@/lib/navigation';

/**
 * Where the page sits; the last item is the current page. On phones only a link to the parent shows.
 * `onLinkClick` lets the shell ask before leaving a page with unsaved changes.
 */
export function Breadcrumbs({ items, onLinkClick }: { items: Crumb[]; onLinkClick?: (href: string) => (event: React.MouseEvent) => void }) {
  const parent = items.length > 1 ? items.at(-2) : undefined;
  return <nav aria-label="Breadcrumb" className="min-w-0">
    {parent?.href && <Link href={parent.href} onClick={onLinkClick?.(parent.href)} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-foreground sm:hidden">
      <ChevronLeft aria-hidden="true" className="size-4" />{parent.label}</Link>}
    <ol className={`${parent ? 'hidden sm:flex' : 'flex'} min-w-0 flex-wrap items-center gap-1 text-[13px] leading-5`}>
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return <li key={`${index}-${item.label}`} className="flex min-w-0 items-center gap-1">
          {last || !item.href ? <span aria-current={last ? 'page' : undefined} className={last ? 'truncate font-medium text-foreground' : 'text-muted-foreground'}>{item.label}</span>
            : <Link href={item.href} onClick={onLinkClick?.(item.href)} className="text-muted-foreground hover:text-foreground hover:underline">{item.label}</Link>}
          {!last && <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-subtle-foreground" />}
        </li>;
      })}
    </ol>
  </nav>;
}
