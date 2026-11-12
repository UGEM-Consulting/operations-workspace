import { randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { webOrigins } from '../../config/environment';
import { sha256 } from '../documents/images';
import { onboardingLimit } from '../onboarding/rate-limit';
import { digest } from '../onboarding/verification-code';
import { CURRENT_LAYOUT, driverDocumentKey, StorageService } from '../storage/storage.service';
import { User } from '../users/user.entity';
import { DriverDocumentDto } from './driver-application.dto';
import { driverEvent, isProduction, lockOpenDriver, ownsDriver, revokeOpenLinks, SCREENERS, sentWithApplication, sessionLink, writeDriver } from './driver-records';
import { DocumentVersionDto, RenewalLinkDto, RenewDocumentDto } from './renewal.dto';
import { Driver, DriverApplication, DriverDocument, DriverLink, LEAVABLE, RENEWAL_KINDS, type RenewalKind } from './safety.entity';
import { MAX_SCAN_PAGES, oneUpload, scanPdf, uploadedPdf } from './scan';
import { addDays, usDay } from './screening-rules';

/** How long a renewal link works: until the driver sends the document, Safety cancels it, or this many days pass. */
export const RENEWAL_LINK_DAYS = 7;
export const renewalWords: Record<RenewalKind, string> = { LICENSE: 'driver’s license', MEDICAL_CARD: 'medical card' };
const CLOSED_LINK = 'This link is no longer available. Please contact Safety.';

/**
 * A renewal link for one document, bound to the driver's email, replacing an open one for that document. Safety makes one
 * to send (createdBy), and so does an expiration reminder (createdBy null). The caller holds the driver lock and bumps the
 * version. The raw token is only in the returned URL.
 */
export async function createRenewalLink(em: EntityManager, driver: Driver, kind: RenewalKind, createdBy: string | null, origin: string) {
 const resent = await revokeOpenLinks(em, driver.id, { purpose: 'RENEWAL', documentKind: kind });
 const token = randomBytes(32).toString('hex');
 const link = await em.getRepository(DriverLink).save({ driverId: driver.id, tokenHash: digest(token), email: driver.email!, createdBy, purpose: 'RENEWAL', documentKind: kind,
  expiresAt: new Date(Date.now() + RENEWAL_LINK_DAYS * 86400_000) });
 return { resent, expiresAt: link.expiresAt, url: `${origin}/driver#${token}` };
}

/**
 * Renewing an approved or cleared driver's license or medical card (designed as the Renewing a document group). Safety
 * leads, the Safety manager, administrators and the driver's owner either upload the renewed document with the date
 * printed on it (saved already checked), or send the driver a link to scan only that document, which a person then
 * checks (POST .../documents/:id/verify) or marks as not readable. The earlier scan is kept; the hold counts only checked
 * documents (holds.ts), so a scan waiting for its check lifts nothing.
 */
@Injectable()
export class RenewalService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService, private readonly storage: StorageService) {}

 async upload(user: User, id: string, dto: RenewDocumentDto) {
  if (!this.storage.enabled) throw new ServiceUnavailableException('Uploads aren’t available right now.');
  const today = usDay('latest');
  if (dto.expiresOn < today) throw new BadRequestException(`This date has passed. Check the date printed on the ${renewalWords[dto.kind]}.`);
  if (dto.expiresOn > addDays(today, 3660)) throw new BadRequestException('Check the year of the expiration date.');
  const upload = oneUpload(dto, 'Upload a PDF or photos of each page.');
  // Checked again under the driver lock; this early check keeps someone who'd be refused from storing a file first.
  await this.mayRenew(this.db.manager, user, id);
  await onboardingLimit(this.db, `driver-renewal-upload:${user.id}`, 30, 3600);
  const { body, pageCount } = await uploadedPdf(upload, MAX_SCAN_PAGES);
  const stored = { id: randomUUID(), driverId: id, kind: dto.kind, storageLayout: CURRENT_LAYOUT };
  await this.storage.put(driverDocumentKey(stored), body, 'application/pdf');
  let removable: DriverDocument | null;
  try {
   removable = await writeDriver(this.db, async em => {
    // The version is the one the person saw: a scan the driver sent since bumps it, so it can't be replaced unseen.
    const driver = await this.lockRenewable(em, user, id, dto.version);
    const now = new Date(), replaced = await this.replaceCurrent(em, id, dto.kind, now);
    await em.getRepository(DriverDocument).insert({ ...stored, subtype: null, pageCount, sha256: sha256(body), byteSize: body.length, createdAt: now, verifiedAt: now,
     verifiedBy: user.id, uploadedBy: user.id, number: dto.number || null, expiresOn: dto.expiresOn });
    // The document is renewed, so a link asking the driver for it has nothing left to do.
    const linkCancelled = await revokeOpenLinks(em, id, { purpose: 'RENEWAL', documentKind: dto.kind });
    await em.getRepository(Driver).update(id, { version: driver.version + 1 });
    await driverEvent(em, user.id, id, 'DOCUMENT_RENEWED', { kind: dto.kind, pages: pageCount, ...(linkCancelled ? { linkCancelled } : {}) });
    return replaced;
   });
  } catch (error) { await this.storage.remove(driverDocumentKey(stored)); throw error; }
  if (removable) await this.storage.remove(driverDocumentKey(removable));
  return { id: stored.id };
 }

 /**
  * A link for the driver to scan one document, bound to the email on their record and returned once (in the URL
  * fragment, like the application link). An open link for the same document stops working.
  */
 async sendLink(user: User, id: string, dto: RenewalLinkDto) {
  return writeDriver(this.db, async em => {
   const driver = await this.lockRenewable(em, user, id, dto.version);
   if (!driver.email) throw new BadRequestException('Add the driver’s email first. The link works only with that address.');
   if (!isProduction(this.config) && !driver.email.endsWith('@example.test')) throw new BadRequestException('Outside production, links go only to fictional example.test addresses.');
   const link = await createRenewalLink(em, driver, dto.kind, user.id, webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0]);
   await em.getRepository(Driver).update(id, { version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'RENEWAL_LINK_SENT', { kind: dto.kind, resent: link.resent });
   return { id, version: driver.version + 1, expiresAt: link.expiresAt, url: link.url };
  });
 }

 async cancelLink(user: User, id: string, dto: RenewalLinkDto) {
  return writeDriver(this.db, async em => {
   const driver = await this.lockRenewable(em, user, id, dto.version);
   if (!await revokeOpenLinks(em, id, { purpose: 'RENEWAL', documentKind: dto.kind })) throw new ConflictException('This document has no open renewal link.');
   await em.getRepository(Driver).update(id, { version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'RENEWAL_LINK_CANCELLED', { kind: dto.kind });
   return { id, version: driver.version + 1 };
  });
 }

 /**
  * A renewal scan nobody can read: it is never checked, and Safety sends a new link or uploads the document. Only a scan
  * the driver sent through a renewal link (after their application), never one from the application itself.
  */
 async unreadable(user: User, id: string, documentId: string, dto: DocumentVersionDto) {
  return writeDriver(this.db, async em => {
   const driver = await em.getRepository(Driver).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!driver) throw new NotFoundException('This driver record no longer exists.');
   await this.requireRenewer(em, user, driver);
   const document = await em.getRepository(DriverDocument).findOne({ where: { id: documentId, driverId: id, replacedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
   if (!document) throw new NotFoundException('This document was replaced or no longer exists.');
   if (document.version !== dto.version) throw new ConflictException('Someone else recorded this document at the same time. Reload and try again.');
   if (!(RENEWAL_KINDS as readonly string[]).includes(document.kind) || document.verifiedAt || document.unreadableAt || document.uploadedBy || sentWithApplication(document, await this.submittedAt(em, id)))
    throw new ConflictException('Only a renewal scan the driver sent, waiting for its check, can be marked as not readable.');
   await em.getRepository(DriverDocument).update(documentId, { unreadableAt: new Date(), unreadableBy: user.id, version: document.version + 1 });
   await driverEvent(em, user.id, id, 'DOCUMENT_UNREADABLE', { kind: document.kind });
   return { id: documentId, version: document.version + 1 };
  });
 }

 /** What the driver's renewal page shows: which document, until when, and whether they already sent it. */
 async view(req: Request) {
  const { link } = await this.session(this.db.manager, req, false);
  return this.describe(this.db.manager, link);
 }

 /**
  * The driver sends the photographed pages; they become the current scan, waiting for Safety's check, and the link closes.
  * The driver's version goes up, so a page Safety opened before can't replace the scan without seeing it.
  */
 async send(req: Request, dto: DriverDocumentDto) {
  if (!this.storage.enabled) throw new ServiceUnavailableException('Document uploads aren’t available right now. Please contact Safety.');
  if (dto.subtype) throw new BadRequestException('Only work authorization takes a document type.');
  const first = await this.session(this.db.manager, req, false);
  if (first.link.completedAt) throw new ConflictException('You already sent this document to Safety.');
  await onboardingLimit(this.db, `driver-document:${first.link.id}`, 30);
  const body = await scanPdf(dto.pages), kind = first.link.documentKind!;
  const stored = { id: randomUUID(), driverId: first.driver.id, kind, storageLayout: CURRENT_LAYOUT };
  await this.storage.put(driverDocumentKey(stored), body, 'application/pdf');
  let result;
  try {
   result = await this.db.transaction(async em => {
    const { link, driver } = await this.session(em, req, true);
    if (link.completedAt) throw new ConflictException('You already sent this document to Safety.');
    const now = new Date(), removable = await this.replaceCurrent(em, driver.id, kind, now);
    await em.getRepository(DriverDocument).insert({ ...stored, subtype: null, pageCount: dto.pages.length, sha256: sha256(body), byteSize: body.length, createdAt: now });
    await em.getRepository(DriverLink).update(link.id, { completedAt: now });
    await em.getRepository(Driver).update(driver.id, { version: driver.version + 1 });
    await driverEvent(em, null, driver.id, 'DOCUMENT_UPLOADED', { kind, pages: dto.pages.length, renewal: true });
    return { view: await this.describe(em, { ...link, completedAt: now }), removable };
   });
  } catch (error) { await this.storage.remove(driverDocumentKey(stored)); throw error; }
  if (result.removable) await this.storage.remove(driverDocumentKey(result.removable));
  return result.view;
 }

 /**
  * Marks the current scan of this kind replaced. Returns it when its file may go: a renewal scan nobody checked (waiting
  * or not readable). A checked one, or one the driver sent with their application, is kept.
  */
 private async replaceCurrent(em: EntityManager, driverId: string, kind: RenewalKind, now: Date) {
  const documents = em.getRepository(DriverDocument);
  const current = await documents.findOneBy({ driverId, kind, replacedAt: IsNull() });
  if (!current) return null;
  await documents.update(current.id, { replacedAt: now });
  return current.verifiedAt || sentWithApplication(current, await this.submittedAt(em, driverId)) ? null : current;
 }
 private async submittedAt(em: EntityManager, driverId: string) {
  return (await em.getRepository(DriverApplication).findOneBy({ driverId }))?.submittedAt ?? null;
 }
 /**
  * The verified renewal link and its driver. An open link needs an approved or cleared driver; once the document is sent
  * the page stays readable for the rest of the session, until Safety revokes the link.
  */
 private async session(em: EntityManager, req: Request, lock: boolean) {
  const first = await sessionLink(em, req);
  if (first.purpose !== 'RENEWAL') throw new UnauthorizedException('Please verify your email again.');
  const driver = await em.getRepository(Driver).findOne({ where: { id: first.driverId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  const link = lock ? await em.getRepository(DriverLink).findOneByOrFail({ id: first.id }) : first;
  if (!driver || link.revokedAt || (!link.completedAt && (link.expiresAt.getTime() <= Date.now() || !LEAVABLE.includes(driver.status)))) throw new UnauthorizedException(CLOSED_LINK);
  return { link, driver };
 }
 private async describe(em: EntityManager, link: DriverLink) {
  const document = link.completedAt ? await em.getRepository(DriverDocument).findOneBy({ driverId: link.driverId, kind: link.documentKind!, replacedAt: IsNull() }) : null;
  return { kind: link.documentKind, email: link.email, expiresAt: link.expiresAt, sentAt: link.completedAt, documentsEnabled: this.storage.enabled,
   document: document ? { id: document.id, pageCount: document.pageCount, createdAt: document.createdAt } : null };
 }
 /** Locks the driver (every driver write takes it first) and checks the version, the status and who is asking. */
 private async lockRenewable(em: EntityManager, user: User, id: string, version: number) {
  const driver = await lockOpenDriver(em, id, version);
  await this.requireRenewer(em, user, driver);
  return driver;
 }
 private async requireRenewer(em: EntityManager, user: User, driver: Driver) {
  if (!SCREENERS.includes(user.role) && !await ownsDriver(em, user, driver.id)) throw new ForbiddenException('Only Safety leads, managers and the driver’s Safety contact can renew documents.');
  if (!LEAVABLE.includes(driver.status)) throw new ConflictException('Documents are renewed here once the driver is approved.');
 }
 private async mayRenew(em: EntityManager, user: User, id: string) {
  const driver = await em.getRepository(Driver).findOneBy({ id });
  if (!driver) throw new NotFoundException('This driver record no longer exists.');
  await this.requireRenewer(em, user, driver);
 }
}
