'use client';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
/** A setting that applies at once, with no Save button. Inside a form saved with a button, use a Checkbox. */
export function Switch({ id, label, description, checked, disabled, onCheckedChange, className }: {
  id: string; label: ReactNode; description?: ReactNode; checked: boolean; disabled?: boolean; onCheckedChange: (checked: boolean) => void; className?: string;
}) {
  return <div className={cn('flex items-start justify-between gap-4', className)}>
    <div className="min-w-0 text-sm"><label htmlFor={id} className="font-medium leading-6">{label}</label>{description && <p id={`${id}-description`} className="text-[13px] leading-5 text-muted-foreground">{description}</p>}</div>
    <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={description ? `${id}-description` : undefined} disabled={disabled} onClick={() => onCheckedChange(!checked)}
      className="relative mt-0.5 h-5 w-9 shrink-0 cursor-pointer rounded-full bg-input transition-colors aria-checked:bg-primary disabled:cursor-not-allowed disabled:opacity-50">
      <span aria-hidden="true" className={cn('absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-xs transition-transform', checked && 'translate-x-4')} />
    </button>
  </div>;
}
