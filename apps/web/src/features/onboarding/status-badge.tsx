import type { ApplicationStatus } from './types';
export function StatusBadge({status}:{status:ApplicationStatus}) {
 const color = status==='APPROVED' ? 'bg-success-background text-success' : status==='REJECTED' ? 'bg-danger-background text-destructive' : status==='CHANGES_REQUESTED' ? 'bg-warning-background text-warning' : 'bg-accent text-foreground';
 return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${color}`}>{status.replaceAll('_',' ')}</span>;
}
