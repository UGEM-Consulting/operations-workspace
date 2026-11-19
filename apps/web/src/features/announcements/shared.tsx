import type { ReactNode } from 'react';
import { Users } from 'lucide-react';
import type { StatusTone } from '@/components/ui/status-badge';

/**
 * Announcements to team groups (section 37: AnnounceListScreen, AnnounceComposeScreen, AnnounceDetailScreen,
 * AnnounceLeadScreen; approved 2026-11-18). Server-safe pieces shared by the list, the composer and the detail page.
 */
export interface AnnouncementTeam { id: string; name: string; mcId: string; mc: string; linked: boolean; groupTitle: string | null }
export interface AnnouncementOptions { available: boolean; maxLength: number; /** "Name, Role" as the groups will see it. */ from: string; teams: AnnouncementTeam[] }
export interface AnnouncementRow { id: string; text: string; authorName: string; authorRole: string; createdAt: string; takenBackAt: string | null; teams: string[]; delivered: number; groups: number; sending: number }
export type DeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED' | 'TAKEN_BACK';
export interface AnnouncementDelivery { id: string; team: string; teamId: string; groupTitle: string | null; status: DeliveryStatus; sentAt: string | null; takenBackAt: string | null; failureCode: string | null;
  /** Taken back and the delete is waiting to run or will be tried again (an older API sends none). */ retrying?: boolean }
export interface AnnouncementDetail { id: string; text: string; authorName: string; authorRole: string; createdAt: string; takenBackAt: string | null; takenBackBy: string | null; takeBackReason: string | null;
  deliveries: AnnouncementDelivery[]; canTakeBack: boolean }

const FAILURES: Record<string, string> = { FORBIDDEN: 'the bot was removed from the group', UNLINKED: 'the group was unlinked', REJECTED: 'Telegram refused it', MAX_ATTEMPTS: 'Telegram didn’t answer', UNCONFIRMED: 'Telegram didn’t confirm it' };
export const failureReason = (code: string | null) => (code && FAILURES[code]) ?? 'Telegram didn’t take it';
/** A delivery's badge: what happened in that group. */
export function deliveryBadge(delivery: AnnouncementDelivery): { label: string; tone: StatusTone } {
  if (delivery.status === 'SENT' && delivery.retrying) return { label: 'Taking back', tone: 'info' };
  if (delivery.status === 'SENT') return delivery.failureCode?.startsWith('DELETE_') ? { label: 'Delivered; couldn’t take back', tone: 'warning' } : { label: 'Delivered', tone: 'success' };
  if (delivery.status === 'TAKEN_BACK') return { label: 'Taken back', tone: 'neutral' };
  if (delivery.status === 'SKIPPED') return { label: 'Not sent: taken back', tone: 'neutral' };
  if (delivery.status === 'FAILED') return { label: `Not delivered: ${failureReason(delivery.failureCode)}`, tone: 'danger' };
  return { label: 'Sending', tone: 'info' };
}
/** The list's Delivered column. */
export function rowBadge(row: AnnouncementRow): { label: string; tone: StatusTone } {
  if (row.takenBackAt) return { label: 'Taken back', tone: 'neutral' };
  if (row.sending) return { label: 'Sending', tone: 'info' };
  if (row.delivered === row.groups) return { label: row.groups === 1 ? 'Delivered' : `${row.delivered} of ${row.groups}`, tone: 'success' };
  return { label: `${row.delivered} of ${row.groups}`, tone: 'warning' };
}
export const firstLine = (text: string) => text.split('\n').find(line => line.trim()) ?? text;
export const RULES = 'Work news for the team: schedules, who covers whom, trucks and loads. You may name the team’s people and drivers. Never phone numbers, emails, documents, test results, pay or passwords: the group is in Telegram, outside the workspace.';

/** What the group sees: the writer and their role, then the message as written. A preview in workspace styling, not Telegram’s. */
export function TelegramPreview({ chat, from, text, time }: { chat: string; from: string; text: string; time?: ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-border bg-card" aria-label={`Preview of the message in ${chat}`} role="figure">
    <div className="flex items-center gap-3 border-b border-border px-4 py-3">
      <span className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground"><Users aria-hidden="true" className="size-4" /></span>
      <div className="min-w-0"><p className="truncate text-sm font-semibold">{chat}</p><p className="text-xs text-muted-foreground">Telegram group · preview</p></div>
    </div>
    <div className="bg-muted/60 p-3">
      <div className="max-w-full rounded-lg bg-card p-3 shadow-xs">
        <p className="text-xs font-semibold text-primary">UGEM Workspace</p>
        <p className="mt-1 text-sm font-semibold break-words">Announcement from {from}</p>
        <p className="mt-1 text-sm whitespace-pre-line break-words">{text || <span className="text-muted-foreground">Your message shows here.</span>}</p>
        <p className="mt-1 text-right text-[11px] text-muted-foreground">{time ?? 'now'}</p>
      </div>
    </div>
  </div>;
}
