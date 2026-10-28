import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull, MoreThan } from 'typeorm';
import { webOrigins } from '../../config/environment';
import { EmailService } from '../email/email.service';
import { ApplicationActivity, ApplicationReview, DispatcherApplication, Invitation } from '../onboarding/entities';
import { onboardingLimit } from '../onboarding/rate-limit';
import { DECISION_STATUSES, type DecisionStatus, statusMessage } from './status-messages';
import { TelegramClient, TelegramError } from './telegram.client';
import { ApplicantUpdateDelivery, ApplicantUpdateSettings, TelegramLinkToken, TelegramPollState, type UpdateChannel } from './updates.entity';

const LINK_TTL_MS = 30 * 60000;
// Serializes Telegram polling across API instances so each update is handled once.
const POLL_LOCK = 42002031;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class UpdatesService {
 private readonly logger = new Logger('ApplicantUpdates');
 constructor(private readonly db: DataSource, private readonly email: EmailService, private readonly telegram: TelegramClient, private readonly config: ConfigService) {}

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
  const settings = await this.settingsFor(em, application.id);
  settings.email = input.email; settings.telegram = input.telegram;
  await em.save(settings);
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
  const settings = await this.settingsFor(em, application.id);
  settings.telegramChatId = null; settings.telegramUsername = null; settings.telegramLinkedAt = null;
  settings.telegram = false; settings.email = true;
  await em.save(settings);
  await em.getRepository(ApplicationActivity).save({ invitationId: invitation.id, actorId: null, event: 'TELEGRAM_DISCONNECTED' });
  return this.view(em, application.id);
 }
 private async poll() {
  const runner = this.db.createQueryRunner();
  await runner.connect();
  try {
   const [{ locked }] = await runner.query('SELECT pg_try_advisory_lock($1) AS locked', [POLL_LOCK]);
   if (!locked) return; // Another request is reading updates right now.
   try {
    const state = await runner.manager.findOneBy(TelegramPollState, { id: 1 });
    const updates = await this.telegram.getUpdates(Number(state?.updateOffset ?? 0));
    for (const update of updates) {
     await this.handle(update.message);
     await runner.manager.save(TelegramPollState, { id: 1, updateOffset: String(update.update_id + 1) });
    }
   } finally { await runner.query('SELECT pg_advisory_unlock($1)', [POLL_LOCK]); }
  } catch (error) {
   this.logger.warn(`Telegram update check failed: ${error instanceof TelegramError ? error.code : 'FAILED'}`);
   throw new ServiceUnavailableException('Telegram could not be reached. Try again in a minute.');
  } finally { await runner.release(); }
 }
 private async handle(message: { text?: string; chat: { id: number; type: string }; from?: { username?: string } } | undefined) {
  if (!message || message.chat.type !== 'private') return;
  const text = (message.text ?? '').trim(), chatId = String(message.chat.id);
  if (text === '/stop') {
   await this.db.getRepository(ApplicantUpdateSettings).update({ telegramChatId: chatId }, { telegramChatId: null, telegramUsername: null, telegramLinkedAt: null, telegram: false, email: true });
   return this.reply(chatId, 'You will no longer get UGEM application updates here.');
  }
  const token = /^\/start ([A-Za-z0-9_-]{43})$/.exec(text)?.[1];
  if (!token) return this.reply(chatId, 'This bot sends updates about UGEM dispatcher applications. Use the Connect Telegram button on your application page to start.');
  const linked = await this.db.transaction(async em => {
   const link = await em.getRepository(TelegramLinkToken).findOne({ where: { tokenHash: hash(token), consumedAt: IsNull(), expiresAt: MoreThan(new Date()) }, lock: { mode: 'pessimistic_write' } });
   if (!link) return false;
   link.consumedAt = new Date(); await em.save(link);
   const settings = await this.settingsFor(em, link.applicationId);
   const username = message.from?.username && /^[A-Za-z0-9_]{5,32}$/.test(message.from.username) ? message.from.username : null;
   Object.assign(settings, { telegram: true, telegramChatId: chatId, telegramUsername: username, telegramLinkedAt: new Date() });
   await em.save(settings);
   const application = await em.getRepository(DispatcherApplication).findOneByOrFail({ id: link.applicationId });
   await em.getRepository(ApplicationActivity).save({ invitationId: application.invitationId, actorId: null, event: 'TELEGRAM_CONNECTED' });
   return true;
  });
  await this.reply(chatId, linked ? 'Connected. You will get updates about your UGEM application here. Send /stop to turn them off.'
   : 'This connect link has expired or was already used. Open your application page and press Connect Telegram again.');
 }
 private async reply(chatId: string, text: string) {
  // A failed courtesy reply must not stop the remaining updates from being processed.
  await this.telegram.sendMessage(chatId, text).catch(() => undefined);
 }

 /** Called inside the decision transaction: records which channels to notify, so a committed decision is never lost. */
 async queue(em: EntityManager, application: DispatcherApplication, review: ApplicationReview) {
  if (!DECISION_STATUSES.includes(review.newStatus)) return;
  const settings = await this.settingsFor(em, application.id);
  const channels: [UpdateChannel, boolean, string | null][] = [
   ['EMAIL', settings.email, this.email.enabled ? null : 'DISABLED'],
   ['TELEGRAM', settings.telegram, !this.telegram.enabled ? 'DISABLED' : settings.telegramChatId ? null : 'NOT_CONNECTED'],
  ];
  for (const [channel, chosen, skipped] of channels) if (chosen) await em.getRepository(ApplicantUpdateDelivery).save({ applicationId: application.id, reviewId: review.id, channel,
   status: skipped ? 'SKIPPED' : 'PENDING', failureCode: skipped, sentAt: null });
 }
 /** After the decision commits: sends the queued messages in the background. Never throws into the request. */
 dispatch(reviewId: string) {
  this.email.runInBackground(async () => {
   const deliveries = await this.db.getRepository(ApplicantUpdateDelivery).findBy({ reviewId, status: 'PENDING' });
   if (!deliveries.length) return;
   const review = await this.db.getRepository(ApplicationReview).findOneByOrFail({ id: reviewId });
   const application = await this.db.getRepository(DispatcherApplication).findOneByOrFail({ id: review.applicationId });
   const invitation = await this.db.getRepository(Invitation).findOneByOrFail({ id: application.invitationId });
   const settings = await this.settingsFor(this.db.manager, application.id);
   const content = statusMessage(review.newStatus as DecisionStatus, application.id, `${webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0]}/apply/resume`, application.applicantAccessUntil);
   for (const delivery of deliveries) {
    let result: true | string;
    if (delivery.channel === 'EMAIL') result = invitation.email ? await this.email.sendStatusUpdate(invitation.email, content) : 'NO_ADDRESS';
    else if (!settings.telegramChatId) result = 'NOT_CONNECTED';
    else result = await this.telegram.sendMessage(settings.telegramChatId, content.telegram).then(() => true as const, (error: unknown) => error instanceof TelegramError ? error.code : 'FAILED');
    if (result !== true) this.logger.warn(`${delivery.channel === 'EMAIL' ? 'Email' : 'Telegram'} status update failed: ${result}`);
    await this.db.getRepository(ApplicantUpdateDelivery).update({ id: delivery.id, status: 'PENDING' },
     result === true ? { status: 'SENT', sentAt: new Date() } : { status: 'FAILED', failureCode: result.slice(0, 32) });
   }
  });
 }
}
