import { statusLabel } from '@/components/ui/status-badge';

/**
 * Returning applicants (section 42: ReturningAccessScreen, GiveMoreTimeScreen, ResetCodeLimitScreen; approved 2026-11-24).
 * Plain data and wording, so server pages can use them; the dialogs are in returning.tsx.
 */
export interface ReturningStatus {
  applicationId: string; status: string; email: string; startedAt: string | null; invitedBy: string | null; catchUp: boolean;
  accessUntil: string; ended: boolean; codes: number; limit: number; limited: boolean; nextCodeAt: string | null;
  canGiveTime: boolean; canReset: boolean; moreTimeDays: number[];
  revoked?: boolean; admin?: boolean; resetWhy?: string | null; countResetsAt?: string | null; returnLink?: string;
  activity: { id: string; event: string; createdAt: string }[] | null;
}

// Why a code wasn't sent, worded for staff; applicants are told the same thing whatever happened.
const ACTIVITY: Record<string, string> = {
  CODE_NOT_SENT_DAILY_LIMIT: 'Code not sent: daily limit for this email',
  CODE_NOT_SENT_ACCESS_ENDED: 'Code not sent: their time to finish ended',
  VERIFICATION_EMAIL_FAILED: 'Code not sent: the email didn’t go out',
  VERIFICATION_EMAIL_SENT: 'Verification email sent',
  CODE_LIMIT_RESET: 'Code limit reset',
  ACCESS_EXTENDED: 'More time given',
};
/** An activity entry's title; anything else is worded as everywhere else (IT, NDA and SOP kept as they are). */
export function activityTitle(event: string) {
  return ACTIVITY[event] ?? statusLabel(event);
}
/** Whether something stops them returning now: their time ended, or today's codes ran out. */
export const returningBlocked = (status: ReturningStatus) => status.ended || status.limited;
