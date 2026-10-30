import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
// Standalone ts-node commands must load our express-session type augmentation too.
import type {} from '../auth/session';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import type { FileResult } from '../documents/documents.service';
import { sha256 } from '../documents/images';
import { driverDocumentKey, StorageService } from '../storage/storage.service';
import { EmailService } from '../email/email.service';
import { clientBucket, countAttempt, onboardingLimit } from '../onboarding/rate-limit';
import { digest, generateVerificationCode } from '../onboarding/verification-code';
import { BeginDriverDto, DriverDocumentDto, SaveDriverApplicationDto, VerifyDriverDto } from './driver-application.dto';
import { consentStatus } from './consent-rules';
import { scanPdf } from './scan';
import { PiiService } from './pii';
import { DOCUMENT_SEGMENTS, Driver, DriverApplication, DriverApplicationFields, DriverChallenge, DriverDocument, DriverEvent, DriverLink, REQUIRED_DRIVER_FIELDS, requiredDriverDocuments } from './safety.entity';

/** Code requests per window, like applicant verification: a circuit breaker plus per-address buckets, no per-link cap. */
export const DRIVER_BEGIN_LIMITS = { global: 1000, ip: 20, emailIp: 5, linkIp: 10 } as const;
export const DRIVER_VERIFY_LIMITS = { global: 1000, ip: 30 } as const;
/** Code emails actually sent: per address per day, and a daily total shared with nothing else. */
export const DRIVER_SEND_LIMITS = { perAddressDaily: 10, dailyBudget: 200 } as const;
const SESSION_MS = 3600_000;
const INVALID = 'Verification is invalid or expired.';
const labels: Record<string, string> = { legalFirstName: 'first name', legalLastName: 'last name', dateOfBirth: 'date of birth', phone: 'phone', addressLine1: 'street address',
 city: 'city', state: 'state', zip: 'ZIP code', emergencyName: 'emergency contact name', emergencyRelationship: 'emergency contact relationship',
 emergencyPhone: 'emergency contact phone', licenseNumber: 'license number', licenseState: 'license state', licenseClass: 'license class', licenseExpiresOn: 'license expiration', ssn: 'Social Security number',
 LICENSE: 'license scan', MEDICAL_CARD: 'medical card scan', WORK_AUTHORIZATION: 'work authorization scan',
 'consent:BACKGROUND_DISCLOSURE': 'background check disclosure', 'consent:BACKGROUND_AUTHORIZATION': 'background check authorization', 'consent:CLEARINGHOUSE_CONSENT': 'Clearinghouse consent' };
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
 constructor(private readonly db: DataSource, private readonly config: ConfigService, private readonly email: EmailService, private readonly pii: PiiService,
  private readonly storage: StorageService) {}
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
  return this.view(this.db.manager, link, application);
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
    // Scans are required whenever private storage is configured (always in production).
    if (this.storage.enabled) {
     const present = (await em.getRepository(DriverDocument).findBy({ driverId: driver.id, replacedAt: IsNull() })).map(document => document.kind);
     missing.push(...requiredDriverDocuments(fields).filter(kind => !present.includes(kind)));
     // Every published consent form, signed in its current version.
     missing.push(...(await consentStatus(em, driver.id, true)).missing);
    }
    if (missing.length) throw new BadRequestException({ message: `Answer every required question first: ${missing.map(field => labels[field]).join(', ')}.`, missing });
    const age = years(fields.dateOfBirth!);
    if (age < 18 || age > 100) throw new BadRequestException({ message: 'Check your date of birth.', missing: ['dateOfBirth'] });
    if (fields.licenseExpiresOn! < new Date().toISOString().slice(0, 10)) throw new BadRequestException({ message: 'Your license has expired. Contact Safety before you continue.', missing: ['licenseExpiresOn'] });
    const now = new Date();
    // A resubmission after corrections clears Safety's message.
    Object.assign(changes, { status: 'SUBMITTED', submittedAt: now, correctionNote: null, correctionRequestedAt: null });
    await em.getRepository(DriverLink).update(link.id, { completedAt: now });
    await em.getRepository(Driver).update(driver.id, { status: 'SCREENING', version: driver.version + 1 });
    await em.getRepository(DriverEvent).save({ driverId: driver.id, actorId: null, event: 'APPLICATION_SUBMITTED', metadata: {} });
   }
   await repo.update(application.id, changes);
   const saved = await repo.findOneByOrFail({ id: application.id });
   return this.view(em, { ...link, completedAt: submit ? saved.submittedAt : link.completedAt }, saved);
  });
 }

 /**
  * Stores one scanned document: the photographed pages, cleaned and combined into a PDF. It replaces the driver's
  * previous scan of that kind, whose file is removed unless Safety verified it (a reopened application): an unverified
  * draft scan was never reviewed. Allowed only before submission.
  */
 async uploadDocument(req: Request, segment: string, dto: DriverDocumentDto) {
  const kind = DOCUMENT_SEGMENTS[segment];
  if (!kind) throw new NotFoundException();
  if (!this.storage.enabled) throw new ServiceUnavailableException('Document uploads aren’t available right now. Please contact Safety.');
  if ((kind === 'WORK_AUTHORIZATION') !== !!dto.subtype) throw new BadRequestException(kind === 'WORK_AUTHORIZATION' ? 'Choose which document you’re scanning.' : 'Only work authorization takes a document type.');
  const first = await this.session(this.db.manager, req, false);
  if (first.application.status !== 'DRAFT' || first.link.completedAt) throw new ConflictException('Your application was already sent to Safety.');
  await onboardingLimit(this.db, `driver-document:${first.link.id}`, 30);
  const body = await scanPdf(dto.pages), id = randomUUID(), driverId = first.driver.id;
  await this.storage.put(driverDocumentKey(driverId, id), body, 'application/pdf');
  let result;
  try {
   result = await this.db.transaction(async em => {
    const { link, application } = await this.session(em, req, true);
    if (application.status !== 'DRAFT' || link.completedAt) throw new ConflictException('Your application was already sent to Safety.');
    const documents = em.getRepository(DriverDocument);
    const previous = await documents.findOneBy({ driverId, kind, replacedAt: IsNull() });
    if (previous) await documents.update(previous.id, { replacedAt: new Date() });
    await documents.insert({ id, driverId, kind, subtype: dto.subtype ?? null, pageCount: dto.pages.length, sha256: sha256(body), byteSize: body.length, createdAt: new Date() });
    await em.getRepository(DriverEvent).save({ driverId, actorId: null, event: 'DOCUMENT_UPLOADED', metadata: { kind, pages: dto.pages.length } });
    return { view: await this.view(em, link, application), previous };
   });
  } catch (error) { await this.storage.remove(driverDocumentKey(driverId, id)); throw error; }
  if (result.previous && !result.previous.verifiedAt) await this.storage.remove(driverDocumentKey(driverId, result.previous.id));
  return result.view;
 }

 /** The driver's own current scan, as a PDF. */
 async documentFile(req: Request, id: string): Promise<FileResult> {
  const { driver } = await this.session(this.db.manager, req, false);
  const document = await this.db.getRepository(DriverDocument).findOneBy({ id, driverId: driver.id, replacedAt: IsNull() });
  if (!document) throw new NotFoundException();
  return { body: await this.storage.get(driverDocumentKey(driver.id, id)), type: 'application/pdf', filename: `${document.kind.toLowerCase().replace(/_/g, '-')}.pdf` };
 }

 /**
  * The verified link, its driver and application. With lock, takes the driver row first, like every staff write. Also used
  * by ConsentService for the driver's consent forms.
  */
 async session(em: EntityManager, req: Request, lock: boolean) {
  const linkId = req.session?.driverLinkId;
  if (!linkId || !req.session.expiresAt || req.session.expiresAt <= Date.now()) throw new UnauthorizedException('Please verify your email again.');
  const first = await em.getRepository(DriverLink).findOneBy({ id: linkId });
  if (!first) throw new UnauthorizedException('Please verify your email again.');
  const driver = await em.getRepository(Driver).findOne({ where: { id: first.driverId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  const link = lock ? await em.getRepository(DriverLink).findOneByOrFail({ id: linkId }) : first;
  const application = await em.getRepository(DriverApplication).findOne({ where: { driverId: first.driverId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  // A submitted application stays readable for the rest of the session while it is still the one sent (Safety reopening
  // it as a draft ends that access); anything else needs an open link.
  if (!driver || !application || link.revokedAt || (link.completedAt ? application.status !== 'SUBMITTED' : !this.open(link) || driver.status !== 'APPLYING')) throw new UnauthorizedException('This application link is no longer available. Please contact Safety.');
  return { link, driver, application };
 }
 private open(link: DriverLink) { return !link.revokedAt && !link.completedAt && link.expiresAt.getTime() > Date.now(); }
 private clean(fields: DriverApplicationFields): DriverApplicationFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === 'string' && value !== '')) as DriverApplicationFields;
 }
 /** What the driver's page shows; ConsentService returns it after a signature. */
 async view(em: EntityManager, link: DriverLink, application: DriverApplication) {
  const documents = await em.getRepository(DriverDocument).find({ where: { driverId: application.driverId, replacedAt: IsNull() }, order: { createdAt: 'ASC' } });
  const consents = await consentStatus(em, application.driverId, this.storage.enabled);
  return { email: link.email, expiresAt: link.expiresAt, status: application.status, fields: application.fields, version: application.version,
   ssnLast4: application.ssnLast4, submittedAt: application.submittedAt, ssnAvailable: this.pii.enabled,
   // What Safety asked the driver to correct, while the application is back with them.
   correction: application.status === 'DRAFT' && application.correctionNote ? { message: application.correctionNote, requestedAt: application.correctionRequestedAt } : null,
   documentsEnabled: this.storage.enabled, requiredDocuments: this.storage.enabled ? requiredDriverDocuments(application.fields) : [],
   documents: documents.map(document => ({ id: document.id, kind: document.kind, subtype: document.subtype, pageCount: document.pageCount, createdAt: document.createdAt })),
   consents: { required: consents.required, consent: consents.consent, items: consents.items } };
 }
}
