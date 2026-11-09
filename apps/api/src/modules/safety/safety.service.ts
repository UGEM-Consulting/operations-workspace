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
import { AssignOwnerDto, CreateDriverDto, MarkLeftDto, ReopenDriverDto, UpdateDriverDto, WithdrawDriverDto } from './safety.dto';
import { driverEvent, isProduction, lockOpenDriver, ownsDriver, requireScreener, revokeOpenLinks, SCREENERS, sentWithApplication, STALE, writeDriver } from './driver-records';
import { CLOSED_STATUSES, Driver, DriverAssignment, DriverApplication, DriverDocument, DriverLink, DriverOwner, type DriverStatus, earliestFinalRejection, LEAVABLE, NOT_RECHECKED, OWNABLE, phoneKey, RENEWAL_KINDS, type RenewalKind, WITHDRAWABLE } from './safety.entity';
import { currentConsents, missingConsents } from './consent-rules';
import { addDays, missingForDecision, usDay } from './screening-rules';
import { CLEARERS, clearanceGaps, hasActiveOwner } from './clearance.service';
import { driverReminded, renewalScanWhere } from './reminded';
/** How long an application link works: until the driver submits, Safety cancels it, or this many days pass. */
export const DRIVER_LINK_DAYS = 14;
/** Scans are listed as expiring this many days before their expiration date. */
export const EXPIRY_WARNING_DAYS = 60;

const EDITABLE = ['firstName', 'lastName', 'phone', 'email', 'driverType', 'licenseType', 'licenseState', 'experienceYears', 'source', 'notes'] as const;
const person = (alias: string) => `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object('id', ${alias}.id, 'name', ${alias}."firstName" || ' ' || ${alias}."lastName", 'active', ${alias}.status = 'ACTIVE') END`;
/**
 * What Expiring documents lists (expiring() and expiringCount()), with $1 the last day listed: each open driver's latest
 * checked scan of each kind, like the hold (a renewal waiting for its check leaves the expired one listed), and current
 * owner-operator truck documents. A US passport or green card never shows: it isn't re-checked (NOT_RECHECKED).
 */
