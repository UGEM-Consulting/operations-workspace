import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { onboardingLimit } from '../onboarding/rate-limit';

/**
 * Telegram groups (section 34: TelegramGroupsScreen, TelegramLinkGroupScreen, TelegramGroupMessageScreen,
 * TelegramTeamGroupScreen; approved 2026-11-16). A department's group (IT, Safety, dispatch managers) or a team's group is
 * linked by an administrator with a one-time code typed in the group. For each alert an administrator chooses people, the
 * group or both. A group gets what is waiting and a link to the workspace, never who it is about.
 */
export type GroupPurpose = 'IT' | 'SAFETY' | 'DISPATCH_MANAGERS' | 'TEAM';
export const GROUP_PURPOSES = ['IT', 'SAFETY', 'DISPATCH_MANAGERS', 'TEAM'] as const;
export type SendTo = 'PEOPLE' | 'GROUP' | 'BOTH';
export const SEND_TO = ['PEOPLE', 'GROUP', 'BOTH'] as const;
/** What a group can be told about. People alerts keep their own kinds in notification_deliveries. */
export type GroupAlertKind = 'IT_SETUP_WAITING' | 'IT_REMOVAL_WAITING' | 'IT_REMOVAL_SCHEDULED' | 'IT_REMOVAL_DUE' | 'IT_REMOVAL_NOW' | 'IT_LEAVE_SUSPEND' | 'IT_LEAVE_RESTORE'
  | 'IT_SIGN_IN_WAITING' | 'REVIEW_WAITING' | 'TRUCK_GROUP_CHANGE' | 'SAFETY_WEEKLY';

interface Route { alert: string; label: string; kinds: GroupAlertKind[]; group: Exclude<GroupPurpose, 'TEAM'>; people: string | null; default: SendTo; choices: readonly SendTo[] }
/**
 * Where each alert goes. Daily Safety reminders name drivers, so they stay with people; team lead sign-ins were never sent
 * to people, so they go to IT's group only.
 */
export const ALERT_ROUTES: readonly Route[] = [
  { alert: 'IT_SETUP', label: 'New hire waiting for IT setup', kinds: ['IT_SETUP_WAITING'], group: 'IT', people: 'Every IT specialist', default: 'BOTH', choices: SEND_TO },
  { alert: 'IT_REMOVAL', label: 'Someone left or is leaving: remove access', kinds: ['IT_REMOVAL_WAITING', 'IT_REMOVAL_SCHEDULED', 'IT_REMOVAL_DUE', 'IT_REMOVAL_NOW'], group: 'IT', people: 'Every IT specialist', default: 'BOTH', choices: SEND_TO },
  { alert: 'IT_LEAVE', label: 'Someone goes on leave or comes back', kinds: ['IT_LEAVE_SUSPEND', 'IT_LEAVE_RESTORE'], group: 'IT', people: 'Every IT specialist', default: 'GROUP', choices: SEND_TO },
  { alert: 'REVIEW', label: 'Application waiting for review', kinds: ['REVIEW_WAITING'], group: 'DISPATCH_MANAGERS', people: 'Their manager', default: 'PEOPLE', choices: SEND_TO },
  { alert: 'IT_SIGN_IN', label: 'Team lead sign-in to create or turn off', kinds: ['IT_SIGN_IN_WAITING'], group: 'IT', people: null, default: 'GROUP', choices: ['GROUP'] },
  { alert: 'SAFETY_DAILY', label: 'Safety reminders (daily)', kinds: [], group: 'SAFETY', people: 'The driver’s Safety Manager', default: 'PEOPLE', choices: ['PEOPLE'] },
  { alert: 'SAFETY_WEEKLY', label: 'Safety weekly summary', kinds: ['SAFETY_WEEKLY'], group: 'SAFETY', people: 'The Safety Director', default: 'BOTH', choices: SEND_TO },
  { alert: 'TRUCK_GROUP', label: 'A truck’s Telegram group needs a change', kinds: ['TRUCK_GROUP_CHANGE'], group: 'SAFETY', people: 'The driver’s Safety Manager', default: 'PEOPLE', choices: SEND_TO },
];
export const routeOf = (kind: GroupAlertKind) => ALERT_ROUTES.find(route => route.kinds.includes(kind))!;

/** The linked group for a purpose (or a team) that the bot can still reach. */
export async function groupFor(em: Pick<EntityManager, 'query'>, purpose: GroupPurpose, teamId: string | null = null): Promise<string | null> {
  const [row]: { id: string }[] = await em.query(`SELECT id FROM telegram_groups WHERE purpose = $1 AND "unlinkedAt" IS NULL AND "lostAt" IS NULL AND ($2::uuid IS NULL OR "teamId" = $2)`, [purpose, teamId]);
  return row?.id ?? null;
}
/** The administrator's choice, or the default. */
export async function sendToFor(em: Pick<EntityManager, 'query'>, alert: string): Promise<SendTo> {
  const route = ALERT_ROUTES.find(item => item.alert === alert)!;
  const [row]: { sendTo: SendTo }[] = await em.query(`SELECT "sendTo" FROM telegram_alert_routes WHERE alert = $1`, [alert]);
  return row && route.choices.includes(row.sendTo) ? row.sendTo : route.default;
}
/**
 * Who gets one alert: people, the group, or both. Group only with no group linked falls back to people, so an alert never
 * reaches nobody (an alert that never went to people, like team lead sign-ins, then reaches no one, as before).
 */
