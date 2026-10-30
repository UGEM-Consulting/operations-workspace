export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const tones: Record<StatusTone, string> = {
  neutral: 'bg-muted text-muted-foreground', info: 'bg-info-background text-info',
  success: 'bg-success-background text-success', warning: 'bg-warning-background text-warning', danger: 'bg-danger-background text-danger',
};

/** The one status map for application, invitation, IT task and account states. */
const statuses: Record<string, [label: string, tone: StatusTone]> = {
  INVITED: ['Invited', 'neutral'], DRAFT: ['Draft', 'neutral'], SUBMITTED: ['Submitted', 'info'], RESUBMITTED: ['Resubmitted', 'info'],
  CHANGES_REQUESTED: ['Changes requested', 'warning'], APPROVED: ['Approved', 'success'], REJECTED: ['Rejected', 'danger'],
  PENDING: ['Pending', 'neutral'], OPENED: ['Opened', 'info'], IN_PROGRESS: ['In progress', 'info'], BLOCKED: ['Blocked', 'warning'], COMPLETED: ['Completed', 'success'], NOT_NEEDED: ['Not needed', 'neutral'],
  ACTIVE: ['Active', 'success'], INACTIVE: ['Inactive', 'neutral'], REVOKED: ['Revoked', 'danger'], EXPIRED: ['Expired', 'neutral'],
};

/** A word with a tone dot; the word always carries the meaning, never the color alone. */
export function Badge({ label, tone = 'neutral' }: { label: string; tone?: StatusTone }) {
  return <span className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium leading-5 ${tones[tone]}`}><span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />{label}</span>;
}
export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = statuses[status] ?? [statusLabel(status), 'neutral'];
  return <Badge label={label} tone={tone} />;
}
// Sentence case from the enum, keeping the IT, NDA and SOP abbreviations (IT_REQUEST_CREATED → IT request created).
export function statusLabel(value: string) { return statuses[value]?.[0] ?? (value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ')).replace(/\b(it|nda|sop)\b/gi, word => word.toUpperCase()); }
// Role names keep their proper casing (IT, not It).
const roleLabels: Record<string, string> = { SYSTEM_ADMIN: 'System administrator', DISPATCHER_MANAGER: 'Dispatcher manager', IT_SPECIALIST: 'IT specialist', TEAM_LEAD: 'Team lead',
  SAFETY_MANAGER: 'Safety manager', SAFETY_LEAD: 'Safety lead', SAFETY_STAFF: 'Safety staff' };
export function roleLabel(role: string) { return roleLabels[role] ?? statusLabel(role); }