const EXPIRING = `FROM (
    (SELECT DISTINCT ON (d."driverId", d.kind) d.id AS "documentId", d."driverId", d.kind, to_char(d."expiresOn", 'YYYY-MM-DD') AS "expiresOn", NULL::text AS truck, d.subtype
    FROM driver_documents d WHERE d."verifiedAt" IS NOT NULL ORDER BY d."driverId", d.kind, d."createdAt" DESC)
    UNION ALL
    SELECT o.id, o."driverId", o.kind, to_char(o."expiresOn", 'YYYY-MM-DD'), t.unit, NULL
    FROM driver_owner_documents o JOIN driver_trucks t ON t.id = o."truckId" WHERE o."replacedAt" IS NULL AND o."expiresOn" IS NOT NULL AND t."archivedAt" IS NULL
   ) e JOIN drivers x ON x.id = e."driverId"
   LEFT JOIN driver_owners w ON w."driverId" = x.id AND w."endedAt" IS NULL LEFT JOIN users o ON o.id = w."ownerId"
   WHERE e."expiresOn" <= $1 AND x.status NOT IN ('REJECTED','WITHDRAWN','LEFT') AND (e.subtype IS NULL OR e.subtype NOT IN ('US_PASSPORT','GREEN_CARD'))`;
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

 /**
  * Verified scans (license, medical card, work authorization) of drivers whose records are still open and whose
  * expiration date has passed or falls within EXPIRY_WARNING_DAYS (Eastern date), soonest first. Dates only: never numbers.
  */
 async expiring() {
  const today = usDay('latest');
  const items: Record<string, unknown>[] = await this.db.query(`SELECT e."documentId", e."driverId", e.kind, e."expiresOn", e.truck, x."firstName", x."lastName", x.status, x.version,
    x.email, ${person('o')} AS owner ${EXPIRING} ORDER BY e."expiresOn", x."lastName"`, [addDays(today, EXPIRY_WARNING_DAYS)]);
  // Licenses and medical cards of approved and cleared drivers show where their renewal stands.
  const renewable = items.filter(item => LEAVABLE.includes(item.status as DriverStatus) && (RENEWAL_KINDS as readonly unknown[]).includes(item.kind) && item.truck === null);
  const renewals = await this.renewals([...new Set(renewable.map(item => item.driverId as string))]);
  const renewal = (item: Record<string, unknown>) => {
   if (!renewable.includes(item)) return null;
   const row = renewals.find(entry => entry.driverId === item.driverId && entry.kind === item.kind);
   return row ? { link: row.link, scan: row.scan } : null;
  };
  // How each driver was last reminded about their own license or medical card (drivers get no others).
  const reminded = await driverReminded(this.db.manager, renewable.map(item => item.documentId as string));
  return { today, warningDays: EXPIRY_WARNING_DAYS, items: items.map(item => ({ ...item, expiresOn: item.expiresOn as string, expired: (item.expiresOn as string) < today, renewal: renewal(item), reminded: reminded.get(item.documentId as string) ?? null })) };
 }
 /** For the sidebar: the same documents, counted, without the details the page shows. */
 async expiringCount(): Promise<number> {
  const [row] = await this.db.query(`SELECT count(*)::int AS n ${EXPIRING}`, [addDays(usDay('latest'), EXPIRY_WARNING_DAYS)]) as { n: number }[];
  return row.n;
 }

 /**
  * Where renewing each driver's license and medical card stands (RENEWAL_KINDS): the latest checked one (the one the
  * hold counts), an open renewal link (never its token), and a scan the driver sent through a renewal link that waits for
  * its check or that nobody could read (never a scan from their application: sentWithApplication).
  */
 private async renewals(driverIds: string[]): Promise<{ driverId: string; kind: RenewalKind; checked: { id: string; expiresOn: string | null; current: boolean } | null;
  link: { createdAt: string; expiresAt: string; openedAt: string | null; expired: boolean; fromReminder: boolean } | null; scan: { id: string; version: number; pageCount: number; createdAt: string; unreadable: boolean } | null }[]> {
  if (!driverIds.length) return [];
  return this.db.query(`SELECT x."driverId", k.kind,
    (SELECT json_build_object('id', c.id, 'expiresOn', to_char(c."expiresOn", 'YYYY-MM-DD'), 'current', c."replacedAt" IS NULL) FROM driver_documents c
     WHERE c."driverId" = x."driverId" AND c.kind = k.kind AND c."verifiedAt" IS NOT NULL ORDER BY c."createdAt" DESC LIMIT 1) AS checked,
    (SELECT json_build_object('createdAt', l."createdAt", 'expiresAt', l."expiresAt", 'openedAt', l."openedAt", 'expired', l."expiresAt" <= now(), 'fromReminder', l."createdBy" IS NULL) FROM driver_links l
     WHERE l."driverId" = x."driverId" AND l.purpose = 'RENEWAL' AND l."documentKind" = k.kind AND l."revokedAt" IS NULL AND l."completedAt" IS NULL) AS link,
    (SELECT json_build_object('id', n.id, 'version', n.version, 'pageCount', n."pageCount", 'createdAt', n."createdAt", 'unreadable', n."unreadableAt" IS NOT NULL) FROM driver_documents n
     WHERE ${renewalScanWhere('x."driverId"', 'k.kind')}) AS scan
   FROM unnest($1::uuid[]) x("driverId") CROSS JOIN (VALUES ('LICENSE'), ('MEDICAL_CARD')) k(kind)`, [driverIds]);
 }

 async driver(id: string) {
  const [driver] = await this.db.query(`SELECT d.id, d."firstName", d."lastName", d.phone, d.email, d."driverType", d."licenseType", d."licenseState", d."experienceYears",
   d.source, d.notes, d.status, d."statusReason", d."closedAt", d.version, d."createdAt", d."updatedAt", ${person('l')} AS "safetyLead", ${person('c')} AS "addedBy",
   d."clearedAt", ${person('k')} AS "clearedBy"
   FROM drivers d LEFT JOIN users l ON l.id = d."safetyLeadId" LEFT JOIN users c ON c.id = d."createdBy" LEFT JOIN users k ON k.id = d."clearedBy" WHERE d.id = $1`, [id]);
  if (!driver) throw new NotFoundException('This driver record no longer exists.');
  const [owners, activity, [link], [application], documents, checks, [mvr], reviews, consents, currentForms, clearanceItems, employers, assignments, activeOwner, renewals] = await Promise.all([
   this.db.query(`SELECT x.id, x."startedAt", x."endedAt", x.reason, ${person('o')} AS owner, CASE WHEN a.id IS NULL THEN NULL ELSE a."firstName" || ' ' || a."lastName" END AS "assignedBy"
    FROM driver_owners x LEFT JOIN users o ON o.id = x."ownerId" LEFT JOIN users a ON a.id = x."actorId" WHERE x."driverId" = $1 ORDER BY x."startedAt" DESC, x."createdAt" DESC`, [id]),
   this.db.query(`SELECT e.id, e.event, e.metadata, e."createdAt", CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS actor
    FROM driver_events e LEFT JOIN users u ON u.id = e."actorId" WHERE e."driverId" = $1 ORDER BY e."createdAt" DESC LIMIT 200`, [id]),
   // The open link (never its token) and the driver's answers; the SSN only as its last four digits.
   this.db.query(`SELECT email, "createdAt", "expiresAt", "openedAt", "expiresAt" <= now() AS expired FROM driver_links WHERE "driverId" = $1 AND purpose = 'APPLICATION' AND "revokedAt" IS NULL AND "completedAt" IS NULL`, [id]),
   this.db.query(`SELECT status, fields, history, "ssnLast4", version, "submittedAt", "updatedAt", "correctionNote", "correctionRequestedAt" FROM driver_applications WHERE "driverId" = $1`, [id]),
   // Current scans and Safety's check of each.
   // A renewal Safety uploaded is marked (uploadedBySafety), and one nobody could read carries unreadableAt.
   this.db.query(`SELECT d.id, d.kind, d.subtype, d."pageCount", d."createdAt", d."verifiedAt", d.number, d.version, to_char(d."expiresOn", 'YYYY-MM-DD') AS "expiresOn",
     CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "verifiedBy", d."uploadedBy" IS NOT NULL AS "uploadedBySafety", d."unreadableAt"
    FROM driver_documents d LEFT JOIN users u ON u.id = d."verifiedBy" WHERE d."driverId" = $1 AND d."replacedAt" IS NULL ORDER BY d."createdAt"`, [id]),
   // Screening: the Safety lead's checks, the current MVR (never its file here) and the decisions so far, newest first.
   this.db.query(`SELECT c.key, c.result, c.note, c."checkedAt", CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "checkedBy"
    FROM driver_screening_checks c LEFT JOIN users u ON u.id = c."checkedBy" WHERE c."driverId" = $1`, [id]),
   this.db.query(`SELECT r.id, to_char(r."pulledOn", 'YYYY-MM-DD') AS "pulledOn", r."pageCount", r."createdAt", r."authorization", CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "uploadedBy"
    FROM driver_reports r LEFT JOIN users u ON u.id = r."uploadedBy" WHERE r."driverId" = $1 AND r.kind = 'MVR' AND r."replacedAt" IS NULL`, [id]),
   this.db.query(`SELECT r.id, r.action, r.note, r.conditions, to_char(r."noticeSentOn", 'YYYY-MM-DD') AS "noticeSentOn", r."previousStatus", r."newStatus", r."createdAt",
     CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS actor
    FROM driver_reviews r LEFT JOIN users u ON u.id = r."actorId" WHERE r."driverId" = $1 ORDER BY r."createdAt" DESC`, [id]),
   // Consent forms the driver signed (newest version first per form) and the published ones still to sign.
   // hasSignature is false for a form that is only acknowledged (the background check disclosure).
   this.db.query(`SELECT s."documentId", d.kind, d.title, d.version, s."typedName", s."signedAt", s."signatureImage" IS NOT NULL AS "hasSignature" FROM driver_consent_signatures s
    JOIN driver_consent_documents d ON d.id = s."documentId" WHERE s."driverId" = $1 ORDER BY d.kind, d.version DESC`, [id]),
   this.storage.enabled ? currentConsents(this.db.manager) : [],
   // Clearance: results only (no drug test or medical details are entered), the employers asked, and where Dispatch placed the driver.
   this.db.query(`SELECT c.key, c.status, c.result, to_char(c."doneOn", 'YYYY-MM-DD') AS "doneOn", c.note, c."updatedAt", CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "updatedBy"
    FROM driver_clearance_items c LEFT JOIN users u ON u.id = c."updatedBy" WHERE c."driverId" = $1`, [id]),
   this.db.query(`SELECT id, name, "fromMonth", "toMonth", source, location, phone, to_char("requestedOn", 'YYYY-MM-DD') AS "requestedOn", to_char("answeredOn", 'YYYY-MM-DD') AS "answeredOn",
     to_char("goodFaithOn", 'YYYY-MM-DD') AS "goodFaithOn", "goodFaithNote"
    FROM driver_previous_employers WHERE "driverId" = $1 ORDER BY "toMonth" DESC, "createdAt"`, [id]),
   this.db.query(`SELECT a.id, a."startedAt", a."endedAt", a.truck, m.name AS mc, t.name AS team, x."firstName" || ' ' || x."lastName" AS dispatcher
    FROM driver_assignments a JOIN mcs m ON m.id = a."mcId" JOIN dispatch_members x ON x.id = a."memberId"
    LEFT JOIN member_assignments ma ON ma."memberId" = x.id AND ma."endedAt" IS NULL LEFT JOIN teams t ON t.id = ma."teamId"
    WHERE a."driverId" = $1 ORDER BY a."startedAt" DESC, a."createdAt" DESC`, [id]),
   hasActiveOwner(this.db.manager, id),
   this.renewals([id]),
  ]);
  const consentsMissing = missingConsents(currentForms, consents.map((row: { documentId: string }) => row.documentId));
  const gaps = missingForDecision({ application, checkKeys: checks.map((row: { key: string }) => row.key), hasMvr: !!mvr,
   verifiedKinds: documents.filter((row: { verifiedAt: Date | null }) => row.verifiedAt).map((row: { kind: string }) => row.kind) }, this.storage.enabled);
  // While a pre-adverse notice is out, the first day the rejection can be final.
  const notice = driver.status === 'PRE_ADVERSE' ? reviews.find((row: { action: string }) => row.action === 'PRE_ADVERSE') : null;
  const owner = owners.find((row: { endedAt: Date | null }) => row.endedAt === null)?.owner ?? null;
  return { ...driver, owner, owners, activity, link: link ?? null, application: application ?? null, documents, renewals,
   clearance: { items: clearanceItems, employers, missing: clearanceGaps(clearanceItems, activeOwner, employers, driver) }, assignments,
   screening: { checks, mvr: mvr ?? null, reviews, missing: gaps, finalRejectionFrom: notice ? earliestFinalRejection(notice.noticeSentOn) : null },
   consents: { signatures: consents, missing: consentsMissing, authorizationSigned: consents.some((row: { kind: string }) => row.kind === 'BACKGROUND_AUTHORIZATION') } };
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
   const linkCancelled = fields.includes('email') && await this.cancelOpenLink(em, driver, true);
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

 /**
  * Marks an approved or cleared driver as Left on their last day. The Safety manager, administrators and the driver's
  * current owner may. The record closes (nothing else changes on it), the current owner and dispatch assignment end that
  * day, and the dispatcher stops counting the driver. The phone and email are free again for a new lead.
  */
 async markLeft(user: User, id: string, dto: MarkLeftDto) {
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   if (!CLEARERS.includes(user.role) && !await ownsDriver(em, user, id)) throw new ForbiddenException('Only the driver’s Safety contact and the Safety manager can mark a driver as left.');
   if (!LEAVABLE.includes(driver.status)) throw new ConflictException('Only an approved or cleared driver can be marked as left.');
   if (dto.leftOn > usDay('latest')) throw new BadRequestException('The last day can’t be in the future.');
   if (dto.leftOn < '1980-01-01') throw new BadRequestException('Enter the last day they worked.');
   if (driver.clearedAt && dto.leftOn < usDay('latest', driver.clearedAt)) throw new BadRequestException('The last day can’t be before the driver was cleared.');
   const closedAt = new Date(`${dto.leftOn}T12:00:00Z`);
   // A change dated the same day as the period it ends starts one millisecond after it (the database keeps microseconds).
   const end = (startedAt: Date) => new Date(Math.max(closedAt.getTime(), startedAt.getTime() + 1));
   const assignments = em.getRepository(DriverAssignment), owners = em.getRepository(DriverOwner);
   const assignment = await assignments.findOneBy({ driverId: id, endedAt: IsNull() });
   if (assignment) await assignments.update(assignment.id, { endedAt: end(assignment.startedAt) });
   const owner = await owners.findOneBy({ driverId: id, endedAt: IsNull() });
   if (owner) await owners.update(owner.id, { endedAt: end(owner.startedAt) });
   await em.getRepository(DriverLink).update({ driverId: id, revokedAt: IsNull() }, { revokedAt: new Date() });
   // Their trucks are archived with them (kept for history), so the VIN is free for whoever drives the truck next.
   const [, archived] = await em.query(`UPDATE driver_trucks SET "archivedAt" = now(), "updatedAt" = now() WHERE "driverId" = $1 AND "archivedAt" IS NULL`, [id]) as [unknown, number];
   await em.getRepository(Driver).update(id, { status: 'LEFT', statusReason: dto.reason, closedAt, version: driver.version + 1 });
   // Field names and flags only, never the reason or the date.
   await driverEvent(em, user.id, id, 'LEFT', { from: driver.status, assignmentEnded: !!assignment, trucksArchived: archived > 0 });
   return { id, version: driver.version + 1 };
  });
 }

 async assignOwner(user: User, id: string, dto: AssignOwnerDto) {
  requireScreener(user);
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   if (!OWNABLE.includes(driver.status)) throw new ConflictException('A Safety contact is assigned once the Safety manager approves the driver.');
   const owner = await em.getRepository(User).findOneBy({ id: dto.ownerId });
   if (!owner || owner.role !== Role.SAFETY_STAFF || owner.status !== UserStatus.ACTIVE) throw new BadRequestException('Choose an active safety staff member.');
   const owners = em.getRepository(DriverOwner);
   const current = await owners.findOneBy({ driverId: id, endedAt: IsNull() });
   if (current?.ownerId === owner.id) throw new BadRequestException('This person is already the driver’s Safety contact.');
   if (current && !dto.reason) throw new BadRequestException('Say why the driver’s Safety contact is changing.');
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
  if (!isProduction(this.config) && !driver.email.endsWith('@example.test')) throw new BadRequestException('Outside production, links go only to fictional example.test addresses.');
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
   throw new ForbiddenException('Only Safety leads, managers and the driver’s Safety contact can view the full number.');
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
  const body = await this.storage.get(driverDocumentKey(document));
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
    throw new ForbiddenException('Only Safety leads, managers and the driver’s Safety contact can verify documents.');
   if (CLOSED_STATUSES.includes(driver.status)) throw new ConflictException('This driver record is closed and can’t be changed.');
   const application = await em.getRepository(DriverApplication).findOneBy({ driverId: id, status: 'SUBMITTED' });
   if (!application) throw new ConflictException('Documents are verified once the driver submits their application.');
   const document = await em.getRepository(DriverDocument).findOne({ where: { id: documentId, driverId: id, replacedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
   if (!document) throw new NotFoundException('This document was replaced or no longer exists.');
   if (document.version !== dto.version) throw new ConflictException('Someone else recorded this document at the same time. Reload and try again.');
   if (document.unreadableAt) throw new ConflictException('This scan was marked as not readable. Send the driver a new link or upload the document.');
   if (document.kind === 'WORK_AUTHORIZATION' && dto.number) throw new BadRequestException('Don’t record the number of a work authorization document. Its expiration date is enough.');
   if (document.kind !== 'WORK_AUTHORIZATION' && !dto.expiresOn) throw new BadRequestException('Enter the expiration date shown on the document.');
   // A renewal the driver scanned must still be valid: a past date means they photographed the old one, which stays
   // unchecked so Safety can mark it as not readable and send a new link (screening still records any date it reads).
   const renewalScan = !document.verifiedAt && !document.uploadedBy && (RENEWAL_KINDS as readonly string[]).includes(document.kind) && !sentWithApplication(document, application.submittedAt);
   if (renewalScan && dto.expiresOn! < usDay('latest')) throw new BadRequestException('This date has passed, so it isn’t the renewed document. Mark the scan as not readable and send a new link.');
   // A work authorization's type can be corrected (the driver still chose what to give). A US passport or green card
   // isn't re-checked when it expires (Form I-9), so it keeps no date and never shows in Expiring documents.
   if (dto.subtype && document.kind !== 'WORK_AUTHORIZATION') throw new BadRequestException('Only a work authorization has a document type.');
   const subtype = document.kind === 'WORK_AUTHORIZATION' ? dto.subtype ?? document.subtype : null;
   const expiresOn = subtype && NOT_RECHECKED.includes(subtype) ? null : dto.expiresOn || null;
   // A work permit is re-checked before it runs out, so it can't be checked without its date.
   if (subtype === 'WORK_PERMIT' && !expiresOn) throw new BadRequestException('Enter the expiration date printed on the work permit.');
   await em.getRepository(DriverDocument).update(documentId, { verifiedAt: new Date(), verifiedBy: user.id, number: dto.number || null, expiresOn, subtype, version: document.version + 1 });
   await driverEvent(em, user.id, id, 'DOCUMENT_VERIFIED', { kind: document.kind, again: document.verifiedAt !== null, ...(subtype !== document.subtype ? { typeChanged: true } : {}) });
   return { id: documentId, version: document.version + 1 };
  });
 }

 /**
  * Revokes the open application link, if any (with all, renewal links too: they are bound to the same email); an applying
  * driver goes back to LEAD on the entity passed in (the caller saves it).
  */
 private async cancelOpenLink(em: EntityManager, driver: Driver, all = false) {
  if (!await revokeOpenLinks(em, driver.id, all ? {} : { purpose: 'APPLICATION' })) return false;
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
