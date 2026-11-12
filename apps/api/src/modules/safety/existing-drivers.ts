import { randomBytes, randomUUID } from 'node:crypto';
import { Type } from 'class-transformer';
import { isEmail, ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { webOrigins } from '../../config/environment';
import type { FileResult } from '../documents/documents.service';
import { sha256 } from '../documents/images';
import { fileDate } from '../dispatch/existing.service';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { lockTeam, onLeave, onLeaveSql, onNotice } from '../dispatch/create-member';
import { DispatchMember, MemberAssignment } from '../dispatch/dispatch.entity';
import { digest } from '../onboarding/verification-code';
import { onboardingLimit } from '../onboarding/rate-limit';
import { CURRENT_LAYOUT, driverDocumentKey, StorageService } from '../storage/storage.service';
import type { User } from '../users/user.entity';
import { consentStatus } from './consent-rules';
import { DECIDERS, driverEvent, lockOpenDriver, mayEmail, requireMayEmail, ownsDriver, revokeOpenLinks, sessionLink, writeDriver } from './driver-records';
import { DriverDocumentDto } from './driver-application.dto';
import { driverLicenseRules, licenseRules } from './license-rules';
import { NoSsn } from './pii';
import { hiddenItems, resultKeySql } from './results';
import { DOCUMENT_SEGMENTS, Driver, DriverDocument, DriverLink, LEAVABLE, phoneKey, US_STATES, type DriverDocumentKind, type LicenseType, type WorkAuthorizationType } from './safety.entity';
import { scanPdf } from './scan';
import { usDay } from './screening-rules';
import { addChoice, cell, fold, summary, type ImportChoice, type ImportRow } from './units-import';
import { personName } from './sql';

/** How long a catch-up link works: until the driver sends their documents, Safety cancels it, or this many days pass. */
export const CATCH_UP_DAYS = 14;
const EXISTING_DRIVERS_LOCK = 42002041;
const CATCH_UP_KINDS: DriverDocumentKind[] = ['LICENSE', 'MEDICAL_CARD', 'WORK_AUTHORIZATION'];
const CLOSED_LINK = 'This link is no longer available. Please contact Safety.';

/** One driver from the file or the form, as text; every value is checked here, row by row. */
export class ExistingDriverRowDto {
 @IsInt() @Min(1) row!: number;
 @cell() firstName?: string; @cell() lastName?: string; @cell() phone?: string; @cell() email?: string; @cell() driverType?: string; @cell() licenseClass?: string; @cell() licenseState?: string;
 @cell() hiredOn?: string; @cell() safetyManager?: string; @cell() licenseExpiresOn?: string; @cell() medicalExpiresOn?: string; @cell() workAuthorization?: string; @cell() workPermitExpiresOn?: string;
 @cell() lastReviewOn?: string; @cell() unit?: string; @cell() mc?: string; @cell() dispatcher?: string;
}
export class ExistingDriversDto {
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ExistingDriverRowDto) rows!: ExistingDriverRowDto[];
 // The file's name for the record, when there was one. The file itself is never sent or kept.
 @IsOptional() @IsString() @MaxLength(200) sourceName?: string;
}
export const PAPER_KEYS = ['APPLICATION', 'MVR_AT_HIRE', 'ROAD_TEST', 'PREVIOUS_EMPLOYERS', 'DRUG_TEST', 'CLEARINGHOUSE', 'MEDICAL_REGISTRY', 'E_VERIFY'] as const;
export type PaperKey = typeof PAPER_KEYS[number];
export class PaperItemDto {
 @IsInt() @Min(1) version!: number;
 @IsIn(['ON_FILE', 'NOT_ON_FILE', 'NOT_NEEDED']) status!: 'ON_FILE' | 'NOT_ON_FILE' | 'NOT_NEEDED';
 @IsOptional() @IsString() @ValidateIf((_o, value) => value !== '') @MaxLength(10) doneOn?: string;
 @IsOptional() @IsString() @MaxLength(1000) @NoSsn() note?: string;
}
export class CatchUpLinkDto { @IsInt() @Min(1) version!: number; }

/**
 * The paper qualification file items that apply to a driver (ExistingDriverProfileScreen): the road test or the CDL in
 * its place, the pre-employment drug test for everyone (a DOT test with a CDL, the company's own test on a regular
 * license, as clearance asks), the Clearinghouse query only where the license brings DOT testing, and E-Verify for
 * company drivers. Consent forms are not an item: the catch-up link asks for the current ones.
 */
export function paperKeys(driver: { driverType: string; licenseType: string | null }, rules = licenseRules(driver.licenseType as LicenseType | null)): PaperKey[] {
 return PAPER_KEYS.filter(key => (key !== 'CLEARINGHOUSE' || rules.clearinghouse) && (key !== 'E_VERIFY' || driver.driverType === 'COMPANY'));
}

