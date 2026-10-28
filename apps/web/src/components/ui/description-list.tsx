import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface Description { label: string; value: ReactNode; mono?: boolean; span?: boolean; emptyLabel?: string }
/** Label and value pairs for reading a record. `grid` for full-width sections, `rows` for side panels and short lists. */
export function DescriptionList({ items, layout = 'grid', columns = 2, className }: { items: Description[]; layout?: 'grid' | 'rows'; columns?: 2 | 3; className?: string }) {
  return <dl className={cn(layout === 'grid' ? cn('grid gap-x-6 gap-y-5', columns === 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2') : 'divide-y divide-border', className)}>
    {items.map(item => {
      const empty = item.value === null || item.value === undefined || item.value === '';
      return <div key={item.label} className={cn('min-w-0', layout === 'grid' ? item.span && 'sm:col-span-full' : 'grid gap-x-4 gap-y-0.5 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]')}>
        <dt className="text-[13px] leading-5 text-muted-foreground">{item.label}</dt>
        <dd className={cn('mt-0.5 min-w-0 break-words text-sm leading-[22px]', empty ? 'italic text-muted-foreground' : item.mono ? 'font-mono text-[13px]' : 'font-medium', layout === 'rows' && 'sm:mt-0')}>{empty ? item.emptyLabel ?? 'Not provided' : item.value}</dd>
      </div>;
    })}
  </dl>;
}
