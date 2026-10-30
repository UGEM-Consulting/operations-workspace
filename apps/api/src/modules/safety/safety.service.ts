import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, In, IsNull, Not } from 'typeorm';
import { webOrigins } from '../../config/environment';
import { onboardingLimit } from '../onboarding/rate-limit';
import { digest } from '../onboarding/verification-code';
import type { FileResult } from '../documents/documents.service';
import { driverDocumentKey, StorageService } from '../storage/storage.service';
import { DriverVersionDto, VerifyDocumentDto } from './driver-application.dto';
import { PiiService } from './pii';
import { Role, User, UserStatus } from '../users/user.entity';
import { AssignOwnerDto, CreateDriverDto, ReopenDriverDto, UpdateDriverDto, WithdrawDriverDto } from './safety.dto';
import { driverEvent, lockOpenDriver, ownsDriver, requireScreener, SCREENERS, STALE, writeDriver } from './driver-records';
import { CLOSED_STATUSES, Driver, DriverApplication, DriverDocument, DriverLink, DriverOwner, earliestFinalRejection, OWNABLE, phoneKey, WITHDRAWABLE } from './safety.entity';
import { missingForDecision } from './screening-rules';
/** How long an application link works: until the driver submits, Safety cancels it, or this many days pass. */
export const DRIVER_LINK_DAYS = 14;

const EDITABLE = ['firstName', 'lastName', 'phone', 'email', 'driverType', 'licenseType', 'licenseState', 'experienceYears', 'source', 'notes'] as const;
const person = (alias: string) => `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object('id', ${alias}.id, 'name', ${alias}."firstName" || ' ' || ${alias}."lastName", 'active', ${alias}.status = 'ACTIVE') END`;
const blank = (value: string | null | undefined) => value === undefined ? undefined : value === null || value === '' ? null : value;

/**
 * Driver records for the Safety department. Every Safety role and administrators read all of them (the user may later
 * narrow what each role sees). Safety leads, managers and administrators add leads, edit, withdraw and reopen them and
 * assign the safety staff owner of an approved driver; safety staff edit the drivers they own. Owners are history.
 */