const TYPES: Record<string, 'COMPANY' | 'OWNER_OPERATOR'> = { company: 'COMPANY', 'company driver': 'COMPANY', 'owner-operator': 'OWNER_OPERATOR', 'owner operator': 'OWNER_OPERATOR', 'owner-op': 'OWNER_OPERATOR', ownerop: 'OWNER_OPERATOR' };
const CLASSES: Record<string, LicenseType> = { 'cdl class a': 'CDL_A', 'cdl a': 'CDL_A', 'class a': 'CDL_A', cdla: 'CDL_A', 'cdl class b': 'CDL_B', 'cdl b': 'CDL_B', 'class b': 'CDL_B', 'cdl class c': 'CDL_C', 'cdl c': 'CDL_C', dl: 'DL', "driver's license": 'DL', 'driver license': 'DL', 'non-cdl': 'DL' };
const AUTHORIZATIONS: Record<string, WorkAuthorizationType> = { 'us passport': 'US_PASSPORT', passport: 'US_PASSPORT', 'green card': 'GREEN_CARD', 'permanent resident card': 'GREEN_CARD', 'work permit': 'WORK_PERMIT', ead: 'WORK_PERMIT', 'another document': 'OTHER', other: 'OTHER' };
const CLASS_WORDS: Record<LicenseType, string> = { CDL_A: 'CDL Class A', CDL_B: 'CDL Class B', CDL_C: 'CDL Class C', DL: 'DL' };
interface Ready { row: number; firstName: string; lastName: string; phone: string; email: string | null; driverType: 'COMPANY' | 'OWNER_OPERATOR'; licenseType: LicenseType; licenseState: string; hiredOn: string | null;
 ownerId: string; licenseExpiresOn: string; medicalExpiresOn: string; workAuthorization: WorkAuthorizationType; workPermitExpiresOn: string | null; lastReviewOn: string | null;
 unit: { id: string; number: string } | null; mcId: string | null; memberId: string | null; onHold: boolean }

/**
 * Existing drivers (section 34, ExistingDriversAddScreen and its group): drivers already on the road are added from their
 * paper qualification file as Cleared by the Safety Director or an administrator, which stands in for the decision. Their
 * license, medical card and work authorization dates count as checked (driver_documents rows with fromPaper and no file), so
 * holds, Expiring documents and reminders work at once; an expired one puts them on hold. Nobody is messaged. On their page
 * the paper file is confirmed item by item, and a catch-up link asks the driver for photos and the current consent forms.
 */
