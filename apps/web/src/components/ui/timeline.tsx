import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { StatusTone } from './status-badge';

export interface TimelineItem { id: string; title: ReactNode; meta?: ReactNode; body?: ReactNode; tone?: StatusTone; icon?: ReactNode }
const markers: Record<StatusTone, string> = {
  neutral: 'bg-muted text-muted-foreground', info: 'bg-info-background text-info', success: 'bg-success-background text-success',
  warning: 'bg-warning-background text-warning', danger: 'bg-danger-background text-danger',
};
/** Newest-first history of a record. Title says what happened and who; bodies quote what a person wrote. */
export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return <ol className={cn('m-0 list-none p-0', className)}>
    {items.map(item => <li key={item.id} className="relative flex gap-3 pb-5 last:pb-0 [&:not(:last-child)]:before:absolute [&:not(:last-child)]:before:bottom-1 [&:not(:last-child)]:before:left-[11.5px] [&:not(:last-child)]:before:top-7 [&:not(:last-child)]:before:w-px [&:not(:last-child)]:before:bg-border [&:not(:last-child)]:before:content-['']">
      <span aria-hidden="true" className={cn('grid size-6 shrink-0 place-items-center rounded-full [&_svg]:size-3.5', markers[item.tone ?? 'neutral'])}>{item.icon ?? <span className="size-1.5 rounded-full bg-current" />}</span>
      <div className="min-w-0 pt-px">
        <p className="text-sm font-medium leading-[22px]">{item.title}</p>
        {item.meta && <p className="text-[13px] leading-5 text-muted-foreground">{item.meta}</p>}
        {item.body && <div className="mt-2 whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-sm leading-[22px] [overflow-wrap:anywhere]">{item.body}</div>}
      </div>
    </li>)}
  </ol>;
}
