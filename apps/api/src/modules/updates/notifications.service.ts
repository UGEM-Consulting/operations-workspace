import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { webOrigins } from '../../config/environment';
import { EmailService } from '../email/email.service';
import { DispatcherApplication, Invitation } from '../onboarding/entities';
import { onboardingLimit } from '../onboarding/rate-limit';
import { Role, User, UserStatus } from '../users/user.entity';
import { setupCompleteMessage, staffAlertMessage } from './notification-messages';
import { TelegramClient, TelegramError } from './telegram.client';
import { ApplicantUpdateSettings, NotificationDelivery, type NotificationKind, StaffTelegramLink, StaffTelegramLinkToken, type UpdateChannel } from './updates.entity';
import { DELIVERY_RETRY, UpdatesService } from './updates.service';

const LINK_TTL_MS = 30 * 60000;
const PERMANENT_FAILURES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE', 'FORBIDDEN', 'REJECTED', 'NO_ADDRESS', 'NOT_CONNECTED', 'DISABLED', 'INACTIVE']);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type Claimed = Pick<NotificationDelivery, 'id' | 'kind' | 'applicationId' | 'recipientId' | 'referenceId' | 'channel' | 'status' | 'attempts'>;
type Row = Pick<NotificationDelivery, 'kind' | 'applicationId' | 'recipientId' | 'referenceId' | 'channel' | 'status' | 'failureCode'>;

/**
 * Notifications beyond applicant decisions: "setup complete" for the new hire (their chosen channels) and Telegram alerts
 * for staff (review waiting for the assigned manager, a new IT checklist for each IT specialist). Same outbox rules as
 * decision updates: queued in the causing transaction, sent after commit, swept and retried; no text or addresses stored.
 */
