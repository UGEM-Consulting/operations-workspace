import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { inspectPdf } from '../documents/certificate';
import type { FileResult } from '../documents/documents.service';
import { decodePdf, sha256 } from '../documents/images';
import { onboardingLimit } from '../onboarding/rate-limit';
import { driverReportKey, StorageService } from '../storage/storage.service';
import { Role, User } from '../users/user.entity';
import { DECIDERS, driverEvent, lockOpenDriver, requireScreener, writeDriver } from './driver-records';
import { Driver, DriverApplication, DriverEventType, DriverLink, DriverReport, DriverReview, DriverReviewAction, DriverScreeningCheck, DriverStatus, earliestFinalRejection,
 SCREENING_CHECKS, type ScreeningCheckKey } from './safety.entity';
import { SafetyService } from './safety.service';
import { authorizationSigned } from './consent-rules';
import { addDays, screeningGaps, usDay } from './screening-rules';
import { Decision, DecisionDto, RequestCorrectionsDto, ScreeningCheckDto, SendForDecisionDto, UploadMvrDto } from './screening.dto';

/** Each decision: the statuses it applies to, the status it leads to, and what is recorded. */
const DECISION_RULES: Record<Decision, { from: DriverStatus[]; to: DriverStatus; action: DriverReviewAction; event: DriverEventType }> = {
 APPROVE: { from: ['AWAITING_DECISION', 'PRE_ADVERSE'], to: 'APPROVED', action: 'APPROVED', event: 'APPROVED' },
 MORE_INFO: { from: ['AWAITING_DECISION', 'PRE_ADVERSE'], to: 'SCREENING', action: 'MORE_INFO', event: 'MORE_INFO_REQUESTED' },
 PRE_ADVERSE: { from: ['AWAITING_DECISION'], to: 'PRE_ADVERSE', action: 'PRE_ADVERSE', event: 'PRE_ADVERSE_RECORDED' },
 REJECT: { from: ['PRE_ADVERSE'], to: 'REJECTED', action: 'REJECTED', event: 'REJECTED' },
};
const WRONG_STAGE: Record<Decision, string> = {
 APPROVE: 'Only a driver waiting for a decision can be approved.', MORE_INFO: 'Only a driver waiting for a decision can be sent back to screening.',
 PRE_ADVERSE: 'Only a driver waiting for a decision can get a pre-adverse notice.', REJECT: 'Record the pre-adverse notice first; the rejection is final only after the waiting period.',
};
const NO_AUTHORIZATION = { message: 'The driver hasn’t signed the background check authorization. Ask them to sign it, or confirm that a signed paper authorization is on file.', missing: ['authorization'] };
// How far back a notice date may be entered: a notice is recorded when it is sent, not weeks later.
const NOTICE_MAX_AGE_DAYS = 30;

/**
 * Screening and the decision. Safety leads, managers and administrators screen: a fixed checklist, the driver's MVR, a
 * request for corrections (the application goes back to the driver through a new link) and the hand-off to the Safety
 * manager. The Safety manager (or an administrator) approves, optionally with conditions, sends the driver back to
 * screening, or rejects in two recorded steps (pre-adverse notice, then the final notice after the waiting period). Safety
 * sends every notice itself; nothing here contacts the driver. Every write locks the driver row and checks its version.
 */
