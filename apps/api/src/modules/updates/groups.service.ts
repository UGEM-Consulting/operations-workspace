import { randomInt } from 'node:crypto';
import { BadRequestException, BeforeApplicationShutdown, ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { webOrigins } from '../../config/environment';
import { onboardingLimit } from '../onboarding/rate-limit';
import type { User } from '../users/user.entity';
import { ALERT_ROUTES, codeHash, groupButton, groupLine, PURPOSE_NAMES, type GroupAlertKind, type GroupPurpose, type SendTo } from './groups';
import { TelegramClient, TelegramError } from './telegram.client';
import { DELIVERY_RETRY, UpdatesService } from './updates.service';

const CODE_TTL_MS = 10 * 60000;
// Alerts that arrive within this long are sent to a group together.
const COMBINE_AFTER = '45 seconds';
const SEND_EVERY_MS = 60000;
type Claimed = { id: string; groupId: string; kind: GroupAlertKind; attempts: number; status: string };

@Injectable()
export class TelegramGroupsService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('TelegramGroups');
  private readonly messages = new Map<GroupAlertKind, () => Promise<string>>();
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  constructor(private readonly db: DataSource, private readonly telegram: TelegramClient, private readonly updates: UpdatesService, private readonly config: ConfigService) {}
  onApplicationBootstrap() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.send(), SEND_EVERY_MS);
    this.timer.unref();
  }
  beforeApplicationShutdown() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** A module whose group message is built at send time (Safety's weekly counts) registers it here. */
  registerMessage(kind: GroupAlertKind, build: () => Promise<string>) { this.messages.set(kind, build); }
  private origin() { return webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0]; }

  // ── Admin › Telegram (administrators only) ──
  async view() {
    const groups = await this.db.query(`SELECT g.id, g.title, g.purpose, g."teamId", t.name AS team, g."linkedAt", u."firstName" || ' ' || u."lastName" AS "linkedBy", g."lastMessageAt", g."lostAt"
      FROM telegram_groups g JOIN users u ON u.id = g."linkedBy" LEFT JOIN teams t ON t.id = g."teamId" WHERE g."unlinkedAt" IS NULL ORDER BY array_position(ARRAY['IT','SAFETY','DISPATCH_MANAGERS','TEAM'], g.purpose::text), t.name`);
    const chosen: { alert: string; sendTo: SendTo }[] = await this.db.query(`SELECT alert, "sendTo" FROM telegram_alert_routes`);
    const linked = (purpose: string) => groups.some((group: { purpose: string; lostAt: Date | null }) => group.purpose === purpose && !group.lostAt);
    const routes = ALERT_ROUTES.map(route => { const choice = chosen.find(row => row.alert === route.alert)?.sendTo;
      return { alert: route.alert, label: route.label, people: route.people, group: PURPOSE_NAMES[route.group], choices: route.choices, sendTo: choice && route.choices.includes(choice) ? choice : route.default, groupLinked: linked(route.group) }; });
    const teams = await this.db.query(`SELECT id, name FROM teams WHERE "archivedAt" IS NULL ORDER BY "nameKey"`);
    return { available: this.telegram.enabled, botUsername: this.telegram.botUsername, groups, routes, teams };
  }
  /** A six-digit code to type in the group, shown once; it works once, for 10 minutes. */
  async createCode(user: User, purpose: GroupPurpose, teamId: string | null) {
    if (!this.telegram.enabled) throw new BadRequestException('Telegram isn’t set up for this workspace yet.');
    if ((purpose === 'TEAM') !== !!teamId) throw new BadRequestException(purpose === 'TEAM' ? 'Choose the team.' : 'Only a team group names a team.');
    if (teamId && !(await this.db.query(`SELECT 1 FROM teams WHERE id = $1 AND "archivedAt" IS NULL`, [teamId])).length) throw new BadRequestException('Choose an active team.');
    await onboardingLimit(this.db, `telegram-group-codes:${user.id}`, 10, 3600);
    const digits = String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt = new Date(Date.now() + CODE_TTL_MS);
    const [row]: { id: string }[] = await this.db.query(`INSERT INTO telegram_group_link_codes ("codeHash", purpose, "teamId", "createdBy", "expiresAt") VALUES ($1, $2, $3, $4, $5) RETURNING id`, [codeHash(digits), purpose, teamId, user.id, expiresAt]);
    return { id: row.id, code: `${digits.slice(0, 3)} ${digits.slice(3)}`, command: `/link ${digits.slice(0, 3)} ${digits.slice(3)}`, expiresAt, botUsername: this.telegram.botUsername };
  }
  /** Reads the bot's messages, then says whether this code linked a group. Only the administrator who made it can ask. */
  async checkCode(user: User, id: string) {
    await onboardingLimit(this.db, `telegram-group-check:${user.id}`, 60, 600);
    await this.updates.pollTelegram();
    const [code]: { consumedAt: Date | null; expiresAt: Date; groupId: string | null }[] = await this.db.query(`SELECT "consumedAt", "expiresAt", "groupId" FROM telegram_group_link_codes WHERE id = $1 AND "createdBy" = $2`, [id, user.id]);
    if (!code) throw new NotFoundException('This code no longer exists.');
    const [group] = code.groupId ? await this.db.query(`SELECT id, title, purpose FROM telegram_groups WHERE id = $1`, [code.groupId]) : [];
    return { linked: group ?? null, expired: !code.consumedAt && code.expiresAt < new Date() };
  }
  async unlink(user: User, id: string) {
    // An UPDATE answers [rows, count].
    const [rows]: [{ id: string }[], number] = await this.db.query(`UPDATE telegram_groups SET "unlinkedAt" = now(), "unlinkedBy" = $2 WHERE id = $1 AND "unlinkedAt" IS NULL RETURNING id`, [id, user.id]);
    if (!rows.length) throw new NotFoundException('This group is no longer linked.');
    // What was waiting for it isn't sent anywhere else: people get their own alerts as their routes say.
    await this.db.query(`UPDATE telegram_group_deliveries SET status = 'SKIPPED', "failureCode" = 'UNLINKED' WHERE "groupId" = $1 AND status = 'PENDING'`, [id]);
    return this.view();
  }
  async test(user: User, id: string) {
    await onboardingLimit(this.db, `telegram-group-test:${user.id}`, 10, 3600);
    const [group]: { chatId: string; purpose: GroupPurpose }[] = await this.db.query(`SELECT "chatId", purpose FROM telegram_groups WHERE id = $1 AND "unlinkedAt" IS NULL`, [id]);
    if (!group) throw new NotFoundException('This group is no longer linked.');
    const result = await this.deliver(id, group.chatId, 'Test message from UGEM Workspace. This group is linked; alerts arrive here as the Telegram page in Admin says.', null);
    if (result !== true) throw new ConflictException(result === 'FORBIDDEN' ? 'The bot can’t post in this group any more. Add it back, or unlink the group and link it again.' : 'Telegram could not be reached. Try again in a minute.');
    return this.view();
  }
  async setRoute(user: User, alert: string, sendTo: SendTo) {
    const route = ALERT_ROUTES.find(item => item.alert === alert);
    if (!route) throw new NotFoundException('There is no such alert.');
    if (!route.choices.includes(sendTo)) throw new BadRequestException(route.choices.length === 1 ? 'This alert can only go one way.' : 'Choose where this alert goes.');
    await this.db.query(`INSERT INTO telegram_alert_routes (alert, "sendTo", "updatedBy") VALUES ($1, $2, $3) ON CONFLICT (alert) DO UPDATE SET "sendTo" = EXCLUDED."sendTo", "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = now()`, [alert, sendTo, user.id]);
    return this.view();
  }

  // ── The group sender ──
  /**
   * Claims group alerts that have waited a little (so ones arriving together are combined) and stale claims, one message per
   * group. Same rules as the other outboxes: claimed atomically, at most five attempts, no text stored.
   */
  async send() {
    if (this.sending || !this.telegram.enabled) return;
    this.sending = true;
    try {
      const [rows]: [Claimed[], number] = await this.db.query(`WITH due AS (SELECT id FROM telegram_group_deliveries
        WHERE (status = 'PENDING' AND COALESCE("claimedAt", "createdAt") < now() - interval '${COMBINE_AFTER}') OR (status = 'SENDING' AND "claimedAt" < now() - interval '${DELIVERY_RETRY.claimTimeout}')
        ORDER BY "createdAt" LIMIT 200 FOR UPDATE SKIP LOCKED)
       UPDATE telegram_group_deliveries d SET status = CASE WHEN d.attempts >= $1 THEN 'FAILED' ELSE 'SENDING' END, "failureCode" = CASE WHEN d.attempts >= $1 THEN 'MAX_ATTEMPTS' ELSE d."failureCode" END,
        attempts = CASE WHEN d.attempts >= $1 THEN d.attempts ELSE d.attempts + 1 END, "claimedAt" = now()
       FROM due WHERE d.id = due.id RETURNING d.id, d."groupId", d.kind, d.attempts, d.status`, [DELIVERY_RETRY.maxAttempts]);
      const claimed = rows.filter(row => row.status === 'SENDING');
      for (const groupId of new Set(claimed.map(row => row.groupId))) {
        const mine = claimed.filter(row => row.groupId === groupId);
        const [group]: { chatId: string; unlinkedAt: Date | null; lostAt: Date | null }[] = await this.db.query(`SELECT "chatId", "unlinkedAt", "lostAt" FROM telegram_groups WHERE id = $1`, [groupId]);
        const result = !group || group.unlinkedAt || group.lostAt ? 'UNLINKED' : await this.deliver(groupId, group.chatId, await this.text(mine), mine[0].kind);
        if (result !== true) this.logger.warn(`Telegram group alert failed: ${result}`);
        const final = result === true || ['UNLINKED', 'FORBIDDEN', 'REJECTED'].includes(result);
        for (const row of mine) await this.db.query(`UPDATE telegram_group_deliveries SET status = $2::varchar, "failureCode" = $3, "sentAt" = CASE WHEN $2::varchar = 'SENT' THEN now() ELSE NULL END WHERE id = $1 AND status = 'SENDING' AND attempts = $4`,
          [row.id, result === true ? 'SENT' : final || row.attempts >= DELIVERY_RETRY.maxAttempts ? 'FAILED' : 'PENDING', result === true ? null : result.slice(0, 32), row.attempts]);
      }
    } catch { this.logger.warn('Telegram group alerts: the run failed'); }
    finally { this.sending = false; }
  }
  /** One message: a line per kind with how many arrived, in the order they came. */
  private async text(rows: Claimed[]) {
    const kinds = [...new Set(rows.map(row => row.kind))], lines: string[] = [];
    for (const kind of kinds) lines.push(kind === 'SAFETY_WEEKLY' && this.messages.has(kind) ? await this.messages.get(kind)!() : groupLine(kind, rows.filter(row => row.kind === kind).length));
    return `UGEM Workspace\n\n${lines.join('\n')}`;
  }
  /** Sends to a group; a bot that was removed marks the group as lost, so nothing more waits for it. */
  private async deliver(groupId: string, chatId: string, text: string, kind: GroupAlertKind | null): Promise<true | string> {
    const button = kind ? groupButton(kind) : null;
    try {
      await this.telegram.sendMessage(chatId, text, button ? { text: button.text, url: `${this.origin()}${button.path}` } : undefined);
      await this.db.query(`UPDATE telegram_groups SET "lastMessageAt" = now() WHERE id = $1`, [groupId]);
      return true;
    } catch (error) {
      const code = error instanceof TelegramError ? error.code : 'FAILED';
      if (code === 'FORBIDDEN') await this.db.query(`UPDATE telegram_groups SET "lostAt" = now() WHERE id = $1 AND "lostAt" IS NULL`, [groupId]);
      return code;
    }
  }
}
