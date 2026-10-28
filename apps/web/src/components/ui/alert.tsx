import { CheckCircle2, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { StatusTone } from './status-badge';

const tones: Record<StatusTone, string> = {
  neutral: 'border-border bg-muted text-foreground', info: 'border-info-border bg-info-background text-foreground',
  success: 'border-success-border bg-success-background text-foreground', warning: 'border-warning-border bg-warning-background text-foreground',
  danger: 'border-danger-border bg-danger-background text-foreground',
};
const iconTones: Record<StatusTone, string> = { neutral: 'text-muted-foreground', info: 'text-info', success: 'text-success', warning: 'text-warning', danger: 'text-danger' };
const icons = { neutral: Info, info: Info, success: CheckCircle2, warning: TriangleAlert, danger: CircleAlert };

/** Page or section state: an icon, an optional title, the message and an optional action. */
export function Alert({ tone = 'info', title, action, role, className, children }: {
  tone?: StatusTone; title?: string; action?: ReactNode; role?: 'alert' | 'status'; className?: string; children?: ReactNode;
}) {
  const Icon = icons[tone];
  return <div role={role} className={cn('flex items-start gap-3 rounded-md border p-4 text-sm', tones[tone], className)}>
    <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', iconTones[tone])} />
    <div className="min-w-0 flex-1 space-y-1 break-words leading-6">{title && <p className="font-semibold">{title}</p>}{children}</div>
    {action && <div className="shrink-0">{action}</div>}
  </div>;
}

/** The result of an action: announced politely on success and assertively on error. */
export function Notice({ message, error = false }: { message: string; error?: boolean }) {
  if (!message) return null;
  return <Alert tone={error ? 'danger' : 'success'} role={error ? 'alert' : 'status'}><p>{message}</p></Alert>;
}