@Injectable()
export class ExistingDriversService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService) {}

 async check(user: User, dto: ExistingDriversDto) {
  requireDirector(user);
  const { rows, choices } = await this.read(this.db.manager, dto.rows);
  const result = summary(rows, choices);
  return { ...result, counts: { ...result.counts, onHold: rows.filter(row => row.status === 'READY' && row.onHold).length } };
 }

 async add(user: User, dto: ExistingDriversDto) {
  requireDirector(user);
  return writeDriver(this.db, async em => {
   // One add at a time, so two uploads of one file can't both add a driver before the open phone and email indexes see them.
   await em.query('SELECT pg_advisory_xact_lock($1)', [EXISTING_DRIVERS_LOCK]);
   const { rows, ready } = await this.read(em, dto.rows);
   const drivers: { row: number; id: string }[] = [], now = new Date();
   for (const row of ready) {
    const driver = await em.getRepository(Driver).save({ firstName: row.firstName, lastName: row.lastName, phone: row.phone, phoneKey: phoneKey(row.phone), email: row.email, driverType: row.driverType,
     licenseType: row.licenseType, licenseState: row.licenseState, status: 'CLEARED', clearedAt: now, clearedBy: user.id, createdBy: user.id });
    await em.query(`INSERT INTO existing_driver_records ("driverId", "hiredOn", "sourceName", "addedBy") VALUES ($1, $2, $3, $4)`, [driver.id, row.hiredOn, dto.sourceName?.trim() || null, user.id]);
    await em.query(`INSERT INTO driver_owners ("driverId", "ownerId", "actorId") VALUES ($1, $2, $3)`, [driver.id, row.ownerId, user.id]);
    const paper = (kind: DriverDocumentKind, expiresOn: string | null, subtype: WorkAuthorizationType | null = null) => em.getRepository(DriverDocument).insert({ id: randomUUID(), driverId: driver.id, kind, subtype,
     pageCount: 0, sha256: null, byteSize: null, fromPaper: true, createdAt: now, verifiedAt: now, verifiedBy: user.id, expiresOn, uploadedBy: user.id, storageLayout: CURRENT_LAYOUT });
    await paper('LICENSE', row.licenseExpiresOn);
    await paper('MEDICAL_CARD', row.medicalExpiresOn);
    await paper('WORK_AUTHORIZATION', row.workPermitExpiresOn, row.workAuthorization);
    if (row.lastReviewOn) await em.query(`INSERT INTO driver_annual_reviews ("driverId", "reviewedOn", outcome, "reviewerId", "fromPaper") VALUES ($1, $2, 'QUALIFIED', $3, true)`, [driver.id, row.lastReviewOn, user.id]);
    if (row.mcId && row.memberId) {
     await lockDispatcher(em, row.memberId, row.mcId);
     // The unit too, as archiving it locks it: one archived or taken out of service since the check isn't assigned.
     if (row.unit && !(await em.query(`SELECT 1 FROM driver_trucks WHERE id = $1 AND "archivedAt" IS NULL AND "outOfServiceAt" IS NULL FOR SHARE`, [row.unit.id]) as unknown[]).length)
      throw new ConflictException(`Unit ${row.unit.number} was archived or taken out of service while the drivers were being added. Check the file again.`);
     const startedAt = new Date(`${row.hiredOn ?? usDay('latest')}T12:00:00Z`);
     await em.query(`INSERT INTO driver_assignments ("driverId", "mcId", "memberId", truck, "unitId", "startedAt", "actorId") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [driver.id, row.mcId, row.memberId, row.unit?.number ?? null, row.unit?.id ?? null, startedAt, user.id]);
    }
    await driverEvent(em, user.id, driver.id, 'EXISTING_ADDED', { onHold: row.onHold, assigned: !!row.memberId, unit: !!row.unit, lastReview: !!row.lastReviewOn, fromFile: !!dto.sourceName });
    drivers.push({ row: row.row, id: driver.id });
   }
   return { added: drivers.length, drivers, left: rows.filter(row => row.status !== 'READY') };
  });
 }

 /** What Add one existing driver picks from (ExistingDriverFormScreen): Safety Managers, trucks and pickups in service, and the dispatchers under each active MC. */
 async options(user: User) {
  requireDirector(user);
  const [staff, units, dispatchers] = await Promise.all([
   this.db.query(`SELECT id, "firstName" || ' ' || "lastName" AS name FROM users WHERE status = 'ACTIVE' AND role::text = 'SAFETY_STAFF' ORDER BY lower("firstName"), lower("lastName")`),
   this.db.query(`SELECT t.id, t.unit AS number, t.kind, t."driverId" IS NOT NULL AS "ownerOperator", coalesce(o.name, d."firstName" || ' ' || d."lastName") AS owner FROM driver_trucks t
    LEFT JOIN truck_owners o ON o.id = t."ownerId" LEFT JOIN drivers d ON d.id = t."driverId" WHERE t."archivedAt" IS NULL AND t."outOfServiceAt" IS NULL AND t.kind <> 'TRAILER' ORDER BY lower(t.unit)`),
   this.db.query(`SELECT m.id AS "mcId", m.name AS mc, x.id, x."firstName" || ' ' || x."lastName" AS name, t.name AS team FROM member_assignments ma JOIN dispatch_members x ON x.id = ma."memberId"
    JOIN mcs m ON m.id = ma."mcId" LEFT JOIN teams t ON t.id = ma."teamId" WHERE ma."endedAt" IS NULL AND x.status = 'ACTIVE' AND x.position = 'DISPATCHER' AND m."archivedAt" IS NULL
    AND NOT EXISTS(SELECT 1 FROM member_notices n WHERE n."memberId" = x.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL) AND NOT ${onLeaveSql('x')}
    ORDER BY m."nameKey", lower(x."firstName"), lower(x."lastName")`) as Promise<{ mcId: string; mc: string; id: string; name: string; team: string | null }[]>]);
  const mcs = new Map<string, { id: string; name: string; dispatchers: { id: string; name: string; team: string | null }[] }>();
  for (const row of dispatchers) mcs.set(row.mcId, { id: row.mcId, name: row.mc, dispatchers: [...(mcs.get(row.mcId)?.dispatchers ?? []), { id: row.id, name: row.name, team: row.team }] });
  return { staff, units, mcs: [...mcs.values()] };
 }

 /** Confirms one item of the paper file (PaperFileConfirmScreen): on file (with its date), not on file with a note, or not needed. */
 async paperItem(user: User, id: string, key: string, dto: PaperItemDto) {
  if (!(PAPER_KEYS as readonly string[]).includes(key)) throw new NotFoundException();
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   await this.mayChange(em, user, driver.id);
   // Only a driver added from a paper file has one; a driver who applied has their record in the workspace instead.
   if (!(await em.query(`SELECT 1 FROM existing_driver_records WHERE "driverId" = $1`, [id]) as unknown[]).length) throw new NotFoundException('This driver wasn’t added from a paper file.');
   if (!paperKeys(driver, await driverLicenseRules(em, driver.id)).includes(key as PaperKey)) throw new BadRequestException('This item doesn’t apply to this driver’s license or type.');
   if (dto.status !== 'ON_FILE' && !dto.note?.trim()) throw new BadRequestException('Say what’s missing or why it isn’t needed.');
   if (dto.status === 'NOT_NEEDED' && !['ROAD_TEST', 'PREVIOUS_EMPLOYERS'].includes(key)) throw new BadRequestException('Only the road test and previous employers can be not needed.');
   const doneOn = dto.doneOn ? fileDate(dto.doneOn) : null;
   if (dto.doneOn && !doneOn) throw new BadRequestException('Enter a real date.');
   if (doneOn && doneOn > usDay('latest')) throw new BadRequestException('The date can’t be in the future.');
   await em.query(`INSERT INTO driver_paper_items ("driverId", key, status, "doneOn", note, "updatedBy", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, now())
    ON CONFLICT ("driverId", key) DO UPDATE SET status = $3, "doneOn" = $4, note = $5, "updatedBy" = $6, "updatedAt" = now()`, [id, key, dto.status, doneOn, dto.note?.trim() || null, user.id]);
   await em.getRepository(Driver).update(id, { version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'PAPER_ITEM_RECORDED', { key, status: dto.status });
   return { id, version: driver.version + 1 };
  });
 }

 /** A catch-up link (14 days, bound to the driver's email, shown once): photos of their current documents and the current consent forms. */
 async sendCatchUp(user: User, id: string, dto: CatchUpLinkDto) {
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   await this.mayChange(em, user, id);
   if (!await this.isExisting(em, id)) throw new ConflictException('Catch-up links are for drivers added from a paper file.');
   if (!LEAVABLE.includes(driver.status)) throw new ConflictException('This driver is no longer cleared.');
   if (!driver.email) throw new BadRequestException('Add the driver’s email first. The link works only with that address.');
   requireMayEmail(this.config, driver.email);
   const resent = await revokeOpenLinks(em, id, { purpose: 'CATCH_UP' }), token = randomBytes(32).toString('hex');
   const link = await em.getRepository(DriverLink).save({ driverId: id, tokenHash: digest(token), email: driver.email, createdBy: user.id, purpose: 'CATCH_UP', expiresAt: new Date(Date.now() + CATCH_UP_DAYS * 86400_000) });
   await em.getRepository(Driver).update(id, { version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'CATCH_UP_LINK_SENT', { resent });
   return { id, version: driver.version + 1, expiresAt: link.expiresAt, url: `${webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0]}/driver#${token}` };
  });
 }
 async cancelCatchUp(user: User, id: string, dto: CatchUpLinkDto) {
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   await this.mayChange(em, user, id);
   if (!await revokeOpenLinks(em, id, { purpose: 'CATCH_UP' })) throw new ConflictException('This driver has no open catch-up link.');
   await em.getRepository(Driver).update(id, { version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'CATCH_UP_LINK_CANCELLED', {});
   return { id, version: driver.version + 1 };
  });
 }

 /** The driver page's part (ExistingDriverProfileScreen): who added them and from what, the paper file, and the catch-up link (never its token). */
 /** With sees false (results.ts) the drug test and Clearinghouse items are read as restricted placeholders only. */
 async forDriver(id: string, sees: boolean) {
  const [record] = await this.db.query(`SELECT to_char(x."hiredOn", 'YYYY-MM-DD') AS "hiredOn", x."sourceName", x."createdAt", ${personName('u')} AS "addedBy"
   FROM existing_driver_records x LEFT JOIN users u ON u.id = x."addedBy" WHERE x."driverId" = $1`, [id]) as { hiredOn: string | null }[];
  if (!record) return null;
  const [driver] = await this.db.query(`SELECT "driverType", "licenseType" FROM drivers WHERE id = $1`, [id]) as { driverType: string; licenseType: string | null }[];
  const [items, [link], [sent]] = await Promise.all([
   this.db.query(`SELECT p.key, p.status, to_char(p."doneOn", 'YYYY-MM-DD') AS "doneOn", p.note, p."updatedAt", ${personName('u')} AS "updatedBy"
    FROM driver_paper_items p LEFT JOIN users u ON u.id = p."updatedBy" WHERE p."driverId" = $1 AND ${resultKeySql('p.key', '$2')}`, [id, sees]) as Promise<{ key: string }[]>,
   this.db.query(`SELECT "createdAt", "expiresAt", "openedAt", "expiresAt" <= now() AS expired FROM driver_links WHERE "driverId" = $1 AND purpose = 'CATCH_UP' AND "revokedAt" IS NULL AND "completedAt" IS NULL`, [id]),
   this.db.query(`SELECT "completedAt" FROM driver_links WHERE "driverId" = $1 AND purpose = 'CATCH_UP' AND "completedAt" IS NOT NULL ORDER BY "completedAt" DESC LIMIT 1`, [id])]);
  const keys = paperKeys(driver, await driverLicenseRules(this.db.manager, id));
  return { ...record, keys, paper: [...items.filter(item => keys.includes(item.key as PaperKey)), ...(sees ? [] : hiddenItems(keys))], catchUp: { link: link ?? null, sentAt: (sent as { completedAt: Date } | undefined)?.completedAt ?? null } };
 }

 private async isExisting(em: EntityManager, id: string) { return (await em.query(`SELECT 1 FROM existing_driver_records WHERE "driverId" = $1`, [id]) as unknown[]).length > 0; }
 private async mayChange(em: EntityManager, user: User, id: string) {
  if (!DECIDERS.includes(user.role) && !await ownsDriver(em, user, id)) throw new ForbiddenException('Only the Safety Director, administrators and the driver’s Safety Manager can do this.');
 }

 private async read(em: EntityManager, input: ExistingDriverRowDto[]) {
  const [staff, units, mcs, dispatchers, open] = await Promise.all([
   em.query(`SELECT id, "firstName" || ' ' || "lastName" AS name, "firstName" AS first FROM users WHERE status = 'ACTIVE' AND role::text = 'SAFETY_STAFF' ORDER BY lower("firstName"), lower("lastName")`) as Promise<{ id: string; name: string; first: string }[]>,
   em.query(`SELECT t.id, t.unit AS number, t.kind, t."driverId", coalesce(o.name, 'an owner-operator') AS owner FROM driver_trucks t LEFT JOIN truck_owners o ON o.id = t."ownerId"
    WHERE t."archivedAt" IS NULL AND t."outOfServiceAt" IS NULL AND t.kind <> 'TRAILER' ORDER BY lower(t.unit)`) as Promise<{ id: string; number: string; kind: string; driverId: string | null; owner: string }[]>,
   em.query(`SELECT id, name FROM mcs WHERE "archivedAt" IS NULL ORDER BY "nameKey"`) as Promise<{ id: string; name: string }[]>,
   em.query(`SELECT x.id, x."firstName" || ' ' || x."lastName" AS name, x."firstName" AS first, ma."mcId", t.name AS team FROM member_assignments ma JOIN dispatch_members x ON x.id = ma."memberId"
    LEFT JOIN teams t ON t.id = ma."teamId" WHERE ma."endedAt" IS NULL AND x.status = 'ACTIVE' AND x.position = 'DISPATCHER'
    AND NOT EXISTS(SELECT 1 FROM member_notices n WHERE n."memberId" = x.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL) AND NOT ${onLeaveSql('x')}`) as Promise<{ id: string; name: string; first: string; mcId: string; team: string | null }[]>,
   em.query(`SELECT "phoneKey", lower(email) AS email, status, "firstName" || ' ' || "lastName" AS name FROM drivers WHERE status NOT IN ('REJECTED','WITHDRAWN','LEFT')`) as Promise<{ phoneKey: string; email: string | null; status: string; name: string }[]>]);
  const today = usDay('latest'), rows: (ImportRow & { onHold: boolean })[] = [], ready: Ready[] = [], choices: ImportChoice[] = [];
  const seenPhones = new Map<string, number>(), seenEmails = new Map<string, number>();
  for (const source of input) {
   const value = (key: keyof ExistingDriverRowDto) => String(source[key] ?? '').trim();
   const problems: string[] = [], notes: string[] = [];
   let choice = false, already = false, onHold = false;
   const firstName = value('firstName').replace(/\s+/g, ' '), lastName = value('lastName').replace(/\s+/g, ' ');
   if (!firstName || !lastName) problems.push('First and last name are both needed.');
   else if (firstName.length > 100 || lastName.length > 100) problems.push('A name is longer than 100 characters.');
   const phone = value('phone'), key = phoneKey(phone);
   // The same rules as editing the driver later (safety.dto.ts), so a row added here is never refused there.
   if (!phone) problems.push('No phone.'); else if (!INTERNATIONAL_PHONE_PATTERN.test(phone) || phone.length > 40) problems.push(`Phone “${phone.slice(0, 40)}” isn’t a phone number.`);
   const email = value('email').toLowerCase() || null;
   if (email && (!isEmail(email) || email.length > 254)) problems.push(`Email “${email.slice(0, 60)}” isn’t an email address.`);
   else if (email && !mayEmail(this.config, email)) problems.push('Outside production, emails must be fictional example.test addresses.');
   if (!email) notes.push('No email, so no catch-up link until one is added.');
   const driverType = TYPES[fold(value('driverType'))] ?? (value('driverType') === 'COMPANY' || value('driverType') === 'OWNER_OPERATOR' ? value('driverType') as Ready['driverType'] : undefined);
   if (!driverType) problems.push(value('driverType') ? `Type “${value('driverType').slice(0, 40)}” isn’t Company driver or Owner-operator.` : 'No type. Write Company driver or Owner-operator.');
   const licenseType = CLASSES[fold(value('licenseClass'))] ?? (Object.keys(CLASS_WORDS).includes(value('licenseClass')) ? value('licenseClass') as LicenseType : undefined);
   if (!licenseType) problems.push(value('licenseClass') ? `License class “${value('licenseClass').slice(0, 40)}” isn’t CDL Class A, B or C, or DL.` : 'No license class.');
   const licenseState = value('licenseState').toUpperCase();
   if (!(US_STATES as readonly string[]).includes(licenseState)) problems.push(licenseState ? `License state “${licenseState.slice(0, 20)}” isn’t a US state code.` : 'No license state.');
   const date = (key: keyof ExistingDriverRowDto, what: string, required: boolean) => {
    const text = value(key);
    if (!text) { if (required) problems.push(`No ${what.toLowerCase()} date.`); return null; }
    const parsed = fileDate(text);
    if (!parsed) problems.push(`${what} “${text.slice(0, 30)}” isn’t a date.`);
    return parsed;
   };
   const hiredOn = date('hiredOn', 'Hired on', false);
   if (hiredOn && hiredOn > today) problems.push('The hire date is in the future.');
   const licenseExpiresOn = date('licenseExpiresOn', 'License expiration', true), medicalExpiresOn = date('medicalExpiresOn', 'Medical card expiration', true);
   if (licenseExpiresOn && licenseExpiresOn < today) { onHold = true; notes.push(`License expired ${licenseExpiresOn}. Added on hold until a newer license is checked; the catch-up link asks for it.`); }
   if (medicalExpiresOn && medicalExpiresOn < today) { onHold = true; notes.push(`Medical card expired ${medicalExpiresOn}. Added on hold until a newer card is checked; the catch-up link asks for it.`); }
   const authorizationText = value('workAuthorization'), workAuthorization = AUTHORIZATIONS[fold(authorizationText)] ?? (Object.values(AUTHORIZATIONS).includes(authorizationText as WorkAuthorizationType) ? authorizationText as WorkAuthorizationType : undefined);
   if (!workAuthorization) problems.push(authorizationText ? `Work authorization “${authorizationText.slice(0, 40)}” isn’t US passport, Green card, Work permit or Another document.` : 'No work authorization.');
   const workPermitExpiresOn = workAuthorization === 'WORK_PERMIT' || workAuthorization === 'OTHER' ? date('workPermitExpiresOn', 'Work permit expiration', workAuthorization === 'WORK_PERMIT') : null;
   const lastReviewOn = date('lastReviewOn', 'Last yearly review', false);
   if (lastReviewOn && lastReviewOn > today) problems.push('The last yearly review is in the future.');
   if (!lastReviewOn && !problems.length) notes.push('No last yearly review. The review shows as due now.');
   // Safety Manager: a name or first name that matches one active Safety Manager, else a choice.
   const managerText = value('safetyManager'); let ownerId: string | null = null;
   if (managerText.startsWith('@')) { ownerId = staff.some(item => item.id === managerText.slice(1)) ? managerText.slice(1) : null; if (!ownerId) problems.push('The Safety Manager chosen is no longer active. Upload again.'); }
   else if (!managerText) problems.push('No Safety Manager.');
   else {
    const full = staff.filter(item => fold(item.name) === fold(managerText)), first = staff.filter(item => fold(item.first) === fold(managerText));
    const match = full.length === 1 ? full[0] : !full.length && first.length === 1 ? first[0] : null;
    if (match) ownerId = match.id;
    else { choice = true; addChoice(choices, 'safetyManager', managerText, source.row, () => staff.map(item => ({ value: `@${item.id}`, label: item.name }))); }
   }
   // Unit: a truck or pickup on the Units list. A company driver drives a truck owner's; an owner-operator drives their
   // own, which can't be on the list before they are, so their truck is added on Units afterwards.
   const unitText = value('unit'); let unit: Ready['unit'] = null;
   const unitOptions = () => [...units.filter(item => driverType === 'COMPANY' && !item.driverId).map(item => ({ value: `@${item.id}`, label: `${item.number} · ${item.kind === 'SEMI' ? 'Semi truck' : 'Pickup'} · ${item.owner}` })), { value: '@none', label: 'No unit yet' }];
   if (unitText && unitText !== '@none') {
    const found = unitText.startsWith('@') ? units.find(item => item.id === unitText.slice(1)) : units.find(item => fold(item.number) === fold(unitText));
    if (!found) { if (unitText.startsWith('@')) problems.push('The unit chosen is no longer in service. Upload again.'); else { choice = true; addChoice(choices, 'unit', unitText, source.row, unitOptions); } }
    else if (found.driverId && driverType === 'COMPANY') problems.push(`Unit ${found.number} belongs to an owner-operator. A company driver drives a truck owner’s truck.`);
    else if (driverType === 'OWNER_OPERATOR') problems.push(`Unit ${found.number} belongs to ${found.owner}. An owner-operator drives their own truck: add it on Units once they’re added.`);
    else unit = { id: found.id, number: found.number };
   }
   // MC and dispatcher: both or neither; a dispatcher who works under that MC now.
   const mcText = value('mc'), dispatcherText = value('dispatcher'); let mcId: string | null = null, memberId: string | null = null;
   if (mcText && mcText !== '@none') {
    const mc = mcText.startsWith('@') ? mcs.find(item => item.id === mcText.slice(1)) : mcs.find(item => fold(item.name) === fold(mcText));
    if (mc) mcId = mc.id;
    else if (mcText.startsWith('@')) problems.push('The MC chosen is archived. Upload again.');
    else { choice = true; addChoice(choices, 'mc', mcText, source.row, () => [...mcs.map(item => ({ value: `@${item.id}`, label: item.name })), { value: '@none', label: 'Not assigned yet' }]); }
   }
   if (dispatcherText && dispatcherText !== '@none') {
    if (!mcText) problems.push('Name the MC with the dispatcher.');
    else if (mcId) {
     const under = dispatchers.filter(item => item.mcId === mcId);
     const found = dispatcherText.startsWith('@') ? under.filter(item => item.id === dispatcherText.slice(1)) : under.filter(item => fold(item.name) === fold(dispatcherText));
     const byFirst = !found.length && !dispatcherText.startsWith('@') ? under.filter(item => fold(item.first) === fold(dispatcherText)) : [];
     const match = found.length === 1 ? found[0] : byFirst.length === 1 ? byFirst[0] : null;
     if (match) memberId = match.id;
     else if (dispatcherText.startsWith('@')) problems.push('The dispatcher chosen no longer works under this MC. Upload again.');
     else { choice = true; addChoice(choices, 'dispatcher', dispatcherText, source.row, () => [...under.map(item => ({ value: `@${item.id}`, label: item.team ? `${item.name} · ${item.team}` : item.name })), { value: '@none', label: 'Not assigned yet' }]); }
    }
   } else if (mcId) mcId = null;
   // A dispatcher with the MC set to Not assigned yet isn't kept either: say so rather than drop them silently.
   if (dispatcherText && dispatcherText !== '@none' && mcText === '@none') notes.push(`${dispatcherText.startsWith('@') ? 'The dispatcher chosen' : `Dispatcher “${dispatcherText.slice(0, 60)}”`} isn’t kept: the MC is set to Not assigned yet. Dispatch assigns them later.`);
   // The unit is kept with the dispatch assignment, so without a dispatcher it would be lost: say so and leave it out.
   if (unit && !memberId) { notes.push(`Unit ${unit.number} isn’t kept without an MC and dispatcher. Dispatch picks the unit when they assign them.`); unit = null; }
   if (memberId && onHold) notes.push('On hold, so Dispatch sees them with their dispatcher but can’t assign them anew.');
   // Already here: an open driver record with this phone or email.
   const here = key ? open.find(item => item.phoneKey === key) ?? (email ? open.find(item => item.email === email) : undefined) : undefined;
   if (here) { already = true; notes.splice(0, notes.length, `Already in the workspace with this ${here.phoneKey === key ? 'phone' : 'email'} (${here.name}). This row is left out.`); }
   else {
    if (key && seenPhones.has(key)) problems.push(`This phone is also on row ${seenPhones.get(key)}.`);
    if (email && seenEmails.has(email)) problems.push(`This email is also on row ${seenEmails.get(email)}.`);
   }
   if (key && !seenPhones.has(key)) seenPhones.set(key, source.row);
   if (email && !seenEmails.has(email)) seenEmails.set(email, source.row);
   const status = already ? 'ALREADY' : problems.length ? 'PROBLEM' : choice ? 'CHOICE' : 'READY';
   rows.push({ row: source.row, name: `${firstName} ${lastName}`.trim() || 'No name', detail: [driverType === 'OWNER_OPERATOR' ? 'Owner-operator' : driverType ? 'Company driver' : '', licenseType ? CLASS_WORDS[licenseType] : ''].filter(Boolean).join(' · '),
    status, problems: already ? notes : problems, notes: already ? [] : notes, onHold: status === 'READY' && onHold });
   if (status === 'READY') ready.push({ row: source.row, firstName, lastName, phone, email, driverType: driverType!, licenseType: licenseType!, licenseState, hiredOn, ownerId: ownerId!, licenseExpiresOn: licenseExpiresOn!,
    medicalExpiresOn: medicalExpiresOn!, workAuthorization: workAuthorization!, workPermitExpiresOn, lastReviewOn, unit, mcId, memberId, onHold });
  }
  return { rows, ready, choices };
 }
}
function requireDirector(user: User) {
 if (!DECIDERS.includes(user.role)) throw new ForbiddenException('Only the Safety Director and administrators add existing drivers: adding them as Cleared stands in for the decision.');
}

