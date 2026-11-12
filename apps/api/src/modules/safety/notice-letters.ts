import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBase64, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { PDFDocument } from 'pdf-lib';
import { DataSource, IsNull } from 'typeorm';
import { MAX_PDF_BYTES } from '../documents/documents.dto';
import type { FileResult } from '../documents/documents.service';
import { checkedFields, DocumentFieldDto, type FieldKind, fillFields, MAX_FIELDS } from '../documents/fields';
import { sha256 } from '../documents/images';
import { onboardingLimit } from '../onboarding/rate-limit';
import { driverReportKey, noticeLetterKey, StorageService } from '../storage/storage.service';
import { User } from '../users/user.entity';
import { DECIDERS, driverEvent } from './driver-records';
import { publishPdfVersion, readPublishedPdf } from './published-pdfs';
import { DriverNoticeLetter, NOTICE_KINDS, NOTICE_LABELS, NOTICE_SEGMENTS, type NoticeKind } from './notice-letter.entity';
import { Driver, DriverApplication, DriverReport, type DriverStatus } from './safety.entity';
import { personName } from './sql';

/** A new version of a notice letter: the kind, a title and the PDF (base64, 3 MB at most), with where the details go. */
export class PublishNoticeLetterDto {
 @IsIn(NOTICE_KINDS) kind!: NoticeKind;
 @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value) @IsString() @MinLength(1) @MaxLength(200) title!: string;
 @IsString() @IsBase64() @MaxLength(Math.ceil(MAX_PDF_BYTES / 3) * 4) file!: string;
 @IsOptional() @IsArray() @ArrayMaxSize(MAX_FIELDS) @ValidateNested({ each: true }) @Type(() => DocumentFieldDto) fields?: DocumentFieldDto[];
}
// Which letter fits where the decision stands: the pre-adverse notice before it is recorded (awaiting the decision, or
// during clearance), the final notice while it is out.
// What a letter may have filled in.
const LETTER_FIELDS: readonly FieldKind[] = ['NAME', 'ADDRESS', 'DATE'];
const LETTER_STATUSES: Record<NoticeKind, readonly DriverStatus[]> = { PRE_ADVERSE: ['AWAITING_DECISION', 'APPROVED'], FINAL: ['PRE_ADVERSE'] };

/**
 * The pre-adverse and final notice letters (designed as the Safety follow-ups group). The Safety manager or an
 * administrator publishes the PDFs their adviser approved, each an immutable version, marking where the driver's name,
 * address and the date go; the workspace adds no legal text. The deciders download a driver's letter filled in from the
 * current version (the pre-adverse one with their current MVR attached) and send it themselves. Letters are made on
 * download and never stored or emailed; the event records only the kind and whether the MVR was attached.
 */