export async function alertTargets(em: Pick<EntityManager, 'query'>, kind: GroupAlertKind) {
  const route = routeOf(kind), sendTo = await sendToFor(em, route.alert), groupId = sendTo === 'PEOPLE' ? null : await groupFor(em, route.group);
  return { people: sendTo !== 'GROUP' || (!groupId && route.people !== null), groupId };
}
/** In the causing transaction: one row in the group outbox. The group sender combines what arrives within a minute or two. */
export async function queueGroupAlert(em: Pick<EntityManager, 'query'>, groupId: string, kind: GroupAlertKind, referenceId: string | null) {
  await em.query(`INSERT INTO telegram_group_deliveries ("groupId", kind, "referenceId", status) VALUES ($1, $2, $3, 'PENDING')`, [groupId, kind, referenceId]);
}
/** For an alert that only ever goes to a group (team lead sign-ins): queued when the route and a linked group allow it. */
export async function queueGroupOnly(em: Pick<EntityManager, 'query'>, kind: GroupAlertKind, referenceId: string | null) {
  const { groupId } = await alertTargets(em, kind);
  if (groupId) await queueGroupAlert(em, groupId, kind, referenceId);
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** One line per kind, with how many arrived; never names. */
export function groupLine(kind: GroupAlertKind, count: number): string {
  switch (kind) {
    case 'IT_SETUP_WAITING': return `${plural(count, 'IT setup checklist')} waiting.`;
    case 'IT_REMOVAL_WAITING': return `${count === 1 ? 'Someone has' : `${count} people have`} left: accounts to remove.`;
    case 'IT_REMOVAL_SCHEDULED': return `${count === 1 ? 'Someone is' : `${count} people are`} leaving: removal scheduled.`;
    case 'IT_REMOVAL_DUE': return `${count === 1 ? 'Someone’s last day has' : `${count} last days have`} begun: removal due today.`;
    case 'IT_REMOVAL_NOW': return `${plural(count, 'request')} to remove access now.`;
    case 'IT_LEAVE_SUSPEND': return `${count === 1 ? 'Someone is' : `${count} people are`} going on leave: accounts to suspend.`;
    case 'IT_LEAVE_RESTORE': return `${count === 1 ? 'Someone is' : `${count} people are`} back from leave: accounts to restore.`;
    case 'IT_SIGN_IN_WAITING': return `${plural(count, 'team lead sign-in')} to create or turn off.`;
    case 'REVIEW_WAITING': return `${plural(count, 'application')} waiting for review.`;
    case 'TRUCK_GROUP_CHANGE': return `${plural(count, 'truck Telegram group')} ${count === 1 ? 'needs' : 'need'} a change.`;
    case 'SAFETY_WEEKLY': return 'Safety weekly summary.';
  }
}
/** Where a group's button opens, by the first kind in the message. */
export function groupButton(kind: GroupAlertKind): { text: string; path: string } {
  if (kind.startsWith('IT_')) return { text: 'Open IT tasks', path: '/it/tasks' };
  if (kind === 'REVIEW_WAITING') return { text: 'Open applications', path: '/onboarding/applications' };
  if (kind === 'SAFETY_WEEKLY') return { text: 'Open Expiring documents', path: '/safety/expiring' };
  return { text: 'Open Safety', path: '/safety/drivers' };
}

export const PURPOSE_NAMES: Record<GroupPurpose, string> = { IT: 'IT', SAFETY: 'Safety', DISPATCH_MANAGERS: 'Dispatch managers', TEAM: 'A team' };
export const codeHash = (digits: string) => createHash('sha256').update(`telegram-group:${digits}`).digest('hex');

/**
 * Links a typed one-time code to the group it was sent in (called by UpdatesService.pollTelegram, in its transaction).
 * Returns the reply for the group, or null for anything that isn't a link command.
 */
export async function linkGroup(em: EntityManager, db: DataSource, chat: { id: number; type: string; title?: string }, text: string): Promise<string | null> {
  const match = /^\/link(?:@[A-Za-z0-9_]+)?\s+(\d{3})\s?(\d{3})$/.exec(text);
  if (!match) return null;
  // Wrong codes from one chat are limited, so a group can't try every code while one is waiting.
  try { await onboardingLimit(db, `telegram-group-code:${chat.id}`, 10, 3600); } catch { return 'Too many tries. Ask an administrator for a new code later.'; }
  const [code]: { id: string; purpose: GroupPurpose; teamId: string | null; createdBy: string }[] = await em.query(`SELECT id, purpose, "teamId", "createdBy" FROM telegram_group_link_codes
   WHERE "codeHash" = $1 AND "consumedAt" IS NULL AND "expiresAt" > now() FOR UPDATE`, [codeHash(match[1] + match[2])]);
  if (!code) return 'This code has expired or was already used. Ask an administrator for a new one.';
  const chatId = String(chat.id), title = (chat.title ?? '').slice(0, 255) || null;
  // One link per group, per department and per team: a new one takes the place of the earlier one.
  await em.query(`UPDATE telegram_groups SET "unlinkedAt" = now(), "unlinkedBy" = $4 WHERE "unlinkedAt" IS NULL AND ("chatId" = $1 OR (purpose = $2 AND purpose <> 'TEAM') OR ("teamId" = $3))`, [chatId, code.purpose, code.teamId, code.createdBy]);
  const [group]: { id: string }[] = await em.query(`INSERT INTO telegram_groups ("chatId", title, purpose, "teamId", "linkedBy") VALUES ($1, $2, $3, $4, $5) RETURNING id`, [chatId, title, code.purpose, code.teamId, code.createdBy]);
  await em.query(`UPDATE telegram_group_link_codes SET "consumedAt" = now(), "groupId" = $2 WHERE id = $1`, [code.id, group.id]);
  return code.purpose === 'TEAM' ? 'Linked. This team’s group is now part of UGEM Workspace.' : `Linked. This group gets UGEM Workspace alerts for ${PURPOSE_NAMES[code.purpose]}: what’s waiting, never who it’s about.`;
}

