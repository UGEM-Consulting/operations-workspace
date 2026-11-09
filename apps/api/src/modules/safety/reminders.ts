import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, BeforeApplicationShutdown, ConflictException, ForbiddenException, Injectable, Logger, OnApplicationBootstrap, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { DataSource, EntityManager } from 'typeorm';
import { webOrigins } from '../../config/environment';
import { EmailService } from '../email/email.service';
import { onboardingLimit } from '../onboarding/rate-limit';
import { TelegramClient, TelegramError } from '../updates/telegram.client';
import { UpdatesService } from '../updates/updates.service';
import { Role, User, UserStatus } from '../users/user.entity';
import { AnnualReviewService } from './annual-review.service';
import { driverEvent, isProduction, lockOpenDriver, ownsDriver, SCREENERS, sessionLink, writeDriver } from './driver-records';
import { onHoldSql } from './holds';
import { createRenewalLink } from './renewal.service';
import { daysUntil, driverReminderMessage, staffReminderMessage, type StaffReminderLine, stepFor, weeklySummaryMessage } from './reminder-messages';
import { type Channel, renewalScanWaiting } from './reminded';
import { CLOSED_STATUSES, Driver, DriverTelegramLink, DriverTelegramLinkToken, LEAVABLE, RENEWAL_KINDS, type RenewalKind } from './safety.entity';
import { SafetyService } from './safety.service';
import { addDays, usDay } from './screening-rules';

/** The steps each audience is reminded at: days before the date, and 0 for the day itself (or after). */
export const STAFF_STEPS = [60, 30, 7, 0] as const;
export const DRIVER_STEPS = [30, 7, 0] as const;
// Reminders go out once a US Eastern day, from this hour; the run is serialized across API instances by this lock.
const SEND_HOUR = 8;
const RUN_LOCK = 42002038;
const FIRST_AFTER_MS = 60_000, EVERY_MS = 10 * 60_000;
// The same outbox rules as the other notifications: stale PENDING and SENDING rows are claimed again, up to five attempts.
const RETRY = { pendingAfter: '10 minutes', claimTimeout: '10 minutes', maxAttempts: 5, batch: 50 } as const;
const PERMANENT_FAILURES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE', 'FORBIDDEN', 'REJECTED', 'NO_ADDRESS', 'NOT_CONNECTED', 'DISABLED', 'INACTIVE']);
// Outcomes that mean there is nothing to send any more, recorded as SKIPPED: the document was renewed, its date was
// corrected, the driver sent a new scan that waits for its check, or the driver left (or, for staff, nothing is still due).
const NOTHING_TO_SEND = new Set(['RENEWED', 'CHANGED', 'WAITING', 'CLOSED']);
// Telegram failures after which the same message goes by email instead: the chat is gone or the bot was blocked.
const TELEGRAM_GONE = new Set(['NOT_CONNECTED', 'FORBIDDEN']);
const DRIVER_LINK_MS = 7 * 86400_000, OWN_LINK_MS = 30 * 60_000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

type Claimed = { id: string; reminderId: string | null; batchId: string | null; channel: Channel; status: string; attempts: number };
type Outcome = { result: true | string; channel: Channel };
type Message = { email: { subject: string; text: string; html: string }; telegram: string; button?: { text: string; url: string } };
interface Subject { subject: 'DOCUMENT' | 'OWNER_DOCUMENT' | 'ANNUAL_REVIEW'; subjectId: string; driverId: string; kind: string; dueOn: string;
 // Read with the subjects, so queueing needs no query per driver.
 email: string | null; telegram: boolean; waiting: boolean }

/**
 * Expiration reminders (designed as the Reminders and E-Verify group, approved 2026-11-09). Once a US Eastern day, from
 * 8 AM, the first API instance to get there records every step reached by approved and cleared drivers' checked
 * documents, owner-operator truck documents and yearly reviews: the Safety contact (or, with none, the Safety manager)
 * gets one message for all of theirs, by Telegram or else email; drivers get their license and medical card reminders with
 * a fresh renewal link (or a pointer to the one Safety sent); on Mondays the Safety manager gets a summary of counts. The
 * outbox holds no text or addresses, recipients are resolved at send time, and what changed in the meantime (a document
 * renewed or corrected, a scan sent) is not reminded about.
 */
