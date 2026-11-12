import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { IsBase64, IsBoolean, IsDateString, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { inspectPdf } from '../documents/certificate';
import { MAX_PDF_BYTES } from '../documents/documents.dto';
import { decodePdf, sha256 } from '../documents/images';
import { onboardingLimit } from '../onboarding/rate-limit';
import { CURRENT_LAYOUT, driverReportKey, StorageService } from '../storage/storage.service';
import { User } from '../users/user.entity';
import { CLEARERS } from './clearance.service';
import { firstSigned } from './consent-rules';
import { driverEvent, lockOpenDriver, ownsDriver, SCREENERS, writeDriver } from './driver-records';
import { driverLicenseRules } from './license-rules';
import { oneLine } from './dto-helpers';
import { NoSsn } from './pii';
import { Driver, DriverClearanceItem, DriverReport, type DriverStatus } from './safety.entity';
import { ScanUploadDto } from './scan.dto';
import { oneUpload, uploadedPdf } from './scan';
import { addDays, usDay } from './screening-rules';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A PSP report Safety pulled from FMCSA's site, with the driver's consent (signed here, or on paper and confirmed). */
export class UploadPspDto {
 @IsInt() @Min(1) version!: number;
 @IsString() @IsBase64() @MaxLength(Math.ceil(MAX_PDF_BYTES / 3) * 4) file!: string;
 @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the date the report was pulled.' }) pulledOn!: string;
 @IsOptional() @IsBoolean() paperAuthorization?: boolean;
}
/** A DL driver's road test: when, who gave it, in what, the result and the signed certificate (a PDF or photographed pages). */
export class RoadTestDto extends ScanUploadDto {
 @IsInt() @Min(1) version!: number;
 @IsString() @IsDateString({ strict: true }, { message: 'Enter a real date.' }) @Matches(DATE, { message: 'Enter the date of the road test.' }) givenOn!: string;
 @oneLine() @IsString() @MinLength(1, { message: 'Say who gave the road test.' }) @MaxLength(100) @NoSsn() givenBy!: string;
 @oneLine() @IsString() @MinLength(1, { message: 'Say which vehicle was used.' }) @MaxLength(100) @NoSsn() vehicle!: string;
 @IsBoolean() passed!: boolean;
 @oneLine() @IsOptional() @IsString() @MaxLength(500) @NoSsn() note?: string;
}

// The PSP report is pulled during screening or the decision (Safety's practice) or during clearance.
const PSP_STATUSES: readonly DriverStatus[] = ['SCREENING', 'AWAITING_DECISION', 'PRE_ADVERSE', 'APPROVED'];
const NO_PSP_CONSENT = { message: 'The driver hasn’t signed the PSP disclosure and authorization. Ask them to sign it, or confirm that the signed paper form is on file.', missing: ['psp-authorization'] };

/**
 * What a driver's license adds to screening and clearance (section 39): the PSP report for CDL drivers and anyone who once
 * held a CDL, and the road test with its signed certificate for a DL driver (a CDL is accepted in its place). Files are
 * stored before the transaction, every rule is checked before storing and again under the driver lock, and a refused
 * write removes the file it stored.
 */
@Injectable()
export class LicenseItemsService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService) {}

 async uploadPsp(user: User, id: string, dto: UploadPspDto) {
  if (!this.storage.enabled) throw new ServiceUnavailableException('Uploads aren’t available right now.');
  this.reportDate(dto.pulledOn, 'report');
  await this.pspAllowed(this.db.manager, user, id, dto);
  await onboardingLimit(this.db, `driver-psp:${user.id}`, 20, 3600);
  const file = decodePdf(dto.file);
  const pageCount = await inspectPdf(file).catch(() => { throw new BadRequestException('The PDF could not be read. Upload an unencrypted PDF.'); });
  const reportId = randomUUID(), stored = { id: reportId, driverId: id, kind: 'PSP', storageLayout: CURRENT_LAYOUT };
  await this.storage.put(driverReportKey(stored), file, 'application/pdf');
  try {
   return await writeDriver(this.db, async em => {
    const driver = await lockOpenDriver(em, id, dto.version);
    const authorization = await this.pspAllowed(em, user, id, dto);
    const reports = em.getRepository(DriverReport);
    const previous = await reports.findOneBy({ driverId: id, kind: 'PSP', replacedAt: IsNull() });
    if (previous) await reports.update(previous.id, { replacedAt: new Date() });
    await reports.insert({ id: reportId, driverId: id, kind: 'PSP', pulledOn: dto.pulledOn, pageCount, sha256: sha256(file), byteSize: file.length, uploadedBy: user.id, createdAt: new Date(), authorization, storageLayout: CURRENT_LAYOUT });
    await em.getRepository(Driver).update(id, { version: driver.version + 1 });
    await driverEvent(em, user.id, id, 'PSP_UPLOADED', { replaced: !!previous, authorization });
    return { id, version: driver.version + 1 };
   });
  } catch (error) { await this.storage.remove(driverReportKey(stored)); throw error; }
 }

 /** Records a DL driver's road test: passed completes the item, not passed leaves it in progress with what happened. */
 async recordRoadTest(user: User, id: string, dto: RoadTestDto) {
  this.reportDate(dto.givenOn, 'road test');
  const upload = this.storage.enabled ? oneUpload(dto, 'Add the signed road test certificate: a PDF or photos of its pages.') : null;
  await this.roadTestAllowed(this.db.manager, user, id);
  let stored: { id: string; driverId: string; kind: string; storageLayout: typeof CURRENT_LAYOUT } | null = null, pdf: { body: Buffer; pageCount: number } | null = null;
  if (upload) {
   await onboardingLimit(this.db, `driver-road-test:${user.id}`, 20, 3600);
   pdf = await uploadedPdf(upload, 10);
   stored = { id: randomUUID(), driverId: id, kind: 'ROAD_TEST', storageLayout: CURRENT_LAYOUT };
   await this.storage.put(driverReportKey(stored), pdf.body, 'application/pdf');
  }
  try {
   return await writeDriver(this.db, async em => {
    const driver = await lockOpenDriver(em, id, dto.version);
    await this.roadTestAllowed(em, user, id);
    if (stored && pdf) {
     const reports = em.getRepository(DriverReport);
     const previous = await reports.findOneBy({ driverId: id, kind: 'ROAD_TEST', replacedAt: IsNull() });
     if (previous) await reports.update(previous.id, { replacedAt: new Date() });
     await reports.insert({ id: stored.id, driverId: id, kind: 'ROAD_TEST', pulledOn: dto.givenOn, pageCount: pdf.pageCount, sha256: sha256(pdf.body), byteSize: pdf.body.length, uploadedBy: user.id, createdAt: new Date(), authorization: null, storageLayout: CURRENT_LAYOUT });
    }
    // Who gave it and in what are staff text, kept on the item; the event holds the result only.
    const note = [`Given by ${dto.givenBy} in ${dto.vehicle}.`, dto.passed ? '' : 'Not passed.', dto.note ?? ''].filter(Boolean).join(' ').slice(0, 1000);
    await em.getRepository(DriverClearanceItem).save({ driverId: id, key: 'ROAD_TEST', status: dto.passed ? 'COMPLETED' : 'IN_PROGRESS', result: null, doneOn: dto.passed ? dto.givenOn : null, note, updatedBy: user.id, updatedAt: new Date() });
    await em.getRepository(Driver).update(id, { version: driver.version + 1 });
    await driverEvent(em, user.id, id, 'ROAD_TEST_RECORDED', { certificate: !!stored });
    return { id, version: driver.version + 1 };
   });
  } catch (error) { if (stored) await this.storage.remove(driverReportKey(stored)); throw error; }
 }

 /** Who may upload the PSP report now, and how the driver's consent is on file ('SIGNED' or 'PAPER'). */
 private async pspAllowed(em: EntityManager, user: User, id: string, dto: UploadPspDto): Promise<'SIGNED' | 'PAPER'> {
  const driver = await this.driver(em, id);
  if (!PSP_STATUSES.includes(driver.status)) throw new ConflictException('A PSP report is uploaded during screening, the decision or clearance.');
  const screener = SCREENERS.includes(user.role), clearer = driver.status === 'APPROVED' && (CLEARERS.includes(user.role) || await ownsDriver(em, user, id));
  if (!screener && !clearer) throw new ForbiddenException('Only Safety leads, the Safety Director and, during clearance, the driver’s Safety Manager can upload the PSP report.');
  if (!(await driverLicenseRules(em, id)).psp) throw new BadRequestException('A PSP report is only for CDL drivers and drivers who once held a CDL.');
  const signedOn = await firstSigned(em, id, 'PSP_AUTHORIZATION');
  if (!signedOn && dto.paperAuthorization !== true) throw new BadRequestException(NO_PSP_CONSENT);
  if (signedOn && dto.pulledOn < signedOn) throw new BadRequestException('The report can’t be dated before the driver signed the PSP consent.');
  return signedOn ? 'SIGNED' : 'PAPER';
 }
 private async roadTestAllowed(em: EntityManager, user: User, id: string) {
  const driver = await this.driver(em, id);
  if (driver.status !== 'APPROVED') throw new ConflictException('The road test is recorded during clearance, once the Safety Director approves the driver.');
  if (!CLEARERS.includes(user.role) && !await ownsDriver(em, user, id)) throw new ForbiddenException('Only the driver’s Safety Manager and the Safety Director can work on clearance.');
  if ((await driverLicenseRules(em, id)).roadTestAccepted) throw new BadRequestException('A CDL is accepted in place of a road test.');
 }
 private async driver(em: EntityManager, id: string) {
  const driver = await em.getRepository(Driver).findOneBy({ id });
  if (!driver) throw new NotFoundException('This driver record no longer exists.');
  return driver;
 }
 /** A report or test date: not in the future and within the last year. */
 private reportDate(value: string, what: string) {
  if (value > usDay('latest')) throw new BadRequestException(`The ${what} date can’t be in the future.`);
  if (value < addDays(usDay('earliest'), -365)) throw new BadRequestException(`This ${what} is more than a year old. It has to be done again.`);
 }
}
