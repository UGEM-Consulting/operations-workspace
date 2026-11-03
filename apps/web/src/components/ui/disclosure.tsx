import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/** Secondary content that opens in place, on native details/summary. Never hide something a person must act on. */
export function Disclosure({ title, summary, defaultOpen = false, children }: { title: string; summary?: string; defaultOpen?: boolean; children: ReactNode }) {
  return <details open={defaultOpen} className="group">
    <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-sm text-[13px] font-medium [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />{title}
      {summary && <span className="ml-auto font-normal text-muted-foreground">{summary}</span>}
    </summary>
    <div className="mt-2">{children}</div>
  </details>;
}
