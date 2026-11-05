import { Badge } from '@/components/ui/status-badge';
import type { Description } from '@/components/ui/description-list';
import type { MemberProfile } from './types';

const LABELS = { WAITING: ['Waiting for IT', 'warning'], ACTIVE: ['Active', 'success'], OFF: ['Off', 'neutral'] } as const;

/**
 * "Workspace sign-in" on a dispatcher's Accounts card (designed as TeamLeadProfileScreen): waiting for IT, on or off. Only for
 * someone who leads a team or has a sign-in; managers see it, and IT or an administrator acts on it.
 */
export function signInItems(member: Pick<MemberProfile, 'signIn'>): Description[] {
  if (!member.signIn) return [];
  const [label, tone] = LABELS[member.signIn.status];
  return [{ label: 'Workspace sign-in', value: <Badge label={member.signIn.request === 'TURN_OFF' ? 'Waiting for IT to turn off' : label} tone={tone} /> }];
}