@Injectable()
export class NoticeLetterService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService) {}

 /** Every version of both letters, newest first, for the Forms and letters page. */
 async list() {
  const rows: (DriverNoticeLetter & { uploader: string | null })[] = await this.db.query(`SELECT l.id, l.kind, l.version, l.title, l.sha256, l."pageCount", l.fields, l."createdAt",
   ${personName('u')} AS uploader FROM driver_notice_letters l LEFT JOIN users u ON u.id = l."uploadedBy" ORDER BY l.kind, l.version DESC`);
  return NOTICE_KINDS.map(kind => ({ kind, label: NOTICE_LABELS[kind], versions: rows.filter(row => row.kind === kind) }));
 }

 /** The current version of each letter (or null), so the decision dialogs offer Download letter only when one exists. */
 async current(): Promise<Record<NoticeKind, { version: number; pageCount: number } | null>> {
  const rows: { kind: NoticeKind; version: number; pageCount: number }[] = await this.db.query(`SELECT DISTINCT ON (kind) kind, version, "pageCount" FROM driver_notice_letters ORDER BY kind, version DESC`);
  const current = (kind: NoticeKind) => { const row = rows.find(entry => entry.kind === kind); return row ? { version: row.version, pageCount: row.pageCount } : null; };
  return { PRE_ADVERSE: current('PRE_ADVERSE'), FINAL: current('FINAL') };
 }

 async publish(user: User, dto: PublishNoticeLetterDto) {
  if (!DECIDERS.includes(user.role)) throw new ForbiddenException('Only the Safety Director publishes notice letters.');
  if (!this.storage.enabled) throw new ServiceUnavailableException('Document storage is not configured.');
  await onboardingLimit(this.db, `notice-publish:${user.id}`, 10, 3600);
  const { file, pageCount } = await readPublishedPdf(dto.file);
  // The driver's name, address and the date, and nothing else: nobody signs a letter.
  const fields = checkedFields(dto.fields, pageCount, { signature: false, typedName: true, countersign: false, americanName: false, address: true, kinds: LETTER_FIELDS });
  const id = randomUUID(), key = noticeLetterKey({ id, kind: dto.kind });
  // The same lock family as consent forms, with its own number per letter.
  return publishPdfVersion(this.db, this.storage, { file, key, lock: 100 + NOTICE_KINDS.indexOf(dto.kind), table: 'driver_notice_letters', kind: dto.kind,
   save: (em, version) => em.getRepository(DriverNoticeLetter).save({ id, kind: dto.kind, version, title: dto.title, sha256: sha256(file), byteSize: file.length, pageCount, fields, uploadedBy: user.id }) });
 }

 /** A published version as uploaded (every Safety role, through the controller's roles). */
 async file(id: string): Promise<FileResult> {
  const letter = await this.db.getRepository(DriverNoticeLetter).findOneBy({ id });
  if (!letter) throw new NotFoundException();
  return { body: await this.storage.get(noticeLetterKey(letter)), type: 'application/pdf', filename: `${letter.kind.toLowerCase().replace(/_/g, '-')}-notice-v${letter.version}.pdf` };
 }

 /** The driver's letter: the current version with their name, address and today's date, and for the pre-adverse notice their current MVR. */
 async forDriver(user: User, driverId: string, segment: string): Promise<FileResult> {
  const kind = Object.hasOwn(NOTICE_SEGMENTS, segment) ? NOTICE_SEGMENTS[segment] : undefined;
  if (!kind) throw new NotFoundException();
  if (!DECIDERS.includes(user.role)) throw new ForbiddenException('Only the Safety Director prepares notice letters.');
  await onboardingLimit(this.db, `notice-letter:${user.id}`, 30, 900);
  const driver = await this.db.getRepository(Driver).findOneBy({ id: driverId });
  if (!driver) throw new NotFoundException('This driver record no longer exists.');
  if (!LETTER_STATUSES[kind].includes(driver.status)) throw new ConflictException(kind === 'FINAL' ? 'The final letter follows a pre-adverse notice.' : 'The pre-adverse letter is prepared while a decision is open.');
  const letter = await this.db.getRepository(DriverNoticeLetter).findOne({ where: { kind }, order: { version: 'DESC' } });
  if (!letter) throw new NotFoundException(`No ${NOTICE_LABELS[kind].toLowerCase()} is published yet.`);
  const fields = (await this.db.getRepository(DriverApplication).findOneBy({ driverId }))?.fields ?? {};
  const name = [fields.legalFirstName, fields.legalMiddleName, fields.legalLastName].filter(Boolean).join(' ') || `${driver.firstName} ${driver.lastName}`.trim();
  const address = [fields.addressLine1, fields.addressLine2, fields.city, [fields.state, fields.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const pdf = await PDFDocument.load(await this.storage.get(noticeLetterKey(letter)), { updateMetadata: false });
  await fillFields(pdf, letter.fields, [{ signerRole: 'APPLICANT', typedName: name, signedAt: new Date(), address, signatureImage: null }]);
  // The pre-adverse notice goes with a copy of the report it is based on.
  const mvr = kind === 'PRE_ADVERSE' ? await this.db.getRepository(DriverReport).findOneBy({ driverId, kind: 'MVR', replacedAt: IsNull() }) : null;
  if (mvr) {
   const report = await PDFDocument.load(await this.storage.get(driverReportKey(mvr)), { updateMetadata: false });
   for (const page of await pdf.copyPages(report, report.getPageIndices())) pdf.addPage(page);
  }
  await driverEvent(this.db.manager, user.id, driverId, 'NOTICE_LETTER_DOWNLOADED', { kind, withMvr: !!mvr });
  return { body: Buffer.from(await pdf.save()), type: 'application/pdf', filename: `${segment}-notice.pdf` };
 }
}
