import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull, MoreThan } from 'typeorm';
import { webOrigins } from '../../config/environment';
import { EmailService } from '../email/email.service';
import { ApplicationActivity, ApplicationReview, DispatcherApplication, Invitation } from '../onboarding/entities';
import { onboardingLimit } from '../onboarding/rate-limit';
import { DECISION_STATUSES, type DecisionStatus, statusMessage } from './status-messages';
import { TelegramClient, TelegramError, type TelegramUpdate } from './telegram.client';
import { ApplicantUpdateDelivery, ApplicantUpdateSettings, TelegramLinkToken, TelegramPollState, type UpdateChannel } from './updates.entity';

const LINK_TTL_MS = 30 * 60000;
// Serializes Telegram polling across API instances so each update is handled once.
const POLL_LOCK = 42002031;
// Updates handled per check; the rest wait for the next check, so the lock and connection are held briefly.
export const POLL_BATCH = 20;
// Outbox recovery: rows still PENDING ten minutes after their decision (or after a failed attempt), longer than an
// unclaimed send by an older API version can take during an overlapping deploy, and SENDING claims
// older than ten minutes (a sender that died) are claimed again, up to five attempts in total.
export const DELIVERY_RETRY = { sweepMs: 120000, pendingAfter: '10 minutes', claimTimeout: '10 minutes', maxAttempts: 5, batch: 50 } as const;
// Failures a later attempt cannot fix: credentials, address or content, blocked bot, nothing to send to.
const PERMANENT_FAILURES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE', 'FORBIDDEN', 'REJECTED', 'NO_ADDRESS', 'NOT_CONNECTED', 'DISABLED']);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type Claimed = Pick<ApplicantUpdateDelivery, 'id' | 'reviewId' | 'channel' | 'status' | 'attempts'>;

@Injectable()
export class UpdatesService implements OnApplicationBootstrap, BeforeApplicationShutdown {
 private readonly logger = new Logger('ApplicantUpdates');
 private timer: NodeJS.Timeout | null = null;
 private sweeping = false;
 constructor(private readonly db: DataSource, private readonly email: EmailService, private readonly telegram: TelegramClient, private readonly config: ConfigService) {}
 onApplicationBootstrap() {
  if (this.timer) clearInterval(this.timer);
  this.sweep();
  this.timer = setInterval(() => this.sweep(), DELIVERY_RETRY.sweepMs);
  this.timer.unref();
 }
 beforeApplicationShutdown() {
  // Stop claiming new work; deliveries already in flight are drained by EmailService on shutdown.
  if (this.timer) clearInterval(this.timer);
  this.timer = null;
 }

