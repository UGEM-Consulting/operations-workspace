'use client';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

/** Names an icon-only control on hover or focus. Never put instructions, errors or links in it: touch users can't see it. */
export function Tooltip({ label, side = 'top', disabled = false, children }: { label: string; side?: 'top' | 'bottom' | 'right'; disabled?: boolean; children: ReactNode }) {
  if (disabled) return children;
  return <RadixTooltip.Provider delayDuration={300}>
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side={side} sideOffset={8} className="z-50 max-w-60 rounded-sm bg-foreground px-2 py-1.5 text-xs font-medium leading-4 text-background shadow-md">{label}</RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  </RadixTooltip.Provider>;
}
