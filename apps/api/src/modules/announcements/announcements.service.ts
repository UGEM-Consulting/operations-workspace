import { BadRequestException, BeforeApplicationShutdown, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ledTeams } from '../dispatch/create-member';
import { onboardingLimit } from '../onboarding/rate-limit';
import { TelegramClient, TelegramError } from '../updates/telegram.client';
import { DELIVERY_RETRY } from '../updates/updates.service';
import { Role, type User } from '../users/user.entity';

export const ANNOUNCEMENT_MAX = 1000;
// Telegram lets a bot delete its own messages in a group for 48 hours.
const TAKE_BACK_HOURS = 48;
const SWEEP_EVERY_MS = 60000;
const ROLE_NAMES: Partial<Record<Role, string>> = { [Role.SYSTEM_ADMIN]: 'Administrator', [Role.DISPATCHER_MANAGER]: 'Dispatch manager', [Role.TEAM_LEAD]: 'Team lead' };
const author = (user: User) => ({ name: `${user.firstName} ${user.lastName}`.slice(0, 200), role: ROLE_NAMES[user.role] ?? 'Staff' });
type Claimed = { id: string; announcementId: string; groupId: string; attempts: number; status: string };

/**
 * Announcements to team groups (section 37, approved 2026-11-18). Dispatch managers and administrators write to any team
 * with a linked group; a team lead to the teams they lead, and they see only those teams' announcements. The bot posts the
 * text as written, headed by the writer's name and role; nothing is added and nothing automatic goes to team groups.
 * Deliveries are claimed like the other outboxes (atomically, at most five attempts); each keeps the Telegram message id
 * so the announcement can be taken back for 48 hours.
 */
