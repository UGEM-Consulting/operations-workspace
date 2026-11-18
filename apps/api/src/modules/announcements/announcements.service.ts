import { BadRequestException, BeforeApplicationShutdown, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ledTeams } from '../dispatch/create-member';
import { onboardingLimit } from '../onboarding/rate-limit';
import { TELEGRAM_FINAL, TelegramClient, TelegramError } from '../updates/telegram.client';
import { DELIVERY_RETRY } from '../updates/updates.service';
import { Role, type User } from '../users/user.entity';

export const ANNOUNCEMENT_MAX = 1000;
// Telegram lets a bot delete its own messages in a group for 48 hours.
const TAKE_BACK_HOURS = 48;
const SWEEP_EVERY_MS = 60000;
// Work done while a request waits stops claiming after this, so the answer comes well inside the BFF's 90 seconds even with
// Telegram timing out (10 seconds a call); what's left goes on in the background and the page refreshes until it's done.
const REQUEST_BUDGET_MS = 20000;
// The timer's runs stop claiming after this, so every claim is finished long before DELIVERY_RETRY.claimTimeout.
const SWEEP_BUDGET_MS = 240000;
// Small claims, so work stops soon after its budget and a claimed row never waits long for its turn.
const CLAIM = 5;
// A delete that failed for a passing reason is tried again this long after the last try, for as long as Telegram allows.
const DELETE_RETRY_AFTER = '5 minutes';
// Deletes waiting to run, or worth trying again. DELETE_PENDING: taken back, not tried yet.
const DELETE_AGAIN = ['DELETE_PENDING', 'DELETE_TIMEOUT', 'DELETE_NETWORK', 'DELETE_RATE_LIMITED', 'DELETE_SERVER', 'DELETE_FAILED'];
const ROLE_NAMES: Partial<Record<Role, string>> = { [Role.SYSTEM_ADMIN]: 'Administrator', [Role.DISPATCHER_MANAGER]: 'Dispatch manager', [Role.TEAM_LEAD]: 'Team lead' };
const author = (user: User) => ({ name: `${user.firstName} ${user.lastName}`.slice(0, 200), role: ROLE_NAMES[user.role] ?? 'Staff' });
type Claimed = { id: string; announcementId: string; teamId: string; groupId: string; attempts: number; status: string };
type Delivered = { id: string; messageId: string | null; chatId: string };

/**
 * Announcements to team groups (section 37, approved 2026-11-18). Dispatch managers and administrators write to any team
 * with a linked group; a team lead to the teams they lead, and they see only those teams' announcements. The bot posts the
 * text as written, headed by the writer's name and role; nothing is added and nothing automatic goes to team groups.
 * Deliveries are claimed like the other outboxes (atomically, at most five attempts); each keeps the Telegram message id
 * so the announcement can be taken back for 48 hours. A send Telegram may have taken without saying so (a timeout, or a
 * claim nobody finished) is never sent again: it is marked UNCONFIRMED, since a second copy couldn't be taken back.
 */
