'use client';
import Link from 'next/link';
import * as RadixTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TabItem { key: string; label: string; count?: number; href?: string }
const underlineList = 'flex gap-5 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--border)] [scrollbar-width:none]';
// The active tab has a 2px primary bar; links mark it with data-active, Radix triggers with data-state.
const underlineTab = "relative inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap px-0.5 text-sm font-medium text-muted-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-t-xs after:content-[''] hover:text-foreground data-[active=true]:text-foreground data-[active=true]:after:bg-primary data-[state=active]:text-foreground data-[state=active]:after:bg-primary";
const segmentList = 'inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md bg-muted p-[3px] [scrollbar-width:none]';
const segmentTab = 'inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground data-[active=true]:bg-card data-[active=true]:text-foreground data-[active=true]:shadow-xs';
function Count({ value, active, segmented }: { value?: number; active: boolean; segmented: boolean }) {
  if (value === undefined) return null;
  return <span className={cn('min-w-5 rounded-full px-1.5 text-center text-xs font-semibold leading-5 tabular-nums', segmented ? 'bg-transparent' : active ? 'bg-brand-subtle text-brand-subtle-foreground' : 'bg-muted text-muted-foreground')}>{value}</span>;
}

/** Sections of one record, switched in place with arrow keys. Panels are given by key. */
export function Tabs({ items, value, defaultValue, onValueChange, label, panels, className }: {
  items: TabItem[]; value?: string; defaultValue?: string; onValueChange?: (value: string) => void; label: string; panels: Record<string, ReactNode>; className?: string;
}) {
  return <RadixTabs.Root value={value} defaultValue={defaultValue ?? items[0]?.key} onValueChange={onValueChange} className={className}>
    <RadixTabs.List aria-label={label} className={underlineList}>
      {items.map(item => <RadixTabs.Trigger key={item.key} value={item.key} className={cn(underlineTab, 'cursor-pointer')}>
        {item.label}<Count value={item.count} active={false} segmented={false} />
      </RadixTabs.Trigger>)}
    </RadixTabs.List>
    {items.map(item => <RadixTabs.Content key={item.key} value={item.key} className="pt-5 focus-visible:outline-none">{panels[item.key]}</RadixTabs.Content>)}
  </RadixTabs.Root>;
}

/** Views kept in the URL: underline tabs for record sections, `segmented` for queue filters (replaces a status select). */
export function TabLinks({ items, value, label, variant = 'underline', className }: {
  items: (TabItem & { href: string })[]; value: string; label: string; variant?: 'underline' | 'segmented'; className?: string;
}) {
  const segmented = variant === 'segmented';
  return <nav aria-label={label} className={cn(segmented ? segmentList : underlineList, className)}>
    {items.map(item => {
      const active = item.key === value;
      return <Link key={item.key} href={item.href} aria-current={active ? 'page' : undefined} data-active={active} className={segmented ? segmentTab : underlineTab}>
        {item.label}<Count value={item.count} active={active} segmented={segmented} />
      </Link>;
    })}
  </nav>;
}
