import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SafetyService } from '../safety/safety.service';
import { AnnualReviewService } from '../safety/annual-review.service';
import { ExistingDriversService } from '../safety/existing-drivers';
import { ConsentService } from '../safety/consent.service';
import { UnitsService } from '../safety/units.service';
import { holdReasons, onHoldWithoutTestsSql } from '../safety/holds';
import { driverEvent } from '../safety/driver-records';
import { CLEARANCE_ITEMS, everifyNeeded } from '../safety/safety.entity';
import { RESULT_ITEMS } from '../safety/results';
import type { User } from '../users/user.entity';
import { requireView } from '../users/view-access';
import { pick, pickAll } from './pick';

/** Scans a viewer given document scans may open. Return-to-duty papers and reports never are (49 CFR 40.321, FCRA). */
const OPENABLE = ['LICENSE', 'MEDICAL_CARD', 'WORK_AUTHORIZATION'];

/**
 * Safety read only (section 39): drivers, units and Expiring documents for someone given view-only access. Test results are
 * never read for a viewer (every Safety reader below is asked as someone who doesn't see them), and every answer is an
 * allowlist: no application, SSN, notes, reasons, reports or results. Scans, signed consent forms and unit papers need the
 * grant's withFiles, and each one opened is recorded.
 */
@Injectable()
export class SafetyViewService {
 constructor(private readonly db: DataSource, private readonly safety: SafetyService, private readonly annual: AnnualReviewService, private readonly existing: ExistingDriversService,
  private readonly consents: ConsentService, private readonly units: UnitsService) {}

 async drivers(user: User) {
  await requireView(this.db, user, 'SAFETY');
  const [{ items }, held] = await Promise.all([this.safety.drivers(user, 'ALL'),
   // A viewer never sees results, so a failed test never makes a hold here: one with no visible reason would say a test failed.
   this.db.query(`SELECT d.id FROM drivers d WHERE d.status = 'CLEARED' AND ${onHoldWithoutTestsSql('d')}`) as Promise<{ id: string }[]>]);
  const onHold = new Set(held.map(row => row.id));
  return { items: (items as Record<string, unknown>[]).map(item => ({ ...pick(item, ['id', 'firstName', 'lastName', 'driverType', 'licenseType', 'licenseState', 'status', 'owner', 'createdAt', 'closedAt']), onHold: onHold.has(item.id as string) })) };
 }

 async driver(user: User, id: string) {
  const grant = await requireView(this.db, user, 'SAFETY');
  // Asked as someone who doesn't see results: the result items come back as restricted placeholders.
  const driver = await this.safety.driver(id, false) as Record<string, unknown> & { clearance: { items: Record<string, unknown>[] }; license: { clearinghouse: boolean; roadTestAccepted: boolean };
   documents: Record<string, unknown>[]; assignments: Record<string, unknown>[]; consents: { signatures: Record<string, unknown>[] }; clearedAt: Date | null; status: string; driverType: 'COMPANY' | 'OWNER_OPERATOR' };
  const [reasons, annual, paper, [work]] = await Promise.all([holdReasons(this.db.manager, id), this.annual.forDriver(id, driver.clearedAt), this.existing.forDriver(id, false),
   this.db.query(`SELECT m.name AS mc, x."firstName" || ' ' || x."lastName" AS dispatcher, coalesce(u.unit, a.truck) AS unit, u.kind AS "unitKind", tr.unit AS trailer, a."startedAt"
    FROM driver_assignments a JOIN mcs m ON m.id = a."mcId" JOIN dispatch_members x ON x.id = a."memberId" LEFT JOIN driver_trucks u ON u.id = a."unitId" LEFT JOIN driver_trucks tr ON tr.id = a."trailerId"
    WHERE a."driverId" = $1 AND a."endedAt" IS NULL`, [id]) as Promise<Record<string, unknown>[]>]);
  // As the list has it: only a cleared driver is held from Dispatch, and a test never counts, since a viewer doesn't see
  // results and a hold with no visible reason would itself say that a test failed (49 CFR 40.321).
  const cleared = driver.status === 'CLEARED';
  const review = cleared && reasons.review, expiredDocuments = cleared && reasons.documents;
  const onHold = review || expiredDocuments;
  const items = driver.clearance.items;
  const clearance = CLEARANCE_ITEMS.filter(key => !(key === 'E_VERIFY' && !everifyNeeded(driver)) && !(key === 'CLEARINGHOUSE' && !driver.license.clearinghouse)).map(key => {
   if (RESULT_ITEMS.includes(key)) return { key, status: 'RESTRICTED' };
   if (key === 'ROAD_TEST' && driver.license.roadTestAccepted) return { key, status: 'ACCEPTED' };
   const item = items.find(row => row.key === key);
   return { key, status: (item?.status as string | undefined) ?? 'PENDING', doneOn: item?.doneOn ?? null };
  });
  const documents = driver.documents.filter(doc => OPENABLE.includes(doc.kind as string)).map(doc => ({ ...pick(doc, ['kind', 'subtype', 'expiresOn', 'verifiedAt', 'fromPaper']),
   id: grant.withFiles && !doc.fromPaper ? doc.id : null }));
  return { ...pick(driver, ['id', 'firstName', 'lastName', 'phone', 'driverType', 'licenseType', 'licenseState', 'status', 'clearedAt', 'closedAt', 'createdAt', 'owner']),
   hold: { onHold, review, documents: expiredDocuments }, clearance, documents,
   // The paper file's items for their license and type, in order; one not confirmed yet is pending.
   paperFile: paper ? { hiredOn: paper.hiredOn, items: (paper.keys as string[]).map(key => {
    if (RESULT_ITEMS.includes(key)) return { key, status: 'RESTRICTED' };
    const item = (paper.paper as Record<string, unknown>[]).find(row => row.key === key && !row.hidden);
    return item ? pick(item, ['key', 'status', 'doneOn']) : { key, status: 'PENDING' };
   }) } : null,
   annual: { dueOn: annual.dueOn, items: pickAll(annual.items, ['reviewedOn', 'outcome', 'fromPaper']) }, work: work ?? null, withFiles: grant.withFiles,
   consents: grant.withFiles ? pickAll(driver.consents.signatures, ['documentId', 'kind', 'title', 'version', 'signedAt']) : null };
 }

