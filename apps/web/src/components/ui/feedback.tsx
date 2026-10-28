import type { ReactNode } from 'react';
import { Inbox, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** How much of a known amount is done. Turns green when complete; the numbers are always shown. */
export function Progress({ label, value, max, valueLabel, compact = false, className }: { label: string; value: number; max: number; valueLabel?: string | false; compact?: boolean; className?: string }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const shown = valueLabel ?? `${value} of ${max}`;
  return <div className={cn('grid gap-2', className)}>
    {!compact && <div className="flex justify-between gap-3 text-[13px] leading-5"><span className="font-medium">{label}</span>{shown !== false && <span className="tabular-nums text-muted-foreground">{shown}</span>}</div>}
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={shown || undefined} className={cn('overflow-hidden rounded-full bg-muted', compact ? 'h-1' : 'h-1.5')}>
      <span className={cn('block h-full rounded-full transition-[width] duration-300', percent === 100 ? 'bg-success' : 'bg-primary')} style={{ width: `${percent}%` }} />
    </div>
  </div>;
}

/** Why a list or area is empty and, when possible, the one next action. Failed loads use an Alert instead. */
/** `headingLevel` follows the surrounding outline (default h3, under a section h2). */
export function EmptyState({ icon: Icon = Inbox, title, description, action, compact = false, headingLevel = 3 }: { icon?: LucideIcon; title: string; description?: string; action?: ReactNode; compact?: boolean; headingLevel?: 2 | 3 | 4 }) {
  const Heading = `h${headingLevel}` as const;
  return <div className={cn('flex flex-col items-center text-center', compact ? 'px-4 py-6' : 'px-6 py-10')}>
    <span className="mb-3 grid size-10 place-items-center rounded-md bg-muted text-muted-foreground"><Icon aria-hidden="true" className="size-5" /></span>
    <Heading className="text-[15px] font-semibold leading-[22px]">{title}</Heading>
    {description && <p className="mt-1 max-w-sm text-sm leading-[22px] text-muted-foreground">{description}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>;
}

/** A placeholder shape matching the layout that will appear; the pulse stops when reduced motion is requested. */
export function Skeleton({ className, lines }: { className?: string; lines?: number }) {
  if (lines) return <div className={cn('grid gap-2', className)}>{Array.from({ length: lines }, (_, index) => <Skeleton key={index} className={cn('h-3.5', index === lines - 1 ? 'w-3/5' : 'w-full')} />)}</div>;
  return <div aria-hidden="true" className={cn('rounded-sm bg-muted motion-safe:animate-pulse', className)} />;
}
/** Wraps skeletons so screen readers hear one "Loading…" status. */
export function Loading({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <div role="status" aria-busy="true" className={className}><span className="sr-only">{label}</span>{children}</div>;
}