@Injectable()
export class AnnouncementsService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('TeamAnnouncements');
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  // Sends and deletes still running, so shutdown waits for them instead of leaving claims to go stale.
  private readonly running = new Set<Promise<void>>();
  constructor(private readonly db: DataSource, private readonly telegram: TelegramClient) {}
  onApplicationBootstrap() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref();
  }
  async beforeApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.running]);
  }
  private track(work: () => Promise<void>) {
    const run: Promise<void> = work().catch(() => this.logger.warn('Team announcements: the run failed')).finally(() => this.running.delete(run));
    this.running.add(run);
    return run;
  }

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
    // retrying: a delete that is waiting to run or will be tried again, so the page says it's still being taken back.
    const deliveries = announcement ? await this.db.query(`SELECT d.id, t.name AS team, d."teamId", g.title AS "groupTitle", d.status, d."sentAt", d."takenBackAt",
        CASE WHEN d.status = 'FAILED' OR d."failureCode" LIKE 'DELETE_%' THEN d."failureCode" END AS "failureCode",
        (d.status = 'SENT' AND d."failureCode" = ANY($3) AND d."sentAt" > now() - make_interval(hours => $4)) AS retrying
      FROM team_announcement_deliveries d JOIN teams t ON t.id = d."teamId" JOIN telegram_groups g ON g.id = d."groupId"
      WHERE d."announcementId" = $1 AND ($2::uuid[] IS NULL OR d."teamId" = ANY($2)) ORDER BY t."nameKey"`, [id, scope, DELETE_AGAIN, TAKE_BACK_HOURS]) : [];
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
    // Sent now while it fits the request, so the page usually shows each group's result; the rest go on in the background.
    await this.track(async () => {
      if (!await this.send(id, Date.now() + REQUEST_BUDGET_MS)) void this.track(async () => { await this.send(id, Date.now() + SWEEP_BUDGET_MS); });
    });
    return this.detail(user, id);
  }

  async takeBack(user: User, id: string, reason: string | null) {
    await this.db.transaction(async em => {
      const scope = await this.scope(em, user);
      const [announcement]: { createdBy: string; createdAt: Date; takenBackAt: Date | null }[] = await em.query(`SELECT "createdBy", "createdAt", "takenBackAt" FROM team_announcements WHERE id = $1 FOR UPDATE`, [id]);
      const visible = announcement && (!scope || (await em.query(`SELECT 1 FROM team_announcement_deliveries WHERE "announcementId" = $1 AND "teamId" = ANY($2) LIMIT 1`, [id, scope])).length);
      if (!visible) throw new NotFoundException('This announcement no longer exists.');
      if (scope && announcement.createdBy !== user.id) throw new ForbiddenException('A team lead can take back only their own announcements.');
      if (announcement.takenBackAt) throw new ConflictException('This announcement was already taken back.');
      if (Date.now() - new Date(announcement.createdAt).getTime() >= TAKE_BACK_HOURS * 3600000) throw new ConflictException('Telegram allows taking a message back for 48 hours after it was sent.');
      await em.query(`UPDATE team_announcements SET "takenBackAt" = now(), "takenBackBy" = $2, "takeBackReason" = $3 WHERE id = $1`, [id, user.id, reason]);
      // What hasn't gone yet never goes; what went is marked for deleting. One being sent right now is marked by its sender once it lands.
      await em.query(`UPDATE team_announcement_deliveries SET status = 'SKIPPED', "failureCode" = 'TAKEN_BACK' WHERE "announcementId" = $1 AND status = 'PENDING'`, [id]);
      await em.query(`UPDATE team_announcement_deliveries SET "failureCode" = 'DELETE_PENDING', "claimedAt" = NULL WHERE "announcementId" = $1 AND status = 'SENT'`, [id]);
    });
    await this.track(async () => {
      if (!await this.removeDue(id, Date.now() + REQUEST_BUDGET_MS)) void this.track(async () => { await this.removeDue(id, Date.now() + SWEEP_BUDGET_MS); });
    });
    return this.detail(user, id);
  }

  /** The timer: waiting sends, deletes to try again, and claims nobody finished. One run at a time on each instance. */
  async sweep() {
    if (this.sweeping || !this.telegram.enabled) return;
    this.sweeping = true;
    try {
      await this.track(async () => {
        // A claim this old was never finished (a crash or a lost database write after Telegram answered): it may be in the group.
        await this.db.query(`UPDATE team_announcement_deliveries SET status = 'FAILED', "failureCode" = 'UNCONFIRMED'
          WHERE status = 'SENDING' AND "claimedAt" < now() - interval '${DELIVERY_RETRY.claimTimeout}'`);
        const until = Date.now() + SWEEP_BUDGET_MS;
        await this.send(null, until);
        await this.removeDue(null, until);
      });
    } finally { this.sweeping = false; }
  }

  /**
   * Deletes delivered messages of taken-back announcements, claimed a few at a time: one announcement's (just taken back) or,
   * from the timer, any waiting or worth trying again. Returns whether nothing is left to do.
   */
  private async removeDue(announcementId: string | null, until: number) {
    if (!this.telegram.enabled) return true;
    while (Date.now() < until) {
      const rows: Delivered[] = await this.db.query(`WITH due AS (SELECT d.id FROM team_announcement_deliveries d
          WHERE d.status = 'SENT' AND d."failureCode" = ANY($1) AND d."sentAt" > now() - make_interval(hours => $2) AND ($3::uuid IS NULL OR d."announcementId" = $3)
            AND (d."claimedAt" IS NULL OR d."claimedAt" < now() - interval '${DELETE_RETRY_AFTER}')
          ORDER BY d."sentAt" LIMIT ${CLAIM} FOR UPDATE SKIP LOCKED)
        UPDATE team_announcement_deliveries d SET "claimedAt" = now() FROM due, telegram_groups g WHERE d.id = due.id AND g.id = d."groupId"
        RETURNING d.id, d."messageId", g."chatId"`, [DELETE_AGAIN, TAKE_BACK_HOURS, announcementId]).then(([result]: [Delivered[]]) => result);
      if (!rows.length) return true;
      for (const delivery of rows) await this.remove(delivery);
    }
    return false;
  }

  /** Deletes one delivered message; a failure stays on the delivery as DELETE_<code>, so the page can say which group still has it. */
  private async remove(delivery: Delivered) {
    try {
      if (!delivery.messageId) throw new TelegramError('NO_MESSAGE');
      await this.telegram.deleteMessage(delivery.chatId, delivery.messageId);
      await this.db.query(`UPDATE team_announcement_deliveries SET status = 'TAKEN_BACK', "takenBackAt" = now(), "failureCode" = NULL WHERE id = $1 AND status = 'SENT'`, [delivery.id]);
    } catch (error) {
      const code = error instanceof TelegramError ? error.code : 'FAILED';
      this.logger.warn(`Team announcement take-back failed: ${code}`);
      // Only while still SENT: a delete that already worked is never marked as stuck. A passing failure is tried again later.
      await this.db.query(`UPDATE team_announcement_deliveries SET "failureCode" = $2 WHERE id = $1 AND status = 'SENT'`, [delivery.id, `DELETE_${code}`.slice(0, 32)])
        .catch(() => this.logger.warn('Team announcement take-back: the result wasn’t saved'));
    }
  }

  /**
   * Sends waiting deliveries a few at a time until `until`: one announcement's not tried yet (just created) or, from the
   * timer, any that waited a minute, so a failed one waits before its next try. Returns whether nothing is left to do.
   */
  private async send(announcementId: string | null, until: number) {
    if (!this.telegram.enabled) return true;
    while (Date.now() < until) {
      const [rows]: [Claimed[], number] = await this.db.query(`WITH due AS (SELECT id FROM team_announcement_deliveries
          WHERE status = 'PENDING' AND (($2::uuid IS NOT NULL AND "announcementId" = $2 AND attempts = 0) OR ($2::uuid IS NULL AND COALESCE("claimedAt", "createdAt") < now() - interval '1 minute'))
          ORDER BY "createdAt" LIMIT ${CLAIM} FOR UPDATE SKIP LOCKED)
        UPDATE team_announcement_deliveries d SET status = CASE WHEN d.attempts >= $1 THEN 'FAILED' ELSE 'SENDING' END, "failureCode" = CASE WHEN d.attempts >= $1 THEN 'MAX_ATTEMPTS' ELSE d."failureCode" END,
          attempts = CASE WHEN d.attempts >= $1 THEN d.attempts ELSE d.attempts + 1 END, "claimedAt" = now()
        FROM due WHERE d.id = due.id RETURNING d.id, d."announcementId", d."teamId", d."groupId", d.attempts, d.status`, [DELIVERY_RETRY.maxAttempts, announcementId]);
      if (!rows.length) return true;
      // One delivery's failure never holds up the others; a claim left unfinished is marked UNCONFIRMED by the timer.
      for (const row of rows.filter(item => item.status === 'SENDING')) await this.deliver(row).catch(() => this.logger.warn('Team announcement: a delivery failed'));
    }
    return false;
  }
  private async deliver(row: Claimed) {
    const finish = (status: string, failureCode: string | null, messageId: string | null = null) => this.db.query(`UPDATE team_announcement_deliveries SET status = $2::varchar, "failureCode" = $3, "messageId" = $4,
      "sentAt" = CASE WHEN $2::varchar = 'SENT' THEN now() ELSE NULL END WHERE id = $1 AND status = 'SENDING' AND attempts = $5`, [row.id, status, failureCode, messageId, row.attempts]);
    const [item]: { text: string; authorName: string; authorRole: string; takenBackAt: Date | null }[] = await this.db.query(`SELECT text, "authorName", "authorRole", "takenBackAt" FROM team_announcements WHERE id = $1`, [row.announcementId]);
    if (!item || item.takenBackAt) return finish('SKIPPED', 'TAKEN_BACK');
    const group = await this.group(row);
    if (!group) return finish('FAILED', 'UNLINKED');
    if (group.lostAt) return finish('FAILED', 'FORBIDDEN');
    let messageId: string | null;
    try {
      const message = await this.telegram.sendMessage(group.chatId, `Announcement from ${item.authorName}, ${item.authorRole}\n\n${item.text}`);
      messageId = message?.message_id === undefined ? null : String(message.message_id);
    } catch (error) {
      const code = error instanceof TelegramError ? error.code : 'FAILED';
      this.logger.warn(`Team announcement failed: ${code}`);
      if (code === 'FORBIDDEN') await this.db.query(`UPDATE telegram_groups SET "lostAt" = now() WHERE id = $1 AND "lostAt" IS NULL`, [group.id]);
      // A timeout may have been posted anyway, and its copy couldn't be taken back: never sent again.
      if (code === 'TIMEOUT') return finish('FAILED', 'UNCONFIRMED');
      return finish(TELEGRAM_FINAL.has(code) || row.attempts >= DELIVERY_RETRY.maxAttempts ? 'FAILED' : 'PENDING', code.slice(0, 32));
    }
    // It's in the group now: nothing below may send it again. A failed write is tried once more, then left for the timer (UNCONFIRMED).
    await finish('SENT', null, messageId).catch(() => finish('SENT', null, messageId));
    await this.db.query(`UPDATE telegram_groups SET "lastMessageAt" = now() WHERE id = $1`, [group.id]).catch(() => undefined);
    // Taken back while it was on its way. FOR SHARE waits for a take-back still in its transaction, which may have marked SENT
    // rows before this one was; this marks it unless the take-back did, and the claim in removeDue lets only one of them delete it.
    const [now]: { takenBackAt: Date | null }[] = await this.db.query(`SELECT "takenBackAt" FROM team_announcements WHERE id = $1 FOR SHARE`, [row.announcementId]);
    if (!now?.takenBackAt) return;
    await this.db.query(`UPDATE team_announcement_deliveries SET "failureCode" = 'DELETE_PENDING', "claimedAt" = NULL WHERE id = $1 AND status = 'SENT' AND "failureCode" IS NULL`, [row.id]);
    await this.removeDue(row.announcementId, Date.now() + REQUEST_BUDGET_MS);
  }
  /**
   * The group a delivery goes to: the one chosen when it was written, or, once that one was replaced, the team's group now,
   * so a delivery waiting to retry reaches the group the team uses. Null when the team has no group any more.
   */
  private async group(row: Claimed) {
    const [chosen]: { id: string; chatId: string; unlinkedAt: Date | null; lostAt: Date | null }[] = await this.db.query(`SELECT id, "chatId", "unlinkedAt", "lostAt" FROM telegram_groups WHERE id = $1`, [row.groupId]);
    if (chosen && !chosen.unlinkedAt) return chosen;
    const [current]: { id: string; chatId: string; lostAt: Date | null }[] = await this.db.query(`SELECT id, "chatId", "lostAt" FROM telegram_groups WHERE "teamId" = $1 AND "unlinkedAt" IS NULL`, [row.teamId]);
    if (!current) return null;
    await this.db.query(`UPDATE team_announcement_deliveries SET "groupId" = $2 WHERE id = $1 AND status = 'SENDING'`, [row.id, current.id]);
    return current;
  }
}