@Injectable()
export class AnnouncementsService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('TeamAnnouncements');
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly db: DataSource, private readonly telegram: TelegramClient) {}
  onApplicationBootstrap() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.send(null), SWEEP_EVERY_MS);
    this.timer.unref();
  }
  beforeApplicationShutdown() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** The teams someone may write to and read about: every team for managers and administrators (null), else the teams they lead. */
  private async scope(em: Pick<EntityManager, 'query'>, user: User): Promise<string[] | null> {
    if (user.role !== Role.TEAM_LEAD) return null;
    const teams = (await ledTeams(em as EntityManager, user.id)).map(team => team.id);
    if (!teams.length) throw new ForbiddenException('Your account isn’t linked to a team you lead.');
    return teams;
  }

  async options(user: User) {
    const scope = await this.scope(this.db, user);
    const teams = await this.db.query(`SELECT t.id, t.name, m.id AS "mcId", m.name AS mc, g.id IS NOT NULL AS linked, g.title AS "groupTitle"
      FROM teams t JOIN mcs m ON m.id = t."mcId" LEFT JOIN telegram_groups g ON g."teamId" = t.id AND g."unlinkedAt" IS NULL AND g."lostAt" IS NULL
      WHERE t."archivedAt" IS NULL AND ($1::uuid[] IS NULL OR t.id = ANY($1)) ORDER BY t."nameKey"`, [scope]);
    // The header the groups will see, so the page's preview never works out names or roles itself.
    const from = author(user);
    return { available: this.telegram.enabled, maxLength: ANNOUNCEMENT_MAX, from: `${from.name}, ${from.role}`, teams };
  }

  async list(user: User) {
    const scope = await this.scope(this.db, user);
    const items = await this.db.query(`SELECT a.id, a.text, a."authorName", a."authorRole", a."createdAt", a."takenBackAt",
        array_agg(t.name ORDER BY t."nameKey") AS teams,
        count(*) FILTER (WHERE d.status IN ('SENT','TAKEN_BACK'))::integer AS delivered, count(*)::integer AS groups,
        count(*) FILTER (WHERE d.status IN ('PENDING','SENDING'))::integer AS sending
      FROM team_announcements a JOIN team_announcement_deliveries d ON d."announcementId" = a.id JOIN teams t ON t.id = d."teamId"
      WHERE $1::uuid[] IS NULL OR d."teamId" = ANY($1)
      GROUP BY a.id ORDER BY a."createdAt" DESC LIMIT 200`, [scope]);
    return { items };
  }

  async detail(user: User, id: string) {
    const scope = await this.scope(this.db, user);
    const [announcement] = await this.db.query(`SELECT a.id, a.text, a."createdBy", a."authorName", a."authorRole", a."createdAt", a."takenBackAt", a."takeBackReason",
        (SELECT u."firstName" || ' ' || u."lastName" FROM users u WHERE u.id = a."takenBackBy") AS "takenBackBy"
      FROM team_announcements a WHERE a.id = $1`, [id]);
    // A team lead sees only their own teams' deliveries; an announcement that reached none of them looks the same as none.
    const deliveries = announcement ? await this.db.query(`SELECT d.id, t.name AS team, d."teamId", g.title AS "groupTitle", d.status, d."sentAt", d."takenBackAt",
        CASE WHEN d.status = 'FAILED' OR d."failureCode" LIKE 'DELETE_%' THEN d."failureCode" END AS "failureCode"
      FROM team_announcement_deliveries d JOIN teams t ON t.id = d."teamId" JOIN telegram_groups g ON g.id = d."groupId"
      WHERE d."announcementId" = $1 AND ($2::uuid[] IS NULL OR d."teamId" = ANY($2)) ORDER BY t."nameKey"`, [id, scope]) : [];
    if (!announcement || !deliveries.length) throw new NotFoundException('This announcement no longer exists.');
    const { createdBy, ...shown } = announcement;
    const open = !announcement.takenBackAt && Date.now() - new Date(announcement.createdAt).getTime() < TAKE_BACK_HOURS * 3600000;
    return { ...shown, deliveries, canTakeBack: open && (user.role !== Role.TEAM_LEAD || createdBy === user.id) };
  }

  async create(user: User, teamIds: string[], text: string) {
    if (!this.telegram.enabled) throw new BadRequestException('Telegram isn’t set up for this workspace yet.');
    if (!text) throw new BadRequestException('Write the announcement.');
    await onboardingLimit(this.db, `team-announcements:${user.id}`, 20, 3600);
    const wanted = [...new Set(teamIds)];
    const id = await this.db.transaction(async em => {
      const scope = await this.scope(em, user);
      if (scope && wanted.some(teamId => !scope.includes(teamId))) throw new ForbiddenException('You can write only to the teams you lead.');
      // Teams read for share, so one archived at the same moment isn't chosen; a group unlinked or lost meanwhile is caught when sending.
      const teams: { id: string; name: string; groupId: string | null }[] = await em.query(`SELECT t.id, t.name, g.id AS "groupId" FROM teams t
        LEFT JOIN telegram_groups g ON g."teamId" = t.id AND g."unlinkedAt" IS NULL AND g."lostAt" IS NULL
        WHERE t.id = ANY($1) AND t."archivedAt" IS NULL FOR SHARE OF t`, [wanted]);
      if (teams.length !== wanted.length) throw new BadRequestException('Choose active teams. Reload the page and try again.');
      const unlinked = teams.filter(team => !team.groupId);
      if (unlinked.length) throw new BadRequestException(`${unlinked.map(team => team.name).join(', ')} ${unlinked.length === 1 ? 'has' : 'have'} no Telegram group linked. An administrator links groups on Admin › Telegram.`);
      const [row]: { id: string }[] = await em.query(`INSERT INTO team_announcements (text, "createdBy", "authorName", "authorRole") VALUES ($1, $2, $3, $4) RETURNING id`,
        [text, user.id, author(user).name, author(user).role]);
      await em.query(`INSERT INTO team_announcement_deliveries ("announcementId", "teamId", "groupId", status) SELECT $1, x.team, x.grp, 'PENDING' FROM unnest($2::uuid[], $3::uuid[]) AS x(team, grp)`,
        [row.id, teams.map(team => team.id), teams.map(team => team.groupId)]);
      return row.id;
    });
    // Sent now, so the page shows each group's result; anything Telegram couldn't take is retried by the sweeper.
    await this.send(id);
    return this.detail(user, id);
  }

  async takeBack(user: User, id: string, reason: string | null) {
    const sent = await this.db.transaction(async em => {
      const scope = await this.scope(em, user);
      const [announcement]: { createdBy: string; createdAt: Date; takenBackAt: Date | null }[] = await em.query(`SELECT "createdBy", "createdAt", "takenBackAt" FROM team_announcements WHERE id = $1 FOR UPDATE`, [id]);
      const visible = announcement && (!scope || (await em.query(`SELECT 1 FROM team_announcement_deliveries WHERE "announcementId" = $1 AND "teamId" = ANY($2) LIMIT 1`, [id, scope])).length);
      if (!visible) throw new NotFoundException('This announcement no longer exists.');
      if (scope && announcement.createdBy !== user.id) throw new ForbiddenException('A team lead can take back only their own announcements.');
      if (announcement.takenBackAt) throw new ConflictException('This announcement was already taken back.');
      if (Date.now() - new Date(announcement.createdAt).getTime() >= TAKE_BACK_HOURS * 3600000) throw new ConflictException('Telegram allows taking a message back for 48 hours after it was sent.');
      await em.query(`UPDATE team_announcements SET "takenBackAt" = now(), "takenBackBy" = $2, "takeBackReason" = $3 WHERE id = $1`, [id, user.id, reason]);
      // What hasn't gone yet never goes; one being sent right now is deleted by the sender once it lands.
      await em.query(`UPDATE team_announcement_deliveries SET status = 'SKIPPED', "failureCode" = 'TAKEN_BACK' WHERE "announcementId" = $1 AND status = 'PENDING'`, [id]);
      return em.query(`SELECT d.id, d."messageId", g."chatId" FROM team_announcement_deliveries d JOIN telegram_groups g ON g.id = d."groupId" WHERE d."announcementId" = $1 AND d.status = 'SENT'`, [id]) as Promise<{ id: string; messageId: string | null; chatId: string }[]>;
    });
    for (const delivery of sent) await this.remove(delivery);
    return this.detail(user, id);
  }

  /** Deletes one delivered message; a failure stays on the delivery as DELETE_<code>, so the page can say which group still has it. */
  private async remove(delivery: { id: string; messageId: string | null; chatId: string }) {
    try {
      if (!delivery.messageId) throw new TelegramError('NO_MESSAGE');
      await this.telegram.deleteMessage(delivery.chatId, delivery.messageId);
      await this.db.query(`UPDATE team_announcement_deliveries SET status = 'TAKEN_BACK', "takenBackAt" = now(), "failureCode" = NULL WHERE id = $1 AND status = 'SENT'`, [delivery.id]);
    } catch (error) {
      const code = error instanceof TelegramError ? error.code : 'FAILED';
      this.logger.warn(`Team announcement take-back failed: ${code}`);
      // Only while still SENT: a second delete of a message already taken back must not mark it as stuck.
      await this.db.query(`UPDATE team_announcement_deliveries SET "failureCode" = $2 WHERE id = $1 AND status = 'SENT'`,[delivery.id, `DELETE_${code}`.slice(0, 32)]);
    }
  }

  /**
   * Sends waiting deliveries: one announcement's straight away (just created), or, from the timer, any that waited a minute
   * and stale claims. A bot removed from a group marks it lost, as for alerts.
   */
  async send(announcementId: string | null) {
    if (!this.telegram.enabled) return;
    try {
      const [rows]: [Claimed[], number] = await this.db.query(`WITH due AS (SELECT id FROM team_announcement_deliveries
          WHERE ($2::uuid IS NOT NULL AND "announcementId" = $2 AND status = 'PENDING')
             OR ($2::uuid IS NULL AND ((status = 'PENDING' AND COALESCE("claimedAt", "createdAt") < now() - interval '1 minute') OR (status = 'SENDING' AND "claimedAt" < now() - interval '${DELIVERY_RETRY.claimTimeout}')))
          ORDER BY "createdAt" LIMIT 100 FOR UPDATE SKIP LOCKED)
        UPDATE team_announcement_deliveries d SET status = CASE WHEN d.attempts >= $1 THEN 'FAILED' ELSE 'SENDING' END, "failureCode" = CASE WHEN d.attempts >= $1 THEN 'MAX_ATTEMPTS' ELSE d."failureCode" END,
          attempts = CASE WHEN d.attempts >= $1 THEN d.attempts ELSE d.attempts + 1 END, "claimedAt" = now()
        FROM due WHERE d.id = due.id RETURNING d.id, d."announcementId", d."groupId", d.attempts, d.status`, [DELIVERY_RETRY.maxAttempts, announcementId]);
      for (const row of rows.filter(item => item.status === 'SENDING')) await this.deliver(row);
    } catch { this.logger.warn('Team announcements: the run failed'); }
  }
  private async deliver(row: Claimed) {
    const [item]: { text: string; authorName: string; authorRole: string; takenBackAt: Date | null; chatId: string; unlinkedAt: Date | null; lostAt: Date | null }[] = await this.db.query(`SELECT a.text, a."authorName", a."authorRole", a."takenBackAt", g."chatId", g."unlinkedAt", g."lostAt"
      FROM team_announcements a JOIN telegram_groups g ON g.id = $2 WHERE a.id = $1`, [row.announcementId, row.groupId]);
    const finish = (status: string, failureCode: string | null, messageId: string | null = null) => this.db.query(`UPDATE team_announcement_deliveries SET status = $2::varchar, "failureCode" = $3, "messageId" = $4,
      "sentAt" = CASE WHEN $2::varchar = 'SENT' THEN now() ELSE NULL END WHERE id = $1 AND status = 'SENDING' AND attempts = $5`, [row.id, status, failureCode, messageId, row.attempts]);
    if (!item || item.takenBackAt) return finish('SKIPPED', 'TAKEN_BACK');
    if (item.lostAt) return finish('FAILED', 'FORBIDDEN');
    if (item.unlinkedAt) return finish('FAILED', 'UNLINKED');
    try {
      const message = await this.telegram.sendMessage(item.chatId, `Announcement from ${item.authorName}, ${item.authorRole}\n\n${item.text}`);
      const messageId = message?.message_id === undefined ? null : String(message.message_id);
      await finish('SENT', null, messageId);
      await this.db.query(`UPDATE telegram_groups SET "lastMessageAt" = now() WHERE id = $1`, [row.groupId]);
      // Taken back while it was on its way: delete it straight away. FOR SHARE waits for a take-back still in its transaction,
      // which may have looked for SENT rows before this one was marked; a take-back that looked afterwards deletes it itself.
      const [now]: { takenBackAt: Date | null }[] = await this.db.query(`SELECT "takenBackAt" FROM team_announcements WHERE id = $1 FOR SHARE`, [row.announcementId]);
      if (now?.takenBackAt) await this.remove({ id: row.id, messageId, chatId: item.chatId });
    } catch (error) {
      const code = error instanceof TelegramError ? error.code : 'FAILED';
      this.logger.warn(`Team announcement failed: ${code}`);
      if (code === 'FORBIDDEN') await this.db.query(`UPDATE telegram_groups SET "lostAt" = now() WHERE id = $1 AND "lostAt" IS NULL`, [row.groupId]);
      const final = ['FORBIDDEN', 'REJECTED', 'DISABLED'].includes(code) || row.attempts >= DELIVERY_RETRY.maxAttempts;
      await finish(final ? 'FAILED' : 'PENDING', code.slice(0, 32));
    }
  }
}
