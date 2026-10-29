import type { ReactNode } from 'react';
import { CircleCheck, CircleDashed, CircleMinus, Clock3, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StatusBadge } from './status-badge';

export interface ChecklistItem { id: string; title: string; optional?: boolean; description?: string; status: string; note?: string; meta?: ReactNode; action?: ReactNode }
const icons: Record<string, [typeof CircleCheck, string]> = {
  PENDING: [CircleDashed, 'text-subtle-foreground'], IN_PROGRESS: [Clock3, 'text-info'], BLOCKED: [TriangleAlert, 'text-warning'],
  COMPLETED: [CircleCheck, 'text-success'], NOT_NEEDED: [CircleMinus, 'text-muted-foreground'],
};

/**
 * Tasks with their status, an optional note and one action, for a flush Card with a Progress in its header. Blocked
 * notes are highlighted and finished titles dim. `heading` labels a group of related tasks without nesting cards.
 */
export function Checklist({ items, heading, titleAs: Title = 'h3', className }: { items: ChecklistItem[]; heading?: string; titleAs?: 'h3' | 'h4'; className?: string }) {
  const done = (status: string) => status === 'COMPLETED' || status === 'NOT_NEEDED';
  return <div className={className}>
    {heading && <h3 className="px-4 pt-3 text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground sm:px-5">{heading}</h3>}
    <ul className="m-0 list-none p-0">
      {items.map(item => {
        const [Icon, tone] = icons[item.status] ?? icons.PENDING;
        return <li key={item.id} className="flex items-start gap-3 border-t border-border px-4 py-4 first:border-t-0 sm:px-5">
          <Icon aria-hidden="true" className={cn('mt-0.5 size-5 shrink-0', tone)} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Title className={cn('text-sm font-medium leading-[22px]', done(item.status) && 'text-muted-foreground')}>{item.title}{item.optional && <span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span>}</Title>
              <StatusBadge status={item.status} />
            </div>
            {item.description && <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{item.description}</p>}
            {item.note && <p className={cn('mt-2 whitespace-pre-wrap rounded-md px-3 py-2 text-[13px] leading-5 [overflow-wrap:anywhere]', item.status === 'BLOCKED' ? 'bg-warning-background' : 'bg-muted')}>{item.status === 'BLOCKED' && <strong className="text-warning">Blocked: </strong>}{item.note}</p>}
            {item.meta && <p className="mt-1.5 text-xs text-muted-foreground">{item.meta}</p>}
          </div>
          {item.action && <div className="shrink-0">{item.action}</div>}
        </li>;
      })}
    </ul>
  </div>;
}