 async unitList(user: User) {
  const grant = await requireView(this.db, user, 'SAFETY');
  const { today, items } = await this.units.list();
  const files: { id: string; unitId: string; kind: string; createdAt: Date }[] = grant.withFiles ? await this.db.query(`SELECT id, "unitId", kind, "createdAt" FROM unit_files WHERE "replacedAt" IS NULL ORDER BY kind`) : [];
  return { today, withFiles: grant.withFiles, items: (items as Record<string, unknown>[]).filter(item => !item.archivedAt).map(item => ({
   ...pick(item, ['id', 'number', 'kind', 'trailerType', 'year', 'make', 'ownerKind', 'owner', 'registrationExpiresOn', 'inspectedOn', 'outOfServiceAt', 'responsible', 'permits', 'driverNow']),
   files: grant.withFiles ? pickAll(files.filter(file => file.unitId === item.id), ['id', 'kind', 'createdAt']) : null })) };
 }

 async expiring(user: User) {
  await requireView(this.db, user, 'SAFETY');
  const result = await this.safety.expiring();
  return { today: result.today, warningDays: result.warningDays,
   items: pickAll(result.items, ['driverId', 'kind', 'expiresOn', 'expired', 'truck', 'firstName', 'lastName', 'status', 'owner']),
   units: pickAll(result.units.items, ['unitId', 'number', 'kind', 'document', 'dueOn', 'expired', 'responsible', 'owner', 'driverNow']) };
 }

 async document(user: User, driverId: string, documentId: string) {
  await requireView(this.db, user, 'SAFETY', true);
  const [doc] = await this.db.query(`SELECT kind FROM driver_documents WHERE id = $1 AND "driverId" = $2`, [documentId, driverId]) as { kind: string }[];
  if (!doc) throw new NotFoundException('This document was replaced or no longer exists.');
  if (!OPENABLE.includes(doc.kind)) throw new ForbiddenException();
  return this.safety.documentFile(user, driverId, documentId);
 }

 async consent(user: User, driverId: string, documentId: string) {
  await requireView(this.db, user, 'SAFETY', true);
  // The driver's version of the copy, as Dispatch's viewers get the applicant's.
  const file = await this.consents.staffSignedCopy(user, driverId, documentId, 'applicant');
  const [doc] = await this.db.query(`SELECT kind FROM driver_consent_documents WHERE id = $1`, [documentId]) as { kind: string }[];
  await driverEvent(this.db.manager, user.id, driverId, 'CONSENT_VIEWED', { kind: doc?.kind ?? null, role: user.role });
  return file;
 }

 async unitFile(user: User, unitId: string, fileId: string) {
  await requireView(this.db, user, 'SAFETY', true);
  return this.units.file(user, unitId, fileId);
 }
}