@Injectable()
export class ScreeningService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService, private readonly safety: SafetyService) {}

 async setCheck(user: User, id: string, key: string, dto: ScreeningCheckDto) {
  requireScreener(user);
  if (!SCREENING_CHECKS.includes(key as ScreeningCheckKey)) throw new NotFoundException();
  return writeDriver(this.db, async em => {
   const driver = await this.inScreening(em, id, dto.version);
   const checks = em.getRepository(DriverScreeningCheck);
   if (dto.result === null) await checks.delete({ driverId: id, key: key as ScreeningCheckKey });
   else {
    const note = dto.note || null;
    if (dto.result === 'CONCERN' && !note) throw new BadRequestException('Describe the concern for the Safety manager.');
    if (key === 'MVR' && this.storage.enabled && !await em.getRepository(DriverReport).existsBy({ driverId: id, kind: 'MVR', replacedAt: IsNull() })) throw new BadRequestException('Upload the MVR first.');
    await checks.save({ driverId: id, key: key as ScreeningCheckKey, result: dto.result, note, checkedBy: user.id, checkedAt: new Date() });
   }
   await em.getRepository(Driver).update(id, { version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'SCREENING_CHECKED', { check: key, result: dto.result });
   return { id, version: driver.version + 1 };
  });
 }

 /** Stores the MVR (a readable, unencrypted PDF) and replaces the current one; earlier reports are kept. */
 async uploadMvr(user: User, id: string, dto: UploadMvrDto) {
  requireScreener(user);
  if (!this.storage.enabled) throw new ServiceUnavailableException('Uploads aren’t available right now.');
  if (dto.pulledOn > usDay('latest')) throw new BadRequestException('The MVR date can’t be in the future.');
  if (dto.pulledOn < addDays(usDay('earliest'), -365)) throw new BadRequestException('This MVR is more than a year old. Pull a current one.');
  // Refused before anything is counted or stored; both are checked again under the driver lock below.
  const current = await this.db.getRepository(Driver).findOneBy({ id });
  if (!current) throw new NotFoundException('This driver record no longer exists.');
  if (current.status !== 'SCREENING') throw new ConflictException('This driver isn’t in screening.');
  if (dto.paperAuthorization !== true && !await authorizationSigned(this.db.manager, id)) throw new BadRequestException(NO_AUTHORIZATION);
  await onboardingLimit(this.db, `driver-mvr:${user.id}`, 20, 3600);
  const file = decodePdf(dto.file);
  const pageCount = await inspectPdf(file).catch(() => { throw new BadRequestException('The PDF could not be read. Upload an unencrypted PDF.'); });
  const reportId = randomUUID();
  await this.storage.put(driverReportKey(id, reportId), file, 'application/pdf');
  try {
   return await writeDriver(this.db, async em => {
    const driver = await this.inScreening(em, id, dto.version);
    // An MVR is pulled only with the driver's written authorization: signed here, or on paper and confirmed by the uploader.
    const authorization = await authorizationSigned(em, id) ? 'SIGNED' : dto.paperAuthorization === true ? 'PAPER' : null;
    if (!authorization) throw new BadRequestException(NO_AUTHORIZATION);
    const reports = em.getRepository(DriverReport);
    const previous = await reports.findOneBy({ driverId: id, kind: 'MVR', replacedAt: IsNull() });
    if (previous) await reports.update(previous.id, { replacedAt: new Date() });
    await reports.insert({ id: reportId, driverId: id, kind: 'MVR', pulledOn: dto.pulledOn, pageCount, sha256: sha256(file), byteSize: file.length, uploadedBy: user.id, createdAt: new Date(), authorization });
    await em.getRepository(Driver).update(id, { version: driver.version + 1 });
    await driverEvent(em, user.id, id, 'MVR_UPLOADED', { replaced: !!previous, authorization });
    return { id, version: driver.version + 1 };
   });
  } catch (error) { await this.storage.remove(driverReportKey(id, reportId)); throw error; }
 }

 /** An MVR, current or replaced, for every Safety role; views are rate-limited and recorded like scans. */
 async reportFile(user: User, id: string, reportId: string): Promise<FileResult> {
  await onboardingLimit(this.db, `driver-report-view:${user.id}`, 60, 900);
  const report = await this.db.getRepository(DriverReport).findOneBy({ id: reportId, driverId: id });
  if (!report) throw new NotFoundException('This report no longer exists.');
  const body = await this.storage.get(driverReportKey(id, reportId));
  await driverEvent(this.db.manager, user.id, id, 'MVR_VIEWED', {});
  return { body, type: 'application/pdf', filename: `mvr-${report.pulledOn}.pdf` };
 }

 /**
  * Sends the submitted application back to the driver with a message saying what to correct: it becomes a draft again
  * (answers, SSN and scans kept; verified scans stay verified unless replaced) and a new link is returned once, for Safety
  * to send. The driver resubmits and returns to screening; screening checks are kept.
  */
 async requestCorrections(user: User, id: string, dto: RequestCorrectionsDto) {
  requireScreener(user);
  return writeDriver(this.db, async em => {
   const driver = await this.inScreening(em, id, dto.version);
   const applications = em.getRepository(DriverApplication);
   const application = await applications.findOne({ where: { driverId: id }, lock: { mode: 'pessimistic_write' } });
   if (application?.status !== 'SUBMITTED') throw new ConflictException('The driver hasn’t sent their application.');
   const { link, url } = await this.safety.issueLink(em, user, driver);
   await applications.update(application.id, { status: 'DRAFT', submittedAt: null, correctionNote: dto.message, correctionRequestedAt: new Date(), version: application.version + 1 });
   await em.getRepository(Driver).update(id, { status: 'APPLYING', version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'CORRECTIONS_REQUESTED', {});
   return { id, version: driver.version + 1, expiresAt: link.expiresAt, url };
  });
 }

 /** Hands a fully screened driver to the Safety manager. A refusal lists what is missing (see screeningGaps). */
 async sendForDecision(user: User, id: string, dto: SendForDecisionDto) {
  requireScreener(user);
  return writeDriver(this.db, async em => {
   const driver = await this.inScreening(em, id, dto.version);
   const missing = await screeningGaps(em, id, this.storage.enabled);
   if (missing.length) throw new BadRequestException({ message: 'Finish screening first.', missing });
   const concerns = Number((await em.query(`SELECT count(*) AS n FROM driver_screening_checks WHERE "driverId" = $1 AND result = 'CONCERN'`, [id]))[0].n);
   await em.getRepository(DriverReview).save({ driverId: id, action: 'SENT_FOR_DECISION', note: dto.note || null, previousStatus: 'SCREENING', newStatus: 'AWAITING_DECISION', actorId: user.id });
   await em.getRepository(Driver).update(id, { status: 'AWAITING_DECISION', version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'SENT_FOR_DECISION', { concerns });
   return { id, version: driver.version + 1 };
  });
 }

 async decide(user: User, id: string, dto: DecisionDto) {
  if (!DECIDERS.includes(user.role)) throw new ForbiddenException('Only the Safety manager decides on a driver.');
  const rule = DECISION_RULES[dto.decision], note = dto.note || null, conditions = dto.conditions || null;
  if (dto.decision !== 'APPROVE' && !note) throw new BadRequestException('Give the reason.');
  if (dto.decision !== 'APPROVE' && conditions) throw new BadRequestException('Conditions go with an approval only.');
  const notice = dto.decision === 'PRE_ADVERSE' || dto.decision === 'REJECT';
  if (notice && (dto.noticeSent !== true || !dto.noticeSentOn)) throw new BadRequestException('Send the notice first, then confirm it and enter the date it was sent.');
  if (!notice && dto.noticeSentOn) throw new BadRequestException('Only a pre-adverse or final notice has a date.');
  if (notice && dto.noticeSentOn! > usDay('latest')) throw new BadRequestException('The notice date can’t be in the future.');
  if (dto.decision === 'PRE_ADVERSE' && dto.noticeSentOn! < addDays(usDay('earliest'), -NOTICE_MAX_AGE_DAYS)) throw new BadRequestException('Record the notice when you send it; this date is too long ago.');
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, dto.version);
   if (!rule.from.includes(driver.status)) throw new ConflictException(WRONG_STAGE[dto.decision]);
   if (dto.decision === 'APPROVE' && !await em.getRepository(DriverApplication).existsBy({ driverId: id, status: 'SUBMITTED' })) throw new ConflictException('The driver’s application isn’t submitted.');
   const reviews = em.getRepository(DriverReview);
   if (dto.decision === 'PRE_ADVERSE') {
    // The notice follows the decision to send it, so it can't be dated before the driver reached the Safety manager; a
    // backdated notice would end the driver's waiting period before it began.
    const sent = await reviews.findOne({ where: { driverId: id, action: 'SENT_FOR_DECISION' }, order: { createdAt: 'DESC' } });
    if (sent && dto.noticeSentOn! < usDay('earliest', sent.createdAt)) throw new BadRequestException('The notice can’t be dated before the driver was sent for a decision.');
   }
   if (dto.decision === 'REJECT') {
    const preAdverse = await reviews.findOne({ where: { driverId: id, action: 'PRE_ADVERSE' }, order: { createdAt: 'DESC' } });
    const from = earliestFinalRejection(preAdverse!.noticeSentOn!);
    if (usDay('earliest') < from || dto.noticeSentOn! < from) throw new ConflictException(`The driver has until the waiting period ends to respond. The rejection can be final from ${from} (Pacific time).`);
   }
   const closed = rule.to === 'REJECTED', now = new Date();
   await reviews.save({ driverId: id, action: rule.action, note, conditions, noticeSentOn: notice ? dto.noticeSentOn! : null,
    previousStatus: driver.status, newStatus: rule.to, actorId: user.id });
   // A final rejection closes the record; the submitted link's session (if still open) stops too.
   if (closed) await em.getRepository(DriverLink).update({ driverId: id, revokedAt: IsNull() }, { revokedAt: now });
   await em.getRepository(Driver).update(id, { status: rule.to, version: driver.version + 1, ...(closed ? { closedAt: now, statusReason: null } : {}) });
   await driverEvent(em, user.id, id, rule.event, dto.decision === 'APPROVE' ? { conditional: !!conditions } : {});
   return { id, version: driver.version + 1 };
  });
 }

 /**
  * Drivers waiting for the signed-in person, for the sidebar: for the Safety manager and administrators, decisions and
  * pre-adverse notices whose waiting period is over (the final notice is due); for a Safety lead, the drivers in screening
  * they lead. Other roles get null (no count).
  */
 async waitingCount(user: User): Promise<number | null> {
  if (DECIDERS.includes(user.role)) {
   const rows: { status: DriverStatus; notice: string | null }[] = await this.db.query(`SELECT d.status, (SELECT to_char(r."noticeSentOn", 'YYYY-MM-DD') FROM driver_reviews r
    WHERE r."driverId" = d.id AND r.action = 'PRE_ADVERSE' ORDER BY r."createdAt" DESC LIMIT 1) AS notice FROM drivers d WHERE d.status IN ('AWAITING_DECISION','PRE_ADVERSE')`);
   const today = usDay('earliest');
   return rows.filter(row => row.status === 'AWAITING_DECISION' || (row.notice !== null && earliestFinalRejection(row.notice) <= today)).length;
  }
  if (user.role !== Role.SAFETY_LEAD) return null;
  const [row] = await this.db.query(`SELECT count(*) AS n FROM drivers WHERE status = 'SCREENING' AND "safetyLeadId" = $1`, [user.id]);
  return Number(row.n);
 }

 private async inScreening(em: EntityManager, id: string, version: number) {
  const driver = await lockOpenDriver(em, id, version);
  if (driver.status !== 'SCREENING') throw new ConflictException('This driver isn’t in screening.');
  return driver;
 }
}
