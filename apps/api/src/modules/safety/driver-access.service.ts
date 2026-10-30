import { BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
// Standalone ts-node commands must load our express-session type augmentation too.
import type {} from '../auth/session';
import { DataSource, EntityManager } from 'typeorm';
import { EmailService } from '../email/email.service';
import { clientBucket, countAttempt, onboardingLimit } from '../onboarding/rate-limit';
import { digest, generateVerificationCode } from '../onboarding/verification-code';
import { BeginDriverDto, SaveDriverApplicationDto, VerifyDriverDto } from './driver-application.dto';
import { PiiService } from './pii';
import { Driver, DriverApplication, DriverApplicationFields, DriverChallenge, DriverEvent, DriverLink, REQUIRED_DRIVER_FIELDS } from './safety.entity';

/** Code requests per window, like applicant verification: a circuit breaker plus per-address buckets, no per-link cap. */
export const DRIVER_BEGIN_LIMITS = { global: 1000, ip: 20, emailIp: 5, linkIp: 10 } as const;
export const DRIVER_VERIFY_LIMITS = { global: 1000, ip: 30 } as const;
/** Code emails actually sent: per address per day, and a daily total shared with nothing else. */
export const DRIVER_SEND_LIMITS = { perAddressDaily: 10, dailyBudget: 200 } as const;
const SESSION_MS = 3600_000;
const INVALID = 'Verification is invalid or expired.';
const labels: Record<string, string> = { legalFirstName: 'first name', legalLastName: 'last name', dateOfBirth: 'date of birth', phone: 'phone', addressLine1: 'street address',
 city: 'city', state: 'state', zip: 'ZIP code', emergencyName: 'emergency contact name', emergencyRelationship: 'emergency contact relationship',
 emergencyPhone: 'emergency contact phone', licenseNumber: 'license number', licenseState: 'license state', licenseClass: 'license class', licenseExpiresOn: 'license expiration', ssn: 'Social Security number' };
const years = (from: string, to = new Date()) => {
 const date = new Date(`${from}T12:00:00Z`);
 let age = to.getUTCFullYear() - date.getUTCFullYear();
 if (to.getUTCMonth() < date.getUTCMonth() || (to.getUTCMonth() === date.getUTCMonth() && to.getUTCDate() < date.getUTCDate())) age -= 1;
 return age;
};

/**
 * The driver's side of the application: request an emailed code for the link Safety sent, verify it, then save answers
 * and submit. Every request goes through the BFF/CSRF boundary; record access needs a driver session bound to an open
 * link. Matched and unmatched code requests respond identically and make the same single write.
 */
@Injectable()
export class DriverAccessService {
 private readonly logger = new Logger('DriverVerification');
 constructor(private readonly db: DataSource, private readonly config: ConfigService, private readonly email: EmailService, private readonly pii: PiiService) {}
 private get production() { return this.config.get('NODE_ENV') === 'production' || this.config.get('DEPLOYMENT_PURPOSE') === 'production'; }

 async begin(dto: BeginDriverDto, req: Request) {
  if (!this.email.enabled) throw new ServiceUnavailableException('Email verification isn’t available right now. Please contact Safety.');
  if (!this.production && !dto.email.endsWith('@example.test')) throw new BadRequestException('Outside production, use a fictional email ending in @example.test.');
  const ip = clientBucket(req), target = digest(dto.token);
  await onboardingLimit(this.db, 'driver-begin-global', DRIVER_BEGIN_LIMITS.global, 60);
  await onboardingLimit(this.db, `driver-begin-ip:${ip}`, DRIVER_BEGIN_LIMITS.ip);
  await onboardingLimit(this.db, `driver-begin-email-ip:${dto.email}:${ip}`, DRIVER_BEGIN_LIMITS.emailIp);
  await onboardingLimit(this.db, `driver-begin-link-ip:${target}:${ip}`, DRIVER_BEGIN_LIMITS.linkIp);
  const link = await this.db.getRepository(DriverLink).findOneBy({ tokenHash: target });
  const driver = link ? await this.db.getRepository(Driver).findOneBy({ id: link.driverId }) : null;
  const valid = !!link && !!driver && this.open(link) && link.email === dto.email && driver.status === 'APPLYING';
  await this.db.query('DELETE FROM driver_challenges WHERE "expiresAt" < now()');
  const code = valid ? generateVerificationCode() : null;
  const challenge = await this.db.getRepository(DriverChallenge).save({ linkId: valid ? link.id : null, email: valid ? dto.email : null, codeHash: code ? digest(code) : null,
   expiresAt: new Date(Date.now() + 600_000) });
  if (valid && code) {
   const linkId = link.id, to = dto.email;
   // After the response: mark the link opened and send the code, within the mail limits.
   this.email.runInBackground(async () => {
    await this.db.getRepository(DriverLink).createQueryBuilder().update().set({ openedAt: new Date() }).where('id = :id AND "openedAt" IS NULL', { id: linkId }).execute();
    if (await countAttempt(this.db, `driver-sends-to:${to}`, 86400) > DRIVER_SEND_LIMITS.perAddressDaily) return this.logger.warn('Verification email not sent: ADDRESS_DAILY_LIMIT');
    if (await countAttempt(this.db, 'driver-verification-sends', 86400) > DRIVER_SEND_LIMITS.dailyBudget) return this.logger.warn('Verification email not sent: DAILY_BUDGET');
    if (!await this.email.sendVerificationCode(to, code)) this.logger.warn('Verification email not sent');
   });
  }
  // Identical for unknown, cancelled, expired, mismatched and matched requests.
  return { challengeId: challenge.id, message: 'If this email matches the one Safety has for this link, we’re sending an 8-digit code to it. It expires in 10 minutes.' };
 }

 async verify(dto: VerifyDriverDto, req: Request) {
  await onboardingLimit(this.db, 'driver-verify-global', DRIVER_VERIFY_LIMITS.global, 60);
  await onboardingLimit(this.db, `driver-verify-ip:${clientBucket(req)}`, DRIVER_VERIFY_LIMITS.ip);
  await onboardingLimit(this.db, `driver-code:${dto.challengeId}`, 5);
  const linkId = await this.db.transaction(async em => {
   const challenge = await em.getRepository(DriverChallenge).createQueryBuilder('c').addSelect('c.codeHash').setLock('pessimistic_write').where('c.id = :id', { id: dto.challengeId }).getOne();
   if (!challenge?.linkId || !challenge.codeHash || challenge.consumedAt || challenge.expiresAt.getTime() <= Date.now() || challenge.codeHash !== digest(dto.code)) throw new UnauthorizedException(INVALID);
   const link = await em.getRepository(DriverLink).findOneBy({ id: challenge.linkId });
   const driver = link ? await em.getRepository(Driver).findOne({ where: { id: link.driverId }, lock: { mode: 'pessimistic_write' } }) : null;
   const current = link ? await em.getRepository(DriverLink).findOne({ where: { id: link.id }, lock: { mode: 'pessimistic_write' } }) : null;
   if (!current || !driver || !this.open(current) || current.email !== challenge.email || driver.status !== 'APPLYING') throw new UnauthorizedException(INVALID);
   await em.getRepository(DriverChallenge).update(challenge.id, { consumedAt: new Date(), codeHash: null });
   // The first visit starts the application with what Safety already knows.
   if (!await em.getRepository(DriverApplication).existsBy({ driverId: driver.id })) {
    await em.getRepository(DriverApplication).save({ driverId: driver.id, fields: this.clean({ legalFirstName: driver.firstName, legalLastName: driver.lastName, phone: driver.phone,
     licenseState: driver.licenseState ?? undefined, licenseClass: driver.licenseType ?? undefined }) });
   }
   await em.getRepository(DriverEvent).save({ driverId: driver.id, actorId: null, event: 'APPLICATION_VERIFIED', metadata: {} });
   return current.id;
  });
  await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.driverLinkId = linkId;
  req.session.expiresAt = Date.now() + SESSION_MS;
  req.session.cookie.maxAge = SESSION_MS;
  await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
  return { verified: true };
 }

 async current(req: Request) {
  const { link, application } = await this.session(this.db.manager, req, false);
  return this.view(link, application);
 }

 /** Saves a draft, or submits it: the link closes and the driver moves to Screening in the same transaction. */
 async save(req: Request, dto: SaveDriverApplicationDto, submit: boolean) {
  return this.db.transaction(async em => {
   const { link, driver, application } = await this.session(em, req, true);
   if (application.status === 'SUBMITTED' || link.completedAt) throw new ConflictException('Your application was already sent to Safety.');
   if (application.version !== dto.version) throw new ConflictException('Your application changed in another window. Reload the page to see the latest answers.');
   // Only answers sent change: an empty string clears one; a missing key keeps the saved answer.
   const sentFields = Object.fromEntries(Object.entries(dto.fields).filter(([, value]) => value !== undefined));
   const fields = this.clean({ ...application.fields, ...sentFields } as DriverApplicationFields);
   const repo = em.getRepository(DriverApplication);
   const changes: Partial<DriverApplication> = { fields, version: application.version + 1 };
   if (dto.ssn?.trim()) { const sealed = this.pii.sealSsn(dto.ssn, driver.id); changes.ssnCiphertext = sealed.ciphertext; changes.ssnLast4 = sealed.last4; }
   if (submit) {
    const missing: string[] = REQUIRED_DRIVER_FIELDS.filter(field => !fields[field]);
    if (!changes.ssnLast4 && !application.ssnLast4) missing.push('ssn');
    if (missing.length) throw new BadRequestException({ message: `Answer every required question first: ${missing.map(field => labels[field]).join(', ')}.`, missing });
    const age = years(fields.dateOfBirth!);
    if (age < 18 || age > 100) throw new BadRequestException({ message: 'Check your date of birth.', missing: ['dateOfBirth'] });
    if (fields.licenseExpiresOn! < new Date().toISOString().slice(0, 10)) throw new BadRequestException({ message: 'Your license has expired. Contact Safety before you continue.', missing: ['licenseExpiresOn'] });
    const now = new Date();
    Object.assign(changes, { status: 'SUBMITTED', submittedAt: now });
    await em.getRepository(DriverLink).update(link.id, { completedAt: now });
    await em.getRepository(Driver).update(driver.id, { status: 'SCREENING', version: driver.version + 1 });
    await em.getRepository(DriverEvent).save({ driverId: driver.id, actorId: null, event: 'APPLICATION_SUBMITTED', metadata: {} });
   }
   await repo.update(application.id, changes);
   const saved = await repo.findOneByOrFail({ id: application.id });
   return this.view({ ...link, completedAt: submit ? saved.submittedAt : link.completedAt }, saved);
  });
 }

 /** The verified link, its driver and application. With lock, takes the driver row first, like every staff write. */
 private async session(em: EntityManager, req: Request, lock: boolean) {
  const linkId = req.session?.driverLinkId;
  if (!linkId || !req.session.expiresAt || req.session.expiresAt <= Date.now()) throw new UnauthorizedException('Please verify your email again.');
  const first = await em.getRepository(DriverLink).findOneBy({ id: linkId });
  if (!first) throw new UnauthorizedException('Please verify your email again.');
  const driver = await em.getRepository(Driver).findOne({ where: { id: first.driverId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  const link = lock ? await em.getRepository(DriverLink).findOneByOrFail({ id: linkId }) : first;
  const application = await em.getRepository(DriverApplication).findOne({ where: { driverId: first.driverId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  // A submitted application stays readable for the rest of the session; anything else needs an open link.
  if (!driver || !application || link.revokedAt || (!link.completedAt && (!this.open(link) || driver.status !== 'APPLYING'))) throw new UnauthorizedException('This application link is no longer available. Please contact Safety.');
  return { link, driver, application };
 }
 private open(link: DriverLink) { return !link.revokedAt && !link.completedAt && link.expiresAt.getTime() > Date.now(); }
 private clean(fields: DriverApplicationFields): DriverApplicationFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === 'string' && value !== '')) as DriverApplicationFields;
 }
 private view(link: DriverLink, application: DriverApplication) {
  return { email: link.email, expiresAt: link.expiresAt, status: application.status, fields: application.fields, version: application.version,
   ssnLast4: application.ssnLast4, submittedAt: application.submittedAt, ssnAvailable: this.pii.enabled };
 }
}