@Injectable()
export class NotificationsService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Notifications');
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  constructor(private readonly db: DataSource, private readonly email: EmailService, private readonly telegram: TelegramClient,
    private readonly updates: UpdatesService, private readonly config: ConfigService) {}
  onApplicationBootstrap() {
    if (this.timer) clearInterval(this.timer);
    this.sweep();
    this.timer = setInterval(() => this.sweep(), DELIVERY_RETRY.sweepMs);
    this.timer.unref();
  }
  beforeApplicationShutdown() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private origin() { return webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0]; }

  /** In the IT completion transaction: the new hire's chosen channels (email by default). */
  async queueSetupComplete(em: EntityManager, request: { id: string; applicationId: string }) {
    const settings = await em.getRepository(ApplicantUpdateSettings).findOneBy({ applicationId: request.applicationId });
    const wantsEmail = settings?.email ?? true, wantsTelegram = settings?.telegram ?? false;
    const telegramSkipped = !this.telegram.enabled ? 'DISABLED' : settings?.telegramChatId ? null : 'NOT_CONNECTED';
    const rows: Row[] = [];
    // As for decisions: an unusable Telegram-only choice falls back to email so the message still arrives.
    if (wantsEmail || (wantsTelegram && telegramSkipped)) rows.push(this.row('SETUP_COMPLETE', { applicationId: request.applicationId }, request.id, 'EMAIL', this.email.enabled ? null : 'DISABLED'));
    if (wantsTelegram) rows.push(this.row('SETUP_COMPLETE', { applicationId: request.applicationId }, request.id, 'TELEGRAM', telegramSkipped));
    return this.insert(em, rows);
  }
  /** In the submission transaction: the application's assigned manager. */
  async queueReviewWaiting(em: EntityManager, application: Pick<DispatcherApplication, 'id' | 'assignedManagerId'>) {
    if (!application.assignedManagerId) return [];
    return this.insert(em, await this.staffRows(em, 'REVIEW_WAITING', [application.assignedManagerId], application.id));
  }
  /** In the approval transaction: every active IT specialist. */
  async queueItSetupWaiting(em: EntityManager, request: { id: string }) {
    const specialists = await em.getRepository(User).findBy({ role: Role.IT_SPECIALIST, status: UserStatus.ACTIVE });
    return this.insert(em, await this.staffRows(em, 'IT_SETUP_WAITING', specialists.map(user => user.id), request.id));
  }
  /** After the causing transaction commits. Never throws into the request. */
  dispatch(ids: string[]) { if (ids.length) this.email.runInBackground(() => this.deliver(ids)); }
  sweep() {
    if (this.sweeping || (!this.email.enabled && !this.telegram.enabled)) return;
    this.sweeping = true;
    this.email.runInBackground(() => this.deliver(null).finally(() => { this.sweeping = false; }));
  }

  // Staff Telegram connection (Account security): the same bot and polling as applicant updates.
  async telegramView(user: User) {
    const link = await this.db.getRepository(StaffTelegramLink).findOneBy({ userId: user.id });
    return { available: this.telegram.enabled, connected: !!link, username: link?.username ?? null, alerts: alertsFor(user.role) };
  }
  async telegramConnectLink(user: User) {
    if (!this.telegram.enabled) throw new BadRequestException('Telegram alerts are not available yet.');
    await onboardingLimit(this.db, 'staff-telegram-link:' + user.id, 10, 3600);
    const token = randomBytes(32).toString('base64url');
    await this.db.getRepository(StaffTelegramLinkToken).save({ userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + LINK_TTL_MS), consumedAt: null });
    return { url: `https://t.me/${this.telegram.botUsername}?start=${token}`, expiresAt: new Date(Date.now() + LINK_TTL_MS) };
  }
  async telegramCheck(user: User) {
    if (!this.telegram.enabled) throw new BadRequestException('Telegram alerts are not available yet.');
    await onboardingLimit(this.db, 'staff-telegram-check:' + user.id, 30, 600);
    await this.updates.pollTelegram();
    return this.telegramView(user);
  }
  async telegramDisconnect(user: User) {
    await this.db.getRepository(StaffTelegramLink).delete({ userId: user.id });
    return this.telegramView(user);
  }

  private row(kind: NotificationKind, recipient: { applicationId?: string; recipientId?: string }, referenceId: string, channel: UpdateChannel, skipped: string | null): Row {
    return { kind, applicationId: recipient.applicationId ?? null, recipientId: recipient.recipientId ?? null, referenceId, channel, status: skipped ? 'SKIPPED' : 'PENDING', failureCode: skipped };
  }
  /** Staff alerts are Telegram only; someone who has not connected Telegram gets a SKIPPED record instead. */
  private async staffRows(em: EntityManager, kind: 'REVIEW_WAITING' | 'IT_SETUP_WAITING', userIds: string[], referenceId: string) {
    if (!userIds.length) return [];
    const linked = new Set((await em.getRepository(StaffTelegramLink).createQueryBuilder('link').where('link.userId IN (:...ids)', { ids: userIds }).getMany()).map(link => link.userId));
    return userIds.map(id => this.row(kind, { recipientId: id }, referenceId, 'TELEGRAM', !this.telegram.enabled ? 'DISABLED' : linked.has(id) ? null : 'NOT_CONNECTED'));
  }
  private async insert(em: EntityManager, rows: Row[]) {
    if (!rows.length) return [];
    const saved = await em.getRepository(NotificationDelivery).save(rows.map(row => ({ ...row, sentAt: null })));
    return saved.filter(row => row.status === 'PENDING').map(row => row.id);
  }
  /** Claims rows atomically (FOR UPDATE SKIP LOCKED); see UpdatesService.claim for the same rules on decision updates. */
  private async claim(ids: string[] | null): Promise<Claimed[]> {
    const due = ids ? `id = ANY($2::uuid[]) AND status = 'PENDING'`
      : `(status = 'PENDING' AND COALESCE("claimedAt","createdAt") < now() - interval '${DELIVERY_RETRY.pendingAfter}') OR (status = 'SENDING' AND "claimedAt" < now() - interval '${DELIVERY_RETRY.claimTimeout}')`;
    const [rows]: [Claimed[], number] = await this.db.query(`WITH due AS (SELECT id FROM notification_deliveries WHERE ${due} ORDER BY "createdAt" LIMIT ${DELIVERY_RETRY.batch} FOR UPDATE SKIP LOCKED)
      UPDATE notification_deliveries d SET status = CASE WHEN d.attempts >= $1 THEN 'FAILED' ELSE 'SENDING' END,
       "failureCode" = CASE WHEN d.attempts >= $1 THEN 'MAX_ATTEMPTS' ELSE d."failureCode" END,
       attempts = CASE WHEN d.attempts >= $1 THEN d.attempts ELSE d.attempts + 1 END, "claimedAt" = now()
      FROM due WHERE d.id = due.id RETURNING d.id, d.kind, d."applicationId", d."recipientId", d."referenceId", d.channel, d.status, d.attempts`,
      ids ? [DELIVERY_RETRY.maxAttempts, ids] : [DELIVERY_RETRY.maxAttempts]);
    for (const row of rows) if (row.status === 'FAILED') this.logger.warn(`${row.kind} ${row.channel} notification failed: MAX_ATTEMPTS`);
    return rows.filter(row => row.status === 'SENDING');
  }
  private async deliver(ids: string[] | null) {
    for (const delivery of await this.claim(ids)) {
      const result = await this.send(delivery).catch(() => 'FAILED');
      if (result !== true) this.logger.warn(`${delivery.kind} ${delivery.channel} notification failed: ${result}`);
      const final = result === true || PERMANENT_FAILURES.has(result) || delivery.attempts >= DELIVERY_RETRY.maxAttempts;
      // Only this claim may finish the row.
      await this.db.getRepository(NotificationDelivery).update({ id: delivery.id, status: 'SENDING', attempts: delivery.attempts },
        result === true ? { status: 'SENT', sentAt: new Date(), failureCode: null } : { status: final ? 'FAILED' : 'PENDING', failureCode: result.slice(0, 32) });
    }
  }
  /** Resolves the recipient at send time (current email, connected chat, active account) and sends one message. */
  private async send(delivery: Claimed): Promise<true | string> {
    const telegram = (chatId: string, text: string) => this.telegram.sendMessage(chatId, text).then(() => true as const, (error: unknown) => error instanceof TelegramError ? error.code : 'FAILED');
    if (delivery.kind === 'SETUP_COMPLETE') {
      const content = setupCompleteMessage();
      if (delivery.channel === 'EMAIL') {
        const application = await this.db.getRepository(DispatcherApplication).findOneBy({ id: delivery.applicationId! });
        const invitation = application && await this.db.getRepository(Invitation).findOneBy({ id: application.invitationId });
        return invitation?.email ? this.email.sendStatusUpdate(invitation.email, content) : 'NO_ADDRESS';
      }
      const settings = await this.db.getRepository(ApplicantUpdateSettings).findOneBy({ applicationId: delivery.applicationId! });
      return settings?.telegramChatId ? telegram(settings.telegramChatId, content.telegram) : 'NOT_CONNECTED';
    }
    const user = await this.db.getRepository(User).findOneBy({ id: delivery.recipientId! });
    if (!user || user.status !== UserStatus.ACTIVE) return 'INACTIVE';
    const link = await this.db.getRepository(StaffTelegramLink).findOneBy({ userId: user.id });
    if (!link) return 'NOT_CONNECTED';
    const path = delivery.kind === 'REVIEW_WAITING' ? `/onboarding/applications/${delivery.referenceId}` : `/it/tasks/${delivery.referenceId}`;
    return telegram(link.chatId, staffAlertMessage(delivery.kind, `${this.origin()}${path}`));
  }
}
/** Which alerts a role receives, for the Account security description. */
function alertsFor(role: Role): string[] {
  return [...(role === Role.DISPATCHER_MANAGER || role === Role.SYSTEM_ADMIN ? ['REVIEW_WAITING'] : []), ...(role === Role.IT_SPECIALIST ? ['IT_SETUP_WAITING'] : [])];
}
