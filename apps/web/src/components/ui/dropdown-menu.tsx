'use client';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export type MenuEntry =
  | { label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean; checked?: boolean }
  | { separator: true } | { heading: string }
  /** A plain line of context, such as the signed-in email; not uppercased like a heading. */
  | { caption: string };

/** A button that opens a short list of actions (up to about 7). Destructive items go last and still confirm. */
export function DropdownMenu({ label, triggerLabel, triggerIcon: Icon, triggerVariant = 'outline', trigger, align = 'start', side = 'bottom', items, className }: {
  /** Accessible name; required for icon-only triggers. */
  label?: string; triggerLabel?: ReactNode; triggerIcon?: LucideIcon; triggerVariant?: 'outline' | 'ghost' | 'secondary';
  /** A custom trigger element (a button) in place of the standard one, such as the sidebar's account button. */
  trigger?: ReactNode; align?: 'start' | 'end'; side?: 'top' | 'bottom' | 'right'; items: MenuEntry[]; className?: string;
}) {
  return <Menu.Root>
    <Menu.Trigger asChild>
      {trigger ?? <Button variant={triggerVariant} size={triggerLabel ? 'default' : 'icon'} aria-label={label} className={className}>
        {Icon && <Icon aria-hidden="true" className="size-4" />}{triggerLabel}{triggerLabel && <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />}
      </Button>}
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Content align={align} side={side} sideOffset={6} className="z-50 min-w-[200px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
        {items.map((item, index) => {
          if ('separator' in item) return <Menu.Separator key={index} className="-mx-1 my-1 h-px bg-border" />;
          if ('caption' in item) return <Menu.Label key={index} className="truncate px-2 pb-1.5 pt-1 text-xs text-muted-foreground">{item.caption}</Menu.Label>;
          if ('heading' in item) return <Menu.Label key={index} className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{item.heading}</Menu.Label>;
          const ItemIcon = item.icon;
          // Items with a checked state are menuitemcheckbox, so the current choice is announced, not only drawn.
          const Item = item.checked === undefined ? Menu.Item : Menu.CheckboxItem;
          return <Item key={index} disabled={item.disabled} onSelect={item.onSelect} {...(item.checked === undefined ? {} : { checked: item.checked })}
            className={cn('flex h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent', item.danger && 'text-danger')}>
            {ItemIcon && <ItemIcon aria-hidden="true" className={cn('size-4', item.danger ? 'text-danger' : 'text-muted-foreground')} />}
            <span className="flex-1">{item.label}</span>
            {item.checked && <Check aria-hidden="true" className="size-4 text-primary" />}
          </Item>;
        })}
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}
