import { CheckCircle2, Circle, Clock3, Ban, TriangleAlert } from 'lucide-react';
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const tones = {
  neutral: 'bg-muted text-muted-foreground', info: 'bg-info-background text-info',
  success: 'bg-success-background text-success', warning: 'bg-warning-background text-warning', danger: 'bg-danger-background text-destructive',
};
const icons = { neutral: Circle, info: Clock3, success: CheckCircle2, warning: TriangleAlert, danger: Ban };
export function StatusBadge({ label, tone = 'neutral' }: { label: string; tone?: StatusTone }) {
  const Icon = icons[tone];
  return <span className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${tones[tone]}`}><Icon aria-hidden="true" className="size-3.5 shrink-0" />{label}</span>;
}
export function statusLabel(value: string) { return value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' '); }
