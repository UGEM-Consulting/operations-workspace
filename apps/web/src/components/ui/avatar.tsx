import { cn } from '@/lib/utils';

const sizes = { sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-12 text-base' };
export function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || '?'; }
/** Initials on muted. Decorative when the name is printed beside it. Never use an ID selfie as an avatar. */
export function Avatar({ name, size = 'md', className }: { name: string; size?: keyof typeof sizes; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-grid shrink-0 place-items-center rounded-full bg-muted font-semibold leading-none text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]', sizes[size], className)}>{initials(name)}</span>;
}
/** A name with a secondary line (email, role) for tables, menus and timelines. */
export function Person({ name, secondary, size = 'md', avatar = true }: { name: string; secondary?: string; size?: keyof typeof sizes; avatar?: boolean }) {
  return <span className="flex min-w-0 items-center gap-3">
    {avatar && <Avatar name={name} size={size} />}
    <span className="min-w-0"><span className="block truncate text-sm font-medium text-foreground">{name}</span>{secondary && <span className="block truncate text-[13px] font-normal leading-[18px] text-muted-foreground">{secondary}</span>}</span>
  </span>;
}
