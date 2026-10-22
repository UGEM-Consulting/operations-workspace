import type { ApplicationStatus } from './types';
import { StatusBadge as Badge, statusLabel, type StatusTone } from '@/components/ui/status-badge';
const tones: Record<ApplicationStatus, StatusTone> = { INVITED:'neutral', DRAFT:'neutral', SUBMITTED:'info', RESUBMITTED:'info', CHANGES_REQUESTED:'warning', APPROVED:'success', REJECTED:'danger' };
export function StatusBadge({status}:{status:ApplicationStatus}) { return <Badge label={statusLabel(status)} tone={tones[status]} />; }