 private async settingsFor(em: EntityManager, applicationId: string) {
  return await em.getRepository(ApplicantUpdateSettings).findOneBy({ applicationId })
   ?? em.getRepository(ApplicantUpdateSettings).create({ applicationId, email: true, telegram: false, telegramChatId: null, telegramUsername: null, telegramLinkedAt: null });
 }
 /** Applicant projection: choices and connection state only, never the chat id. */
 async view(em: EntityManager, applicationId: string) {
  const settings = await this.settingsFor(em, applicationId);
  return { email: settings.email, telegram: settings.telegram, emailAvailable: this.email.enabled, telegramAvailable: this.telegram.enabled,
   telegramConnected: !!settings.telegramChatId, telegramUsername: settings.telegramUsername };
 }
 async save(em: EntityManager, application: DispatcherApplication, invitation: Invitation, input: { email: boolean; telegram: boolean }) {
  if (!input.email && !input.telegram) throw new BadRequestException('Choose at least one way to receive updates.');
  if (input.telegram && !this.telegram.enabled) throw new BadRequestException('Telegram updates are not available yet.');
  // An upsert, because a Telegram connection may be creating this row at the same moment.
  const [settings]: { telegramChatId: string | null }[] = await em.query(`INSERT INTO applicant_update_settings ("applicationId",email,telegram) VALUES ($1,$2,$3)
   ON CONFLICT ("applicationId") DO UPDATE SET email=EXCLUDED.email, telegram=EXCLUDED.telegram, "updatedAt"=now() RETURNING "telegramChatId"`, [application.id, input.email, input.telegram]);
  // Telegram only is allowed once a chat is connected; otherwise decisions would reach nobody. Rolls back the upsert.
  if (!input.email && !settings.telegramChatId) throw new BadRequestException('Connect Telegram before turning off email updates.');
  await em.getRepository(ApplicationActivity).save({ invitationId: invitation.id, actorId: null, event: 'UPDATE_PREFERENCES_CHANGED' });
  return this.view(em, application.id);
 }
 /** A one-time https://t.me/<bot>?start=<token> link; the raw token is returned once and only its hash is stored. */
 async connectLink(em: EntityManager, application: DispatcherApplication) {
  if (!this.telegram.enabled) throw new BadRequestException('Telegram updates are not available yet.');
  await onboardingLimit(this.db, 'telegram-link:' + application.id, 10, 3600);
  const token = randomBytes(32).toString('base64url');
  await em.getRepository(TelegramLinkToken).save({ applicationId: application.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + LINK_TTL_MS), consumedAt: null });
  return { url: `https://t.me/${this.telegram.botUsername}?start=${token}`, expiresAt: new Date(Date.now() + LINK_TTL_MS) };
 }
 /** Reads new Start messages from the bot (on demand, instead of a public webhook), then returns this applicant's view. */
 async checkConnection(application: DispatcherApplication) {
  if (!this.telegram.enabled) throw new BadRequestException('Telegram updates are not available yet.');
  await onboardingLimit(this.db, 'telegram-check:' + application.id, 30, 600);
  await this.poll();
  return this.view(this.db.manager, application.id);
 }
 async disconnect(em: EntityManager, application: DispatcherApplication, invitation: Invitation) {
  await em.query(`INSERT INTO applicant_update_settings ("applicationId",email,telegram) VALUES ($1,true,false)
   ON CONFLICT ("applicationId") DO UPDATE SET email=true, telegram=false, "telegramChatId"=NULL, "telegramUsername"=NULL, "telegramLinkedAt"=NULL, "updatedAt"=now()`, [application.id]);
  await em.getRepository(ApplicationActivity).save({ invitationId: invitation.id, actorId: null, event: 'TELEGRAM_DISCONNECTED' });
  return this.view(em, application.id);
 }
 private async poll() {
  const runner = this.db.createQueryRunner(), replies: [string, string][] = [];
  let failure: string | null = null;
  try {
   await runner.connect();
   const [{ locked }] = await runner.query('SELECT pg_try_advisory_lock($1) AS locked', [POLL_LOCK]);
   if (!locked) return; // Another request is reading updates right now.
   try {
    const state = await runner.manager.findOneBy(TelegramPollState, { id: 1 });
    const updates = await this.telegram.getUpdates(Number(state?.updateOffset ?? 0), POLL_BATCH);
    for (const update of updates) {
     // Each update commits with the offset past it, so a failure re-reads only unprocessed updates
     // and a connect link is never consumed by an update that is read again.
     const reply = await runner.manager.transaction(async em => {
      const result = await this.handle(em, update.message);
      await em.update(TelegramPollState, { id: 1 }, { updateOffset: String(update.update_id + 1) });
      return result;
     });
     if (reply) replies.push(reply);
    }
   } finally { await runner.query('SELECT pg_advisory_unlock($1)', [POLL_LOCK]); }
  } catch (error) {
   failure = error instanceof TelegramError ? error.code : 'FAILED';
  } finally { await runner.release(); }
  // Courtesy replies go out after the lock and connection are released. A failed reply changes nothing.
  for (const [chatId, text] of replies) await this.telegram.sendMessage(chatId, text).catch(() => undefined);
  if (failure) {
   this.logger.warn(`Telegram update check failed: ${failure}`);
   throw new ServiceUnavailableException('Telegram could not be reached. Try again in a minute.');
  }
 }
 /** Applies one bot message inside the caller's transaction and returns the reply to send afterwards, if any. */
 private async handle(em: EntityManager, message: TelegramUpdate['message']): Promise<[string, string] | null> {
  if (!message || message.chat.type !== 'private') return null;
  const text = (message.text ?? '').trim(), chatId = String(message.chat.id);
  if (text === '/stop') {
   await em.getRepository(ApplicantUpdateSettings).update({ telegramChatId: chatId }, { telegramChatId: null, telegramUsername: null, telegramLinkedAt: null, telegram: false, email: true });
   return [chatId, 'You will no longer get UGEM application updates here.'];
  }
  const token = /^\/start ([A-Za-z0-9_-]{43})$/.exec(text)?.[1];
  if (!token) return [chatId, 'This bot sends updates about UGEM dispatcher applications. Use the Connect Telegram button on your application page to start.'];
  const link = await em.getRepository(TelegramLinkToken).findOne({ where: { tokenHash: hash(token), consumedAt: IsNull(), expiresAt: MoreThan(new Date()) }, lock: { mode: 'pessimistic_write' } });
  if (!link) return [chatId, 'This connect link has expired or was already used. Open your application page and press Connect Telegram again.'];
  link.consumedAt = new Date(); await em.save(link);
  const username = message.from?.username && /^[A-Za-z0-9_]{5,32}$/.test(message.from.username) ? message.from.username : null;
  // An upsert, because the applicant may be saving preferences at the same moment.
  await em.query(`INSERT INTO applicant_update_settings ("applicationId",email,telegram,"telegramChatId","telegramUsername","telegramLinkedAt") VALUES ($1,true,true,$2,$3,now())
   ON CONFLICT ("applicationId") DO UPDATE SET telegram=true, "telegramChatId"=EXCLUDED."telegramChatId", "telegramUsername"=EXCLUDED."telegramUsername", "telegramLinkedAt"=now(), "updatedAt"=now()`,
   [link.applicationId, chatId, username]);
  const application = await em.getRepository(DispatcherApplication).findOneByOrFail({ id: link.applicationId });
  await em.getRepository(ApplicationActivity).save({ invitationId: application.invitationId, actorId: null, event: 'TELEGRAM_CONNECTED' });
  return [chatId, 'Connected. You will get updates about your UGEM application here. Send /stop to turn them off.'];
 }

 /** Called inside the decision transaction: records which channels to notify, so a committed decision is never lost. */
 async queue(em: EntityManager, application: DispatcherApplication, review: ApplicationReview) {
  if (!DECISION_STATUSES.includes(review.newStatus)) return;
  const settings = await this.settingsFor(em, application.id);
  const telegramSkipped = !this.telegram.enabled ? 'DISABLED' : settings.telegramChatId ? null : 'NOT_CONNECTED';
  // Telegram chosen but unusable and email off (older records): fall back to email so the decision still arrives.
  const channels: [UpdateChannel, boolean, string | null][] = [
   ['EMAIL', settings.email || (settings.telegram && telegramSkipped !== null), this.email.enabled ? null : 'DISABLED'],
   ['TELEGRAM', settings.telegram, telegramSkipped],
  ];
  for (const [channel, chosen, skipped] of channels) if (chosen) await em.getRepository(ApplicantUpdateDelivery).save({ applicationId: application.id, reviewId: review.id, channel,
   status: skipped ? 'SKIPPED' : 'PENDING', failureCode: skipped, sentAt: null });
 }
 /** After the decision commits: sends its queued messages in the background. Never throws into the request. */
 dispatch(reviewId: string) {
  this.email.runInBackground(() => this.deliver(reviewId));
 }
 /** Redelivers what a restart or failure left behind (see DELIVERY_RETRY). Runs at startup and on an interval. */
 sweep() {
  if (this.sweeping || (!this.email.enabled && !this.telegram.enabled)) return;
  this.sweeping = true;
  this.email.runInBackground(() => this.deliver(null).finally(() => { this.sweeping = false; }));
 }
 /**
  * Claims rows by moving them to SENDING in one statement (FOR UPDATE SKIP LOCKED), so concurrent dispatches, sweeps
  * and API instances never claim the same row. dispatch claims only its decision's fresh PENDING rows; the sweeper
  * claims stale ones and ends exhausted claims as FAILED.
  */
 private async claim(reviewId: string | null): Promise<Claimed[]> {
  const due = reviewId ? `"reviewId" = $2 AND status = 'PENDING'`
   : `(status = 'PENDING' AND COALESCE("claimedAt","createdAt") < now() - interval '${DELIVERY_RETRY.pendingAfter}') OR (status = 'SENDING' AND "claimedAt" < now() - interval '${DELIVERY_RETRY.claimTimeout}')`;
  const [rows]: [Claimed[], number] = await this.db.query(`WITH due AS (SELECT id FROM applicant_update_deliveries WHERE ${due} ORDER BY "createdAt" LIMIT ${DELIVERY_RETRY.batch} FOR UPDATE SKIP LOCKED)
   UPDATE applicant_update_deliveries d SET status = CASE WHEN d.attempts >= $1 THEN 'FAILED' ELSE 'SENDING' END,
    "failureCode" = CASE WHEN d.attempts >= $1 THEN 'MAX_ATTEMPTS' ELSE d."failureCode" END,
    attempts = CASE WHEN d.attempts >= $1 THEN d.attempts ELSE d.attempts + 1 END, "claimedAt" = now()
   FROM due WHERE d.id = due.id RETURNING d.id, d."reviewId", d.channel, d.status, d.attempts`, reviewId ? [DELIVERY_RETRY.maxAttempts, reviewId] : [DELIVERY_RETRY.maxAttempts]);
  for (const row of rows) if (row.status === 'FAILED') this.logger.warn(`${row.channel === 'EMAIL' ? 'Email' : 'Telegram'} status update failed: MAX_ATTEMPTS`);
  return rows.filter(row => row.status === 'SENDING');
 }
 private async deliver(reviewId: string | null) {
  const claimed = await this.claim(reviewId);
  for (const id of new Set(claimed.map(row => row.reviewId))) {
   const review = await this.db.getRepository(ApplicationReview).findOneByOrFail({ id });
   const application = await this.db.getRepository(DispatcherApplication).findOneByOrFail({ id: review.applicationId });
   const invitation = await this.db.getRepository(Invitation).findOneByOrFail({ id: application.invitationId });
   const settings = await this.settingsFor(this.db.manager, application.id);
   const content = statusMessage(review.newStatus as DecisionStatus, application.id, `${webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0]}/apply/resume`, application.applicantAccessUntil);
   for (const delivery of claimed.filter(row => row.reviewId === id)) {
    let result: true | string;
    if (delivery.channel === 'EMAIL') result = invitation.email ? await this.email.sendStatusUpdate(invitation.email, content) : 'NO_ADDRESS';
    else if (!settings.telegramChatId) result = 'NOT_CONNECTED';
    else result = await this.telegram.sendMessage(settings.telegramChatId, content.telegram).then(() => true as const, (error: unknown) => error instanceof TelegramError ? error.code : 'FAILED');
    if (result !== true) this.logger.warn(`${delivery.channel === 'EMAIL' ? 'Email' : 'Telegram'} status update failed: ${result}`);
    // Transient failures return to PENDING for the sweeper until the attempts run out. Only this claim may finish the row.
    const final = result === true || PERMANENT_FAILURES.has(result) || delivery.attempts >= DELIVERY_RETRY.maxAttempts;
    await this.db.getRepository(ApplicantUpdateDelivery).update({ id: delivery.id, status: 'SENDING', attempts: delivery.attempts },
     result === true ? { status: 'SENT', sentAt: new Date(), failureCode: null } : { status: final ? 'FAILED' : 'PENDING', failureCode: result.slice(0, 32) });
   }
  }
 }
}