@Injectable()
export class ReminderService implements OnApplicationBootstrap, BeforeApplicationShutdown {
 private readonly logger = new Logger('SafetyReminders');
 private timers: NodeJS.Timeout[] = [];
 private running = false;
 constructor(private readonly db: DataSource, private readonly config: ConfigService, private readonly email: EmailService, private readonly telegram: TelegramClient,
  private readonly updates: UpdatesService, private readonly safety: SafetyService, private readonly annual: AnnualReviewService) {}
 onApplicationBootstrap() {
  const first = setTimeout(() => void this.tick(), FIRST_AFTER_MS); first.unref();
  const every = setInterval(() => void this.tick(), EVERY_MS); every.unref();
  this.timers = [first, every];
 }
 beforeApplicationShutdown() { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }
 private origin() { return webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0]; }
 private get sending() { return this.email.enabled || this.telegram.enabled; }

 /** Never throws: the next tick tries again. A failed run never keeps the retries of earlier messages from going out. */
 async tick(now = new Date()) {
  if (this.running) return;
  this.running = true;
  let ids: string[] = [];
  try { ids = await this.run(now); } catch { this.logger.warn('Reminder run failed'); }
  try { await this.deliver(ids.length ? ids : null); } catch { this.logger.warn('Reminder delivery failed'); }
  finally { this.running = false; }
 }

 /**
  * Records today's reminders once, from SEND_HOUR Eastern, and returns the deliveries to send. A run that finds today
  * already done (another instance, or an earlier tick) records nothing.
  */
 async run(now = new Date()): Promise<string[]> {
  if (!this.sending) return [];
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now));
  if (hour < SEND_HOUR) return [];
  const today = usDay('latest', now);
  return this.db.transaction(async em => {
   const [{ locked }] = await em.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [RUN_LOCK]);
   if (!locked) return [];
   const [started]: { day: string }[] = await em.query(`INSERT INTO safety_reminder_runs (day) VALUES ($1) ON CONFLICT DO NOTHING RETURNING day`, [today]);
   if (!started) return [];
   const subjects = await this.subjects(em, today);
   const ids = [...await this.queueStaff(em, subjects, today), ...await this.queueDrivers(em, subjects, today)];
   if (new Date(`${today}T12:00:00Z`).getUTCDay() === 1) ids.push(...await this.queueWeekly(em, today));
   return ids;
  });
 }

 /**
  * Everything with a date for approved and cleared drivers, as far ahead as the first staff step, with what queueing
  * needs (the driver's email, whether they're on Telegram, whether a renewal scan waits) in the same query.
  */
 private async subjects(em: EntityManager, today: string): Promise<Subject[]> {
  const last = addDays(today, STAFF_STEPS[0]);
  const documents: Subject[] = await em.query(`SELECT 'DOCUMENT' AS subject, d.id AS "subjectId", d."driverId", d.kind, to_char(d."expiresOn", 'YYYY-MM-DD') AS "dueOn",
     x.email, EXISTS(SELECT 1 FROM driver_telegram_links g WHERE g."driverId" = x.id) AS telegram, ${renewalScanWaiting('d."driverId"', 'd.kind')} AS waiting
    FROM (SELECT DISTINCT ON ("driverId", kind) * FROM driver_documents WHERE "verifiedAt" IS NOT NULL ORDER BY "driverId", kind, "createdAt" DESC) d JOIN drivers x ON x.id = d."driverId"
    WHERE x.status IN ('APPROVED','CLEARED') AND d."expiresOn" IS NOT NULL AND d."expiresOn" <= $1 AND (d.subtype IS NULL OR d.subtype NOT IN ('US_PASSPORT','GREEN_CARD'))
   UNION ALL
   SELECT 'OWNER_DOCUMENT', o.id, o."driverId", o.kind, to_char(o."expiresOn", 'YYYY-MM-DD'), x.email, false, false
    FROM driver_owner_documents o JOIN driver_trucks t ON t.id = o."truckId" JOIN drivers x ON x.id = o."driverId"
    WHERE o."replacedAt" IS NULL AND o."expiresOn" IS NOT NULL AND o."expiresOn" <= $1 AND t."archivedAt" IS NULL AND x.status IN ('APPROVED','CLEARED')`, [last]);
  const reviews = (await this.annual.due()).items.filter(item => item.dueOn <= last).map(item => ({ subject: 'ANNUAL_REVIEW' as const, subjectId: item.driverId, driverId: item.driverId,
   kind: 'ANNUAL_REVIEW', dueOn: item.dueOn, email: null, telegram: false, waiting: false }));
  return [...documents, ...reviews];
 }

 /** One morning message per Safety contact (or each Safety manager, for drivers with none), with every step reached. */
 private async queueStaff(em: EntityManager, subjects: Subject[], today: string) {
  const contacts: { driverId: string; ownerId: string }[] = await em.query(`SELECT x."driverId", x."ownerId" FROM driver_owners x JOIN users u ON u.id = x."ownerId"
   WHERE x."endedAt" IS NULL AND u.status = 'ACTIVE' AND u.role::text = 'SAFETY_STAFF'`);
  const managers = (await em.getRepository(User).findBy({ role: Role.SAFETY_MANAGER, status: UserStatus.ACTIVE })).map(user => user.id);
  const linked = await this.staffOnTelegram(em);
  const owners = new Map(contacts.map(row => [row.driverId, row.ownerId]));
  const byRecipient = new Map<string, { subject: Subject; step: number }[]>();
  for (const subject of subjects) {
   const step = stepFor(subject.dueOn, today, STAFF_STEPS);
   if (step === null) continue;
   const owner = owners.get(subject.driverId);
   for (const recipient of owner ? [owner] : managers) byRecipient.set(recipient, [...byRecipient.get(recipient) ?? [], { subject, step }]);
  }
  const ids: string[] = [];
  for (const [recipientId, items] of byRecipient) {
   const [batch]: { id: string }[] = await em.query(`INSERT INTO safety_reminder_batches ("recipientId", kind, day) VALUES ($1, 'DAILY', $2) ON CONFLICT DO NOTHING RETURNING id`, [recipientId, today]);
   if (!batch) continue;
   let added = 0;
   for (const { subject, step } of items) added += (await this.reminder(em, subject, 'STAFF', step, { batchId: batch.id, recipientId })) ? 1 : 0;
   // This person was already told about every step reached: nothing new to say.
   if (!added) { await em.query('DELETE FROM safety_reminder_batches WHERE id = $1', [batch.id]); continue; }
   ids.push(...await this.delivery(em, { batchId: batch.id }, this.staffChannel(linked.has(recipientId))));
  }
  return ids;
 }

 /** Licenses and medical cards, to the driver: unless a renewal scan they sent is waiting for its check (the rule Safety's pages use). */
 private async queueDrivers(em: EntityManager, subjects: Subject[], today: string) {
  const ids: string[] = [];
  for (const subject of subjects) {
   if (subject.subject !== 'DOCUMENT' || !(RENEWAL_KINDS as readonly string[]).includes(subject.kind) || subject.waiting) continue;
   const step = stepFor(subject.dueOn, today, DRIVER_STEPS);
   if (step === null) continue;
   const reminderId = await this.reminder(em, subject, 'DRIVER', step, null);
   if (reminderId) ids.push(...await this.delivery(em, { reminderId }, this.driverChannel(subject)));
  }
  return ids;
 }

 /** Mondays: every active Safety manager gets the week's counts. */
 private async queueWeekly(em: EntityManager, today: string) {
  const ids: string[] = [], linked = await this.staffOnTelegram(em);
  for (const manager of await em.getRepository(User).findBy({ role: Role.SAFETY_MANAGER, status: UserStatus.ACTIVE })) {
   const [batch]: { id: string }[] = await em.query(`INSERT INTO safety_reminder_batches ("recipientId", kind, day) VALUES ($1, 'WEEKLY', $2) ON CONFLICT DO NOTHING RETURNING id`, [manager.id, today]);
   if (batch) ids.push(...await this.delivery(em, { batchId: batch.id }, this.staffChannel(linked.has(manager.id))));
  }
  return ids;
 }

 /** A step reached, once per audience (and staff recipient): null when it was already recorded (UQ_safety_reminders_step). */
 private async reminder(em: EntityManager, subject: Subject, audience: 'DRIVER' | 'STAFF', step: number, staff: { batchId: string; recipientId: string } | null): Promise<string | null> {
  const [row]: { id: string }[] = await em.query(`INSERT INTO safety_reminders ("driverId", audience, subject, "subjectId", kind, "dueOn", step, "batchId", "recipientId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
   ON CONFLICT DO NOTHING RETURNING id`, [subject.driverId, audience, subject.subject, subject.subjectId, subject.kind, subject.dueOn, step, staff?.batchId ?? null, staff?.recipientId ?? null]);
  return row?.id ?? null;
 }
 private async staffOnTelegram(em: EntityManager) {
  return new Set((await em.query('SELECT "userId" FROM staff_telegram_links') as { userId: string }[]).map(row => row.userId));
 }
 /** Staff: Telegram once connected, otherwise their work email. */
 private staffChannel(linked: boolean): [Channel, string | null] {
  if (linked && this.telegram.enabled) return ['TELEGRAM', null];
  return ['EMAIL', this.email.enabled ? null : 'DISABLED'];
 }
 /** Drivers: Telegram once connected, otherwise email. The renewal link is bound to their email, so they need one either way. */
 private driverChannel(subject: Subject): [Channel, string | null] {
  const channel: Channel = subject.telegram && this.telegram.enabled ? 'TELEGRAM' : 'EMAIL';
  if (!this.addressable(subject.email)) return [channel, 'NO_ADDRESS'];
  return [channel, channel === 'EMAIL' && !this.email.enabled ? 'DISABLED' : null];
 }
 private addressable(email: string | null) { return !!email && (isProduction(this.config) || email.endsWith('@example.test')); }
 private async delivery(em: EntityManager, owner: { reminderId?: string; batchId?: string }, [channel, skipped]: [Channel, string | null]) {
  const [row]: { id: string }[] = await em.query(`INSERT INTO safety_reminder_deliveries ("reminderId", "batchId", channel, status, "failureCode") VALUES ($1,$2,$3,$4,$5) RETURNING id`,
   [owner.reminderId ?? null, owner.batchId ?? null, channel, skipped ? 'SKIPPED' : 'PENDING', skipped]);
  return skipped ? [] : [row.id];
 }

 /** Claims rows atomically (FOR UPDATE SKIP LOCKED): today's fresh ones, or (ids null) stale ones left by a restart or failure. */
 private async claim(ids: string[] | null): Promise<Claimed[]> {
  const due = ids ? `id = ANY($2::uuid[]) AND status = 'PENDING'`
   : `(status = 'PENDING' AND COALESCE("claimedAt","createdAt") < now() - interval '${RETRY.pendingAfter}') OR (status = 'SENDING' AND "claimedAt" < now() - interval '${RETRY.claimTimeout}')`;
  const [rows]: [Claimed[], number] = await this.db.query(`WITH due AS (SELECT id FROM safety_reminder_deliveries WHERE ${due} ORDER BY "createdAt" LIMIT ${RETRY.batch} FOR UPDATE SKIP LOCKED)
   UPDATE safety_reminder_deliveries d SET status = CASE WHEN d.attempts >= $1 THEN 'FAILED' ELSE 'SENDING' END,
    "failureCode" = CASE WHEN d.attempts >= $1 THEN 'MAX_ATTEMPTS' ELSE d."failureCode" END,
    attempts = CASE WHEN d.attempts >= $1 THEN d.attempts ELSE d.attempts + 1 END, "claimedAt" = now()
   FROM due WHERE d.id = due.id RETURNING d.id, d."reminderId", d."batchId", d.channel, d.status, d.attempts`, ids ? [RETRY.maxAttempts, ids] : [RETRY.maxAttempts]);
  for (const row of rows) if (row.status === 'FAILED') this.logger.warn(`Reminder ${row.channel} failed: MAX_ATTEMPTS`);
  return rows.filter(row => row.status === 'SENDING');
 }
 /** Sends what was claimed, one at a time, and records each outcome (safe codes only) and the channel it actually went by. */
 async deliver(ids: string[] | null) {
  if (!this.sending) return;
  // Fresh rows first; stale ones from an earlier run are swept on every tick.
  const claimed = [...ids ? await this.claim(ids) : [], ...await this.claim(null)];
  for (const delivery of claimed) {
   const { result, channel } = await this.send(delivery).catch((): Outcome => ({ result: 'FAILED', channel: delivery.channel }));
   if (result !== true && !NOTHING_TO_SEND.has(result)) this.logger.warn(`Reminder ${channel} failed: ${result}`);
   const final = result === true || NOTHING_TO_SEND.has(result) || PERMANENT_FAILURES.has(result) || delivery.attempts >= RETRY.maxAttempts;
   await this.db.query(`UPDATE safety_reminder_deliveries SET status = $3, "failureCode" = $4, "sentAt" = $5, channel = $6 WHERE id = $1 AND status = 'SENDING' AND attempts = $2`,
    [delivery.id, delivery.attempts, result === true ? 'SENT' : NOTHING_TO_SEND.has(result) ? 'SKIPPED' : final ? 'FAILED' : 'PENDING', result === true ? null : result.slice(0, 32), result === true ? new Date() : null, channel]);
  }
 }
 private send(delivery: Claimed): Promise<Outcome> {
  return delivery.reminderId ? this.sendDriver(delivery.reminderId, delivery.channel) : this.sendStaff(delivery.batchId!, delivery.channel);
 }
 /**
  * Telegram when that is the channel and the chat still works; when it is gone (disconnected, or the bot was blocked), the
  * same message by email, which the Reminders card promises. gone() runs first, so a blocked driver chat is dropped.
  */
 private async deliverMessage(channel: Channel, chatId: string | null, address: string | null, message: Message, gone?: () => Promise<void>): Promise<Outcome> {
  if (channel === 'TELEGRAM') {
   const result = chatId ? await this.telegram.sendMessage(chatId, message.telegram, message.button).then(() => true as const, (error: unknown) => error instanceof TelegramError ? error.code : 'FAILED') : 'NOT_CONNECTED';
   if (result === true || !TELEGRAM_GONE.has(result)) return { result, channel };
   if (result === 'FORBIDDEN' && gone) await gone();
   if (!address || !this.email.enabled) return { result, channel };
  }
  return { result: address ? await this.email.sendStatusUpdate(address, message.email) : 'NO_ADDRESS', channel: 'EMAIL' };
 }

 /**
  * A driver's reminder about the document it was queued for, if that is still the one to renew: still their latest checked
  * one, with the same date, and no renewal scan of theirs waiting. It carries a new renewal link (replacing one an earlier
  * reminder made), made only now because the message carries it and the outbox stores no text; a retry makes another.
  * While a link Safety sent is still open the reminder points to it instead, so that link keeps working.
  */
 private async sendDriver(reminderId: string, channel: Channel): Promise<Outcome> {
  const prepared = await this.db.transaction(async em => {
   const [reminder]: { driverId: string; subjectId: string; kind: RenewalKind; dueOn: string }[] = await em.query(`SELECT "driverId", "subjectId", kind, to_char("dueOn", 'YYYY-MM-DD') AS "dueOn" FROM safety_reminders WHERE id = $1`, [reminderId]);
   const driver = await em.getRepository(Driver).findOne({ where: { id: reminder.driverId }, lock: { mode: 'pessimistic_write' } });
   if (!driver || !LEAVABLE.includes(driver.status)) return 'CLOSED';
   const [latest]: { id: string; expiresOn: string | null; waiting: boolean }[] = await em.query(`SELECT d.id, to_char(d."expiresOn", 'YYYY-MM-DD') AS "expiresOn", ${renewalScanWaiting('d."driverId"', 'd.kind')} AS waiting
    FROM driver_documents d WHERE d."driverId" = $1 AND d.kind = $2 AND d."verifiedAt" IS NOT NULL ORDER BY d."createdAt" DESC LIMIT 1`, [driver.id, reminder.kind]);
   if (latest?.id !== reminder.subjectId) return 'RENEWED';
   if (latest.expiresOn !== reminder.dueOn) return 'CHANGED';
   if (latest.waiting) return 'WAITING';
   if (!this.addressable(driver.email)) return 'NO_ADDRESS';
   const chat = await em.getRepository(DriverTelegramLink).findOneBy({ driverId: driver.id });
   const [sent]: { expiresAt: Date }[] = await em.query(`SELECT "expiresAt" FROM driver_links WHERE "driverId" = $1 AND purpose = 'RENEWAL' AND "documentKind" = $2
    AND "revokedAt" IS NULL AND "completedAt" IS NULL AND "expiresAt" > now() AND "createdBy" IS NOT NULL`, [driver.id, reminder.kind]);
   let url: string | null = null;
   if (!sent) {
    const link = await createRenewalLink(em, driver, reminder.kind, null, this.origin());
    await em.getRepository(Driver).update(driver.id, { version: driver.version + 1 });
    await driverEvent(em, null, driver.id, 'RENEWAL_LINK_SENT', { kind: reminder.kind, resent: link.resent, reminder: true, channel });
    url = link.url;
   }
   return { email: driver.email!, chatId: chat?.chatId ?? null, driverId: driver.id, message: driverReminderMessage(reminder.kind, reminder.dueOn, usDay('latest'), url, sent?.expiresAt ?? null) };
  });
  if (typeof prepared === 'string') return { result: prepared, channel };
  // A chat that blocked the bot can't be used again: drop it, so the next reminders go by email.
  const gone = async () => {
   await this.db.transaction(async em => {
    const removed = await em.getRepository(DriverTelegramLink).delete({ driverId: prepared.driverId, chatId: prepared.chatId! });
    if (removed.affected) await driverEvent(em, null, prepared.driverId, 'TELEGRAM_STOPPED', { blocked: true });
   });
  };
  return this.deliverMessage(channel, prepared.chatId, prepared.email, prepared.message, gone);
 }

 /**
  * A Safety contact's morning message or the Safety manager's Monday summary, to whoever the batch names, if still active.
  * The morning message lists only what is still due: a document renewed or corrected, or a yearly review recorded, since
  * the run drops out (a retry never lists it).
  */
 private async sendStaff(batchId: string, channel: Channel): Promise<Outcome> {
  const [batch]: { recipientId: string; kind: 'DAILY' | 'WEEKLY'; day: string }[] = await this.db.query(`SELECT "recipientId", kind, to_char(day, 'YYYY-MM-DD') AS day FROM safety_reminder_batches WHERE id = $1`, [batchId]);
  const user = await this.db.getRepository(User).findOneBy({ id: batch.recipientId });
  if (!user || user.status !== UserStatus.ACTIVE || ![Role.SAFETY_STAFF, Role.SAFETY_MANAGER].includes(user.role)) return { result: 'INACTIVE', channel };
  const url = `${this.origin()}/safety/expiring`, today = usDay('latest');
  let message: Message;
  if (batch.kind === 'WEEKLY') message = weeklySummaryMessage(await this.weeklyCounts(today), url);
  else {
   const lines: StaffReminderLine[] = await this.db.query(`SELECT x."firstName", x."lastName", r.kind, to_char(r."dueOn", 'YYYY-MM-DD') AS "dueOn" FROM safety_reminders r
    JOIN drivers x ON x.id = r."driverId" WHERE r."batchId" = $1 AND x.status NOT IN (${CLOSED_STATUSES.map(status => `'${status}'`).join(',')})
     AND CASE r.subject
      WHEN 'DOCUMENT' THEN EXISTS(SELECT 1 FROM (SELECT c.id, c."expiresOn" FROM driver_documents c WHERE c."driverId" = r."driverId" AND c.kind = r.kind AND c."verifiedAt" IS NOT NULL
        ORDER BY c."createdAt" DESC LIMIT 1) l WHERE l.id = r."subjectId" AND l."expiresOn" = r."dueOn")
      WHEN 'OWNER_DOCUMENT' THEN EXISTS(SELECT 1 FROM driver_owner_documents o WHERE o.id = r."subjectId" AND o."replacedAt" IS NULL AND o."expiresOn" = r."dueOn")
      ELSE NOT EXISTS(SELECT 1 FROM driver_annual_reviews v WHERE v."driverId" = r."driverId" AND v."createdAt" > r."createdAt") END
    ORDER BY r."dueOn", x."lastName"`, [batchId]);
   if (!lines.length) return { result: 'CLOSED', channel };
   message = staffReminderMessage(lines, today, url);
  }
  const [link]: { chatId: string }[] = channel === 'TELEGRAM' ? await this.db.query('SELECT "chatId" FROM staff_telegram_links WHERE "userId" = $1', [user.id]) : [];
  return this.deliverMessage(channel, link?.chatId ?? null, user.email, message);
 }
 /** The Monday counts, from the same lists Safety sees. */
 private async weeklyCounts(today: string) {
  const [{ items }, due, [hold]] = await Promise.all([this.safety.expiring(), this.annual.due(),
   this.db.query(`SELECT count(*)::int AS n FROM drivers d WHERE d.status = 'CLEARED' AND ${onHoldSql('d')}`) as Promise<{ n: number }[]>]);
  const soon = addDays(today, 30);
  return { expired: items.filter(item => item.expired).length, onHold: hold.n, expiringSoon: items.filter(item => !item.expired && item.expiresOn <= soon).length,
   waiting: items.filter(item => item.renewal?.scan && !item.renewal.scan.unreadable).length,
   reviewsDue: due.items.filter(item => !item.notQualified && daysUntil(item.dueOn, today) <= 30).length };
 }

 // ── Drivers' Telegram connection ──────────────────────────────────────────────────────────────────────────────────

 /** What a driver's page and Safety see: whether reminders reach Telegram, and the reminders so far (newest first). */
 async forDriver(driverId: string) {
  const link = await this.db.getRepository(DriverTelegramLink).findOneBy({ driverId });
  const items = await this.db.query(`SELECT r.kind, r.step, to_char(r."dueOn", 'YYYY-MM-DD') AS "dueOn", r."createdAt", d.channel, d.status, d."failureCode", d."sentAt"
   FROM safety_reminders r JOIN safety_reminder_deliveries d ON d."reminderId" = r.id WHERE r."driverId" = $1 AND r.audience = 'DRIVER' ORDER BY r."createdAt" DESC LIMIT 20`, [driverId]);
  return { telegramAvailable: this.telegram.enabled, emailAvailable: this.email.enabled, telegramConnected: !!link, telegramLinkedAt: link?.linkedAt ?? null, items };
 }
 /** Safety makes a one-time link (7 days) to send the driver themselves, by text; it only connects reminders. */
 async staffConnectLink(user: User, id: string, version: number) {
  if (!this.telegram.enabled) throw new BadRequestException('Telegram reminders aren’t available yet.');
  await onboardingLimit(this.db, `driver-telegram-link:${user.id}`, 30, 3600);
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, version);
   if (!SCREENERS.includes(user.role) && !await ownsDriver(em, user, id)) throw new ForbiddenException('Only Safety leads, managers and the driver’s Safety contact can do this.');
   if (!LEAVABLE.includes(driver.status)) throw new ConflictException('Reminders start once the driver is approved.');
   const link = await this.connectLink(em, id, user.id, DRIVER_LINK_MS);
   await driverEvent(em, user.id, id, 'TELEGRAM_LINK_CREATED', {});
   return { ...link, version: driver.version };
  });
 }
 /** The driver connects from their own page (application or renewal), while their verified session lasts. */
 async driverView(req: Request) {
  const driverId = await this.sessionDriver(req);
  const link = await this.db.getRepository(DriverTelegramLink).findOneBy({ driverId });
  return { available: this.telegram.enabled, connected: !!link };
 }
 async driverConnectLink(req: Request) {
  if (!this.telegram.enabled) throw new BadRequestException('Telegram reminders aren’t available yet.');
  const driverId = await this.sessionDriver(req);
  await onboardingLimit(this.db, `driver-telegram-own:${driverId}`, 10, 3600);
  return this.connectLink(this.db.manager, driverId, null, OWN_LINK_MS);
 }
 async driverCheck(req: Request) {
  if (!this.telegram.enabled) throw new BadRequestException('Telegram reminders aren’t available yet.');
  const driverId = await this.sessionDriver(req);
  await onboardingLimit(this.db, `driver-telegram-check:${driverId}`, 30, 600);
  await this.updates.pollTelegram();
  return this.driverView(req);
 }
 private async connectLink(em: EntityManager, driverId: string, createdBy: string | null, ttl: number) {
  const token = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now() + ttl);
  await em.getRepository(DriverTelegramLinkToken).save({ driverId, tokenHash: hash(token), expiresAt, consumedAt: null, createdBy });
  return { url: `https://t.me/${this.telegram.botUsername}?start=${token}`, expiresAt };
 }
 private async sessionDriver(req: Request) {
  const link = await sessionLink(this.db.manager, req);
  const driver = await this.db.getRepository(Driver).findOneBy({ id: link.driverId });
  if (link.revokedAt || !driver || CLOSED_STATUSES.includes(driver.status)) throw new UnauthorizedException('Please verify your email again.');
  return driver.id;
 }
}