@Injectable()
export class SafetyService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService, private readonly pii: PiiService, private readonly storage: StorageService) {}

 async drivers(status: 'OPEN' | 'CLOSED' | 'ALL' = 'ALL') {
  const items: Record<string, unknown>[] = await this.db.query(`SELECT d.id, d."firstName", d."lastName", d.phone, d.email, d."driverType", d."licenseType", d."licenseState",
    d.status, d.version, d."createdAt", d."closedAt", ${person('l')} AS "safetyLead", ${person('o')} AS owner
   FROM drivers d LEFT JOIN users l ON l.id = d."safetyLeadId"
   LEFT JOIN driver_owners x ON x."driverId" = d.id AND x."endedAt" IS NULL LEFT JOIN users o ON o.id = x."ownerId"
   WHERE ($1 = 'ALL' OR ($1 = 'CLOSED') = (d.status IN ('REJECTED','WITHDRAWN','LEFT')))
   ORDER BY d."createdAt" DESC LIMIT 1000`, [status]);
  return { items };
 }

 async driver(id: string) {
  const [driver] = await this.db.query(`SELECT d.id, d."firstName", d."lastName", d.phone, d.email, d."driverType", d."licenseType", d."licenseState", d."experienceYears",
   d.source, d.notes, d.status, d."statusReason", d."closedAt", d.version, d."createdAt", d."updatedAt", ${person('l')} AS "safetyLead", ${person('c')} AS "addedBy"
   FROM drivers d LEFT JOIN users l ON l.id = d."safetyLeadId" LEFT JOIN users c ON c.id = d."createdBy" WHERE d.id = $1`, [id]);
  if (!driver) throw new NotFoundException('This driver record no longer exists.');
  const [owners, activity, [link], [application], documents, checks, [mvr], reviews] = await Promise.all([
   this.db.query(`SELECT x.id, x."startedAt", x."endedAt", x.reason, ${person('o')} AS owner, CASE WHEN a.id IS NULL THEN NULL ELSE a."firstName" || ' ' || a."lastName" END AS "assignedBy"
    FROM driver_owners x LEFT JOIN users o ON o.id = x."ownerId" LEFT JOIN users a ON a.id = x."actorId" WHERE x."driverId" = $1 ORDER BY x."startedAt" DESC, x."createdAt" DESC`, [id]),
   this.db.query(`SELECT e.id, e.event, e.metadata, e."createdAt", CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS actor
    FROM driver_events e LEFT JOIN users u ON u.id = e."actorId" WHERE e."driverId" = $1 ORDER BY e."createdAt" DESC LIMIT 200`, [id]),
   // The open link (never its token) and the driver's answers; the SSN only as its last four digits.
   this.db.query(`SELECT email, "createdAt", "expiresAt", "openedAt", "expiresAt" <= now() AS expired FROM driver_links WHERE "driverId" = $1 AND "revokedAt" IS NULL AND "completedAt" IS NULL`, [id]),
   this.db.query(`SELECT status, fields, "ssnLast4", version, "submittedAt", "updatedAt", "correctionNote", "correctionRequestedAt" FROM driver_applications WHERE "driverId" = $1`, [id]),
   // Current scans and Safety's check of each.
   this.db.query(`SELECT d.id, d.kind, d.subtype, d."pageCount", d."createdAt", d."verifiedAt", d.number, d.version, to_char(d."expiresOn", 'YYYY-MM-DD') AS "expiresOn",
     CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "verifiedBy"
    FROM driver_documents d LEFT JOIN users u ON u.id = d."verifiedBy" WHERE d."driverId" = $1 AND d."replacedAt" IS NULL ORDER BY d."createdAt"`, [id]),
   // Screening: the Safety lead's checks, the current MVR (never its file here) and the decisions so far, newest first.
   this.db.query(`SELECT c.key, c.result, c.note, c."checkedAt", CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "checkedBy"
    FROM driver_screening_checks c LEFT JOIN users u ON u.id = c."checkedBy" WHERE c."driverId" = $1`, [id]),
   this.db.query(`SELECT r.id, to_char(r."pulledOn", 'YYYY-MM-DD') AS "pulledOn", r."pageCount", r."createdAt", CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "uploadedBy"
    FROM driver_reports r LEFT JOIN users u ON u.id = r."uploadedBy" WHERE r."driverId" = $1 AND r.kind = 'MVR' AND r."replacedAt" IS NULL`, [id]),
   this.db.query(`SELECT r.id, r.action, r.note, r.conditions, to_char(r."noticeSentOn", 'YYYY-MM-DD') AS "noticeSentOn", r."previousStatus", r."newStatus", r."createdAt",
     CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS actor
    FROM driver_reviews r LEFT JOIN users u ON u.id = r."actorId" WHERE r."driverId" = $1 ORDER BY r."createdAt" DESC`, [id]),
  ]);
  const gaps = missingForDecision({ application, checkKeys: checks.map((row: { key: string }) => row.key), hasMvr: !!mvr,
   verifiedKinds: documents.filter((row: { verifiedAt: Date | null }) => row.verifiedAt).map((row: { kind: string }) => row.kind) }, this.storage.enabled);
  // While a pre-adverse notice is out, the first day the rejection can be final.
  const notice = driver.status === 'PRE_ADVERSE' ? reviews.find((row: { action: string }) => row.action === 'PRE_ADVERSE') : null;
  return { ...driver, owner: owners.find((row: { endedAt: Date | null }) => row.endedAt === null)?.owner ?? null, owners, activity, link: link ?? null, application: application ?? null, documents,
   screening: { checks, mvr: mvr ?? null, reviews, missing: gaps, finalRejectionFrom: notice ? earliestFinalRejection(notice.noticeSentOn) : null } };
 }

 /** Active people to pick: Safety leads (and managers, who can act as one) and safety staff owners. */
 async people() {
  const rows: { id: string; name: string; role: Role }[] = await this.db.query(`SELECT id, "firstName" || ' ' || "lastName" AS name, role FROM users
   WHERE status = 'ACTIVE' AND role::text IN ('SAFETY_MANAGER','SAFETY_LEAD','SAFETY_STAFF') ORDER BY lower("firstName"), lower("lastName")`);
  return { leads: rows.filter(row => row.role !== Role.SAFETY_STAFF), staff: rows.filter(row => row.role === Role.SAFETY_STAFF) };
 }

 async create(user: User, dto: CreateDriverDto) {
  requireScreener(user);
  return writeDriver(this.db, async em => {
   const safetyLeadId = dto.safetyLeadId === undefined || dto.safetyLeadId === null
    ? ([Role.SAFETY_LEAD, Role.SAFETY_MANAGER].includes(user.role) ? user.id : null) : await this.safetyLead(em, dto.safetyLeadId);
   const driver = await em.getRepository(Driver).save({ firstName: dto.firstName, lastName: dto.lastName, phone: dto.phone, phoneKey: phoneKey(dto.phone),
    email: dto.email ?? null, driverType: dto.driverType, licenseType: dto.licenseType ?? null, licenseState: dto.licenseState ?? null,
    experienceYears: dto.experienceYears ?? null, source: blank(dto.source) ?? null, notes: blank(dto.notes) ?? null, safetyLeadId, createdBy: user.id });
   await driverEvent(em, user.id, driver.id, 'CREATED', { fields: EDITABLE.filter(field => driver[field] !== null) });
   return { id: driver.id, version: driver.version };
  });
 }

 async update(user: User, id: string, dto: UpdateDriverDto) {
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   await this.requireEditor(em, user, driver);
   const fields: string[] = [];
   const changes: Partial<Driver> = { firstName: dto.firstName, lastName: dto.lastName, phone: dto.phone, email: dto.email, driverType: dto.driverType,
    licenseType: dto.licenseType, licenseState: dto.licenseState, experienceYears: dto.experienceYears, source: blank(dto.source), notes: blank(dto.notes) };
   for (const field of EDITABLE) {
    const value = changes[field];
    if (value !== undefined && value !== driver[field]) { (driver as unknown as Record<string, unknown>)[field] = value; fields.push(field); }
   }
   if (fields.includes('phone')) driver.phoneKey = phoneKey(driver.phone);
   // The open link was bound to the old address, so an email change cancels it.
   const linkCancelled = fields.includes('email') && await this.cancelOpenLink(em, driver);
   if (fields.includes('email')) await this.endSubmittedAccess(em, id);
   let leadChanged = false;
   if (dto.safetyLeadId !== undefined && dto.safetyLeadId !== driver.safetyLeadId) {
    requireScreener(user);
    driver.safetyLeadId = dto.safetyLeadId === null ? null : await this.safetyLead(em, dto.safetyLeadId);
    leadChanged = true;
   }
   if (!fields.length && !leadChanged) return { id, version: driver.version };
   driver.version += 1;
   await em.getRepository(Driver).save(driver);
   if (fields.length) await driverEvent(em, user.id, id, 'UPDATED', { fields });
   if (leadChanged) await driverEvent(em, user.id, id, 'SAFETY_LEAD_CHANGED', {});
   if (linkCancelled) await driverEvent(em, user.id, id, 'LINK_CANCELLED', { emailChanged: true });
   return { id, version: driver.version };
  });
 }

 async withdraw(user: User, id: string, dto: WithdrawDriverDto) {
  requireScreener(user);
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   if (!WITHDRAWABLE.includes(driver.status)) throw new ConflictException('Only a driver who isn’t approved yet can be withdrawn.');
   await em.getRepository(DriverLink).update({ driverId: id, revokedAt: IsNull(), completedAt: IsNull() }, { revokedAt: new Date() });
   await this.endSubmittedAccess(em, id);
   // A withdrawal ends any round of corrections: reopened later, the driver never sees that old message again.
   await em.getRepository(DriverApplication).update({ driverId: id, correctionNote: Not(IsNull()) }, { correctionNote: null, correctionRequestedAt: null });
   await em.getRepository(Driver).update(id, { status: 'WITHDRAWN', statusReason: dto.reason, closedAt: new Date(), version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'WITHDRAWN', { from: driver.status });
   return { id, version: driver.version + 1 };
  });
 }

 /** A withdrawn driver comes back as a lead (their earlier steps are started again). */
 async reopen(user: User, id: string, dto: ReopenDriverDto) {
  requireScreener(user);
  return writeDriver(this.db, async em => {
   const driver = await em.getRepository(Driver).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!driver) throw new NotFoundException('This driver record no longer exists.');
   if (driver.version !== dto.version) throw new ConflictException(STALE);
   if (driver.status !== 'WITHDRAWN') throw new ConflictException('Only a withdrawn driver can be reopened.');
   await em.getRepository(Driver).update(id, { status: 'LEAD', statusReason: null, closedAt: null, version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'REOPENED', {});
   return { id, version: driver.version + 1 };
  });
 }

 async assignOwner(user: User, id: string, dto: AssignOwnerDto) {
  requireScreener(user);
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   if (!OWNABLE.includes(driver.status)) throw new ConflictException('A safety staff owner is assigned once the Safety manager approves the driver.');
   const owner = await em.getRepository(User).findOneBy({ id: dto.ownerId });
   if (!owner || owner.role !== Role.SAFETY_STAFF || owner.status !== UserStatus.ACTIVE) throw new BadRequestException('Choose an active safety staff member.');
   const owners = em.getRepository(DriverOwner);
   const current = await owners.findOneBy({ driverId: id, endedAt: IsNull() });
   if (current?.ownerId === owner.id) throw new BadRequestException('This person already owns the driver.');
   if (current && !dto.reason) throw new BadRequestException('Say why the driver is changing owner.');
   const now = new Date();
   if (current) await owners.update(current.id, { endedAt: now });
   await owners.save({ driverId: id, ownerId: owner.id, startedAt: now, reason: dto.reason || null, actorId: user.id });
   await em.getRepository(Driver).update(id, { version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'OWNER_ASSIGNED', { first: !current });
   return { id, version: driver.version + 1 };
  });
 }

 /**
  * Sends (or resends) the driver's application link, bound to the email on their record; any earlier open link stops
  * working. The token is returned once and travels in the URL fragment, so it never reaches server logs.
  */
 async sendLink(user: User, id: string, dto: DriverVersionDto) {
  requireScreener(user);
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   if (!['LEAD', 'APPLYING'].includes(driver.status)) throw new ConflictException('This driver has already sent their application.');
   const { resent, link, url } = await this.issueLink(em, user, driver);
   await em.getRepository(Driver).update(id, { status: 'APPLYING', version: driver.version + 1 });
   // A driver withdrawn after submitting and reopened as a lead works on the same application again (answers, SSN and
   // scans kept) and submits it anew; otherwise the link would open only "Application sent". A draft has no submittedAt
   // (a CHECK); the earlier submission stays in the APPLICATION_SUBMITTED event.
   const reopened = !!(await em.getRepository(DriverApplication).update({ driverId: id, status: 'SUBMITTED' }, { status: 'DRAFT', submittedAt: null, version: () => 'version + 1' })).affected;
   await driverEvent(em, user.id, id, 'LINK_SENT', { resent, ...(reopened ? { reopened } : {}) });
   return { id, version: driver.version + 1, expiresAt: link.expiresAt, url };
  });
 }

 /**
  * A new link bound to the driver's email, inside the caller's transaction on the locked driver row; any open link and
  * the submitted link's session stop working. The caller sets the driver's status. Used for the first link, a resend and
  * a request for corrections.
  */
 async issueLink(em: EntityManager, user: User, driver: Driver) {
  if (!driver.email) throw new BadRequestException('Add the driver’s email first. The link works only with that address.');
  const production = this.config.get('NODE_ENV') === 'production' || this.config.get('DEPLOYMENT_PURPOSE') === 'production';
  if (!production && !driver.email.endsWith('@example.test')) throw new BadRequestException('Outside production, links go only to fictional example.test addresses.');
  const resent = await this.cancelOpenLink(em, driver);
  await this.endSubmittedAccess(em, driver.id);
  const token = randomBytes(32).toString('hex');
  const link = await em.getRepository(DriverLink).save({ driverId: driver.id, tokenHash: digest(token), email: driver.email, createdBy: user.id, expiresAt: new Date(Date.now() + DRIVER_LINK_DAYS * 86400_000) });
  return { resent, link, url: `${webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0]}/driver#${token}` };
 }

 /** Stops the open link; a driver who hasn't submitted goes back to being a lead. Their saved answers are kept. */
 async cancelLink(user: User, id: string, dto: DriverVersionDto) {
  requireScreener(user);
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   if (!await this.cancelOpenLink(em, driver)) throw new ConflictException('This driver has no open application link.');
   await em.getRepository(Driver).update(id, { status: driver.status, version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'LINK_CANCELLED', {});
   return { id, version: driver.version + 1 };
  });
 }

 /** The full SSN, for Safety leads, managers, administrators and the driver's owner. Every view is recorded. */
 async revealSsn(user: User, id: string) {
  if (!SCREENERS.includes(user.role) && !await ownsDriver(this.db.manager, user, id))
   throw new ForbiddenException('Only Safety leads, managers and the driver’s owner can view the full number.');
  await onboardingLimit(this.db, `ssn-reveal:${user.id}`, 30, 3600);
  const application = await this.db.getRepository(DriverApplication).createQueryBuilder('a').addSelect('a.ssnCiphertext').where('a."driverId" = :id', { id }).getOne();
  if (!application?.ssnCiphertext) throw new NotFoundException('No Social Security number on file.');
  const ssn = this.pii.openSsn(application.ssnCiphertext, id);
  await driverEvent(this.db.manager, user.id, id, 'SSN_REVEALED', {});
  return { ssn };
 }

 /**
  * A driver's current scan, for every Safety role. These are identity documents, so views are rate-limited and each
  * one is recorded (DOCUMENT_VIEWED, kind only), like a revealed SSN.
  */
 async documentFile(user: User, id: string, documentId: string): Promise<FileResult> {
  await onboardingLimit(this.db, `driver-document-view:${user.id}`, 60, 900);
  const document = await this.db.getRepository(DriverDocument).findOneBy({ id: documentId, driverId: id, replacedAt: IsNull() });
  if (!document) throw new NotFoundException('This document was replaced or no longer exists.');
  const body = await this.storage.get(driverDocumentKey(id, documentId));
  await driverEvent(this.db.manager, user.id, id, 'DOCUMENT_VIEWED', { kind: document.kind });
  return { body, type: 'application/pdf', filename: `${document.kind.toLowerCase().replace(/_/g, '-')}.pdf` };
 }

 /**
  * Records what Safety read on a submitted scan (no OCR; a person types it): the expiry date, required for a license or
  * medical card, and the number, never for work authorization (its expiry is enough, and passport or A-numbers stay out
  * of the record). Screeners and the driver's owner may verify, and may correct an earlier entry against its version.
  */
 async verifyDocument(user: User, id: string, documentId: string, dto: VerifyDocumentDto) {
  return writeDriver(this.db, async em => {
   const driver = await em.getRepository(Driver).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!driver) throw new NotFoundException('This driver record no longer exists.');
   // Checked under the driver lock, so an owner change can't land between the check and the write.
   if (!SCREENERS.includes(user.role) && !await ownsDriver(em, user, id))
    throw new ForbiddenException('Only Safety leads, managers and the driver’s owner can verify documents.');
   if (CLOSED_STATUSES.includes(driver.status)) throw new ConflictException('This driver record is closed and can’t be changed.');
   if (!await em.getRepository(DriverApplication).existsBy({ driverId: id, status: 'SUBMITTED' })) throw new ConflictException('Documents are verified once the driver submits their application.');
   const document = await em.getRepository(DriverDocument).findOne({ where: { id: documentId, driverId: id, replacedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
   if (!document) throw new NotFoundException('This document was replaced or no longer exists.');
   if (document.version !== dto.version) throw new ConflictException('Someone else recorded this document at the same time. Reload and try again.');
   if (document.kind === 'WORK_AUTHORIZATION' && dto.number) throw new BadRequestException('Don’t record the number of a work authorization document. Its expiration date is enough.');
   if (document.kind !== 'WORK_AUTHORIZATION' && !dto.expiresOn) throw new BadRequestException('Enter the expiration date shown on the document.');
   await em.getRepository(DriverDocument).update(documentId, { verifiedAt: new Date(), verifiedBy: user.id, number: dto.number || null, expiresOn: dto.expiresOn || null, version: document.version + 1 });
   await driverEvent(em, user.id, id, 'DOCUMENT_VERIFIED', { kind: document.kind, again: document.verifiedAt !== null });
   return { id: documentId, version: document.version + 1 };
  });
 }

 /** Revokes the open link, if any; an applying driver goes back to LEAD on the entity passed in (the caller saves it). */
 private async cancelOpenLink(em: EntityManager, driver: Driver) {
  const result = await em.getRepository(DriverLink).update({ driverId: driver.id, revokedAt: IsNull(), completedAt: IsNull() }, { revokedAt: new Date() });
  if (!result.affected) return false;
  if (driver.status === 'APPLYING') driver.status = 'LEAD';
  return true;
 }
 /**
  * Revokes the links the driver already submitted through: that browser session can still read the sent application for
  * up to an hour, which must stop once Safety withdraws the driver, changes the bound email or reopens the application.
  */
 private async endSubmittedAccess(em: EntityManager, driverId: string) {
  await em.getRepository(DriverLink).update({ driverId, revokedAt: IsNull(), completedAt: Not(IsNull()) }, { revokedAt: new Date() });
 }
 private async requireEditor(em: EntityManager, user: User, driver: Driver) {
  if (SCREENERS.includes(user.role)) return;
  if (!await ownsDriver(em, user, driver.id)) throw new ForbiddenException('Safety staff can change only the drivers they own.');
 }
 private async safetyLead(em: EntityManager, id: string) {
  const lead = await em.getRepository(User).findOneBy({ id, role: In([Role.SAFETY_LEAD, Role.SAFETY_MANAGER]), status: UserStatus.ACTIVE });
  if (!lead) throw new BadRequestException('Choose an active Safety lead or manager.');
  return lead.id;
 }
}
