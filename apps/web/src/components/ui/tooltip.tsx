'use client';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { useState, type ReactNode } from 'react';

/**
 * Names an icon-only control on hover or focus. Never put instructions, errors or links in it: touch users can't see it.
 * `disabled` keeps it closed but keeps the same element tree, so toggling it never remounts (and unfocuses) the child.
 */
export function Tooltip({ label, side = 'top', disabled = false, children }: { label: string; side?: 'top' | 'bottom' | 'right'; disabled?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <RadixTooltip.Provider delayDuration={300}>
    <RadixTooltip.Root open={open && !disabled} onOpenChange={setOpen}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side={side} sideOffset={8} className="z-50 max-w-60 rounded-sm bg-foreground px-2 py-1.5 text-xs font-medium leading-4 text-background shadow-md">{label}</RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  </RadixTooltip.Provider>;
}