/**
 * The driver's catch-up page (DriverCatchUpPhoneScreen), through a CATCH_UP link session: photos of their current
 * license, medical card and work authorization, and the current consent forms (ConsentService, through signer()). It never
 * reads an application, and nothing they send counts until Safety checks it: the scans wait as unchecked current scans,
 * like renewal scans, while the paper dates keep counting.
 */
@Injectable()
export class CatchUpService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService) {}

 async view(req: Request) {
  const { link } = await this.session(this.db.manager, req, false);
  return this.describe(this.db.manager, link);
 }

 async upload(req: Request, segment: string, dto: DriverDocumentDto) {
  const kind = Object.hasOwn(DOCUMENT_SEGMENTS, segment) ? DOCUMENT_SEGMENTS[segment] : undefined;
  if (!kind || !CATCH_UP_KINDS.includes(kind)) throw new NotFoundException();
  if (!this.storage.enabled) throw new ServiceUnavailableException('Document uploads aren’t available right now. Please contact Safety.');
  if ((kind === 'WORK_AUTHORIZATION') !== !!dto.subtype) throw new BadRequestException(kind === 'WORK_AUTHORIZATION' ? 'Choose which document you’re scanning.' : 'Only work authorization takes a document type.');
  const first = await this.session(this.db.manager, req, false);
  if (first.link.completedAt) throw new ConflictException('You already sent your documents to Safety.');
  await onboardingLimit(this.db, `driver-document:${first.link.id}`, 30);
  const body = await scanPdf(dto.pages), stored = { id: randomUUID(), driverId: first.driver.id, kind, storageLayout: CURRENT_LAYOUT };
  await this.storage.put(driverDocumentKey(stored), body, 'application/pdf');
  let result;
  try {
   result = await this.db.transaction(async em => {
    const { link, driver } = await this.session(em, req, true);
    if (link.completedAt) throw new ConflictException('You already sent your documents to Safety.');
    const documents = em.getRepository(DriverDocument), now = new Date();
    const current = await documents.findOneBy({ driverId: driver.id, kind, replacedAt: IsNull() });
    if (current) await documents.update(current.id, { replacedAt: now });
    await documents.insert({ ...stored, subtype: dto.subtype ?? null, pageCount: dto.pages.length, sha256: sha256(body), byteSize: body.length, createdAt: now });
    await em.getRepository(Driver).update(driver.id, { version: driver.version + 1 });
    await driverEvent(em, null, driver.id, 'DOCUMENT_UPLOADED', { kind, pages: dto.pages.length, catchUp: true });
    // A retake replaces this link's own earlier scan, whose file goes; a checked or paper one stays.
    return { view: await this.describe(em, link), removable: current && !current.verifiedAt && !current.fromPaper && current.createdAt >= link.createdAt ? current : null };
   });
  } catch (error) { await this.storage.remove(driverDocumentKey(stored)); throw error; }
  if (result.removable) await this.storage.remove(driverDocumentKey(result.removable));
  return result.view;
 }

 async file(req: Request, id: string): Promise<FileResult> {
  const { link, driver } = await this.session(this.db.manager, req, false);
  const document = await this.db.getRepository(DriverDocument).findOneBy({ id, driverId: driver.id, replacedAt: IsNull(), fromPaper: false });
  if (!document || document.createdAt < link.createdAt) throw new NotFoundException();
  return { body: await this.storage.get(driverDocumentKey(document)), type: 'application/pdf', filename: `${document.kind.toLowerCase().replace(/_/g, '-')}.pdf` };
 }

 /** Sends everything to Safety: every document photographed through this link and every current form signed. The link closes. */
 async send(req: Request) {
  return this.db.transaction(async em => {
   const { link, driver } = await this.session(em, req, true);
   if (link.completedAt) throw new ConflictException('You already sent your documents to Safety.');
   const view = await this.describe(em, link);
   if (view.missing.length) throw new BadRequestException({ message: 'Photograph every document and sign every form first.', missing: view.missing });
   const now = new Date();
   await em.getRepository(DriverLink).update(link.id, { completedAt: now });
   await em.getRepository(Driver).update(driver.id, { version: driver.version + 1 });
   await driverEvent(em, null, driver.id, 'CATCH_UP_SENT', {});
   return this.describe(em, { ...link, completedAt: now });
  });
 }

 /**
  * The verified catch-up link and its driver. An open link needs a cleared or approved driver; once sent, the page stays
  * readable for the rest of the session until Safety revokes the link. Also used by ConsentService for the forms.
  */
 async session(em: EntityManager, req: Request, lock: boolean, known?: DriverLink) {
  const first = known ?? await sessionLink(em, req);
  if (first.purpose !== 'CATCH_UP') throw new UnauthorizedException('Please verify your email again.');
  const driver = await em.getRepository(Driver).findOne({ where: { id: first.driverId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  const link = lock ? await em.getRepository(DriverLink).findOneByOrFail({ id: first.id }) : first;
  if (!driver || link.revokedAt || (!link.completedAt && (link.expiresAt.getTime() <= Date.now() || !LEAVABLE.includes(driver.status)))) throw new UnauthorizedException(CLOSED_LINK);
  return { link, driver };
 }

 async describe(em: EntityManager, link: DriverLink) {
  const [driver] = await em.query(`SELECT id, "firstName", "driverType", "licenseType" FROM drivers WHERE id = $1`, [link.driverId]) as { id: string; firstName: string; driverType: string; licenseType: string | null }[];
  const scans = await em.getRepository(DriverDocument).createQueryBuilder('d').where('d."driverId" = :id AND d."replacedAt" IS NULL AND d."fromPaper" = false AND d."createdAt" >= :since', { id: link.driverId, since: link.createdAt }).getMany();
  // A driver added from a paper file has no application, so nothing asks them to certify one.
  const consents = await consentStatus(em, link.driverId, this.storage.enabled, await driverLicenseRules(em, link.driverId), false);
  const documents = CATCH_UP_KINDS.map(kind => { const scan = scans.find(item => item.kind === kind); return { kind, scan: scan ? { id: scan.id, subtype: scan.subtype, pageCount: scan.pageCount, createdAt: scan.createdAt } : null }; });
  const missing = [...(this.storage.enabled ? documents.filter(item => !item.scan).map(item => item.kind) : []), ...consents.missing];
  return { purpose: 'CATCH_UP' as const, firstName: driver.firstName, email: link.email, expiresAt: link.expiresAt, sentAt: link.completedAt, documentsEnabled: this.storage.enabled, documents,
   consents: { required: consents.required, consent: consents.consent, items: consents.items }, missing };
 }
}

/**
 * The dispatcher a row names, locked as Dispatch's own assignment locks them (their record, then their team, for share)
 * and checked again, so leaving, a move to another MC or leave recorded while the file was checked can't slip in.
 */
async function lockDispatcher(em: EntityManager, memberId: string, mcId: string) {
 const member = await em.getRepository(DispatchMember).findOne({ where: { id: memberId }, lock: { mode: 'pessimistic_read' } });
 const placed = member && await em.getRepository(MemberAssignment).findOneBy({ memberId, endedAt: IsNull() });
 const team = placed?.teamId ? await lockTeam(em, placed.teamId) : null;
 if (!member || member.position !== 'DISPATCHER' || member.status !== 'ACTIVE' || !placed || placed.mcId !== mcId || (placed.teamId && (!team || team.archivedAt || team.mcId !== mcId))
  || await onNotice(em, memberId) || await onLeave(em, memberId))
  throw new ConflictException(`${member ? `${member.firstName} ${member.lastName}` : 'A dispatcher in the file'} changed while the drivers were being added. Check the file again.`);
}
