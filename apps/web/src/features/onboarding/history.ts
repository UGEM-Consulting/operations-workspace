import type { StatusTone } from '@/components/ui/status-badge';
import type { Review } from './types';
// Timeline titles say what happened and who: "Changes requested by Avery Quinn".
const decisions: Record<Review['decisionType'], [verb: string, tone: StatusTone]> = {
  APPROVE: ['Approved', 'success'], REQUEST_CHANGES: ['Changes requested', 'warning'], REJECT: ['Rejected', 'danger'],
};
export function decisionTitle(review: Review) { return `${decisions[review.decisionType][0]} by ${review.reviewer.firstName} ${review.reviewer.lastName}`; }
export function decisionTone(type: Review['decisionType']) { return decisions[type][1]; }
