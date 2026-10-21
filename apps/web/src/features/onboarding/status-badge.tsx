import type { ApplicationStatus } from './types';
export function StatusBadge({status}:{status:ApplicationStatus}) {
 const color = status==='APPROVED' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : status==='REJECTED' ? 'bg-red-500/10 text-red-700 dark:text-red-300' : status==='CHANGES_REQUESTED' ? 'bg-amber-500/10 text-amber-800 dark:text-amber-200' : 'bg-accent text-foreground';
 return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${color}`}>{status.replaceAll('_',' ')}</span>;
}
