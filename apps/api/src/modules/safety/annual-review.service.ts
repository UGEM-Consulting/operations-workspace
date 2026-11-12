import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { decodePdf, sha256 } from '../documents/images';
import { inspectPdf } from '../documents/certificate';
import { onboardingLimit } from '../onboarding/rate-limit';
import { CURRENT_LAYOUT, driverReportKey, StorageService } from '../storage/storage.service';
import { User } from '../users/user.entity';
import { AnnualReviewDto } from './annual-review.dto';
import { CLEARERS } from './clearance.service';
import { authorizationSigned } from './consent-rules';
import { lockOpenDriver, ownsDriver, writeDriver, driverEvent } from './driver-records';
import { DriverReport } from './safety.entity';
import { addDays, usDay } from './screening-rules';
import { personName } from './sql';

/** A yearly review is due this long after the driver was cleared or last reviewed (FMCSA 391.25: at least every 12 months). */
export const REVIEW_INTERVAL_DAYS = 365;
/** The due list shows reviews this many days before they fall due. */
export const REVIEW_WARNING_DAYS = 60;
/** The yearly MVR must have been pulled this recently. */
const MAX_MVR_AGE_DAYS = 90;
const NO_AUTHORIZATION = { message: 'The driver hasn’t signed the background check authorization. Ask them to sign it, or confirm that a signed paper authorization is on file.', missing: ['authorization'] };

/**
 * Yearly reviews of cleared drivers: the owner or Safety manager (or an administrator) pulls a new MVR, reviews the driving
 * record and records the outcome. Every Safety role reads them. Reviews are append-only; the MVR is an ANNUAL_MVR report.
 */
const NOT_REVIEWER = 'Only the driver’s Safety Manager and the Safety Director can record a yearly review.';

@Injectable()
export class AnnualReviewService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService) {}

 async record(user: User, id: string, dto: AnnualReviewDto) {
  if (dto.outcome === 'NOT_QUALIFIED' && !dto.note) throw new BadRequestException('Say why the driver isn’t qualified.');
  // Checked again under the driver lock; this early check keeps someone who'd be refused from storing a file first.
  if (!CLEARERS.includes(user.role) && !await ownsDriver(this.db.manager, user, id)) throw new ForbiddenException(NOT_REVIEWER);
  const today = usDay('latest');
  if (dto.reviewedOn > today) throw new BadRequestException('The review date can’t be in the future.');
  let file: Buffer | null = null, pageCount = 0;
  if (this.storage.enabled && !dto.mvr) throw new BadRequestException({ message: 'Attach the MVR you pulled for this review.', missing: ['mvr'] });
  if (dto.mvr) {
   if (!this.storage.enabled) throw new ServiceUnavailableException('Uploads aren’t available right now.');
   if (dto.mvr.pulledOn > today) throw new BadRequestException('The MVR date can’t be in the future.');
   if (dto.mvr.pulledOn < addDays(usDay('earliest'), -MAX_MVR_AGE_DAYS)) throw new BadRequestException('This MVR is more than 90 days old. Pull a current one.');
   if (dto.mvr.pulledOn > dto.reviewedOn) throw new BadRequestException('The MVR can’t be pulled after the review date.');
   await onboardingLimit(this.db, `driver-mvr:${user.id}`, 20, 3600);
   file = decodePdf(dto.mvr.file);
   pageCount = await inspectPdf(file).catch(() => { throw new BadRequestException('The PDF could not be read. Upload an unencrypted PDF.'); });
  }
  const reportId = randomUUID(), stored = { id: reportId, driverId: id, kind: 'ANNUAL_MVR', storageLayout: CURRENT_LAYOUT } as const;
  if (file) await this.storage.put(driverReportKey(stored), file, 'application/pdf');
  try {
   return await writeDriver(this.db, async em => {
    const driver = await lockOpenDriver(em, id, dto.version);
    if (!CLEARERS.includes(user.role) && !await ownsDriver(em, user, id)) throw new ForbiddenException(NOT_REVIEWER);
    if (driver.status !== 'CLEARED' || !driver.clearedAt) throw new ConflictException('Yearly reviews start once the driver is cleared.');
    if (dto.reviewedOn < usDay('latest', driver.clearedAt)) throw new BadRequestException('The review can’t be dated before the driver was cleared.');
    const [last] = await em.query(`SELECT to_char(max("reviewedOn"), 'YYYY-MM-DD') AS "on" FROM driver_annual_reviews WHERE "driverId" = $1`, [id]) as { on: string | null }[];
    if (last?.on && dto.reviewedOn < last.on) throw new BadRequestException('The review can’t be dated before the last one.');
    let reportRow: string | null = null;
    if (file && dto.mvr) {
     const authorization = await authorizationSigned(em, id) ? 'SIGNED' : dto.mvr.paperAuthorization === true ? 'PAPER' : null;
     if (!authorization) throw new BadRequestException(NO_AUTHORIZATION);
     const reports = em.getRepository(DriverReport);
     const previous = await reports.findOneBy({ driverId: id, kind: 'ANNUAL_MVR', replacedAt: IsNull() });
     if (previous) await reports.update(previous.id, { replacedAt: new Date() });
     await reports.insert({ id: reportId, driverId: id, kind: 'ANNUAL_MVR', pulledOn: dto.mvr.pulledOn, pageCount, sha256: sha256(file), byteSize: file.length, uploadedBy: user.id, createdAt: new Date(), authorization, storageLayout: CURRENT_LAYOUT });
     reportRow = reportId;
    }
    await em.query(`INSERT INTO driver_annual_reviews ("driverId", "reviewedOn", outcome, note, "reportId", "reviewerId") VALUES ($1, $2, $3, $4, $5, $6)`,
     [id, dto.reviewedOn, dto.outcome, dto.note || null, reportRow, user.id]);
    await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [id]);
    // The outcome and whether an MVR came with it; never the note.
    await driverEvent(em, user.id, id, 'ANNUAL_REVIEW_RECORDED', { outcome: dto.outcome, withMvr: !!reportRow });
    return { id, version: driver.version + 1 };
   });
  } catch (error) { if (file) await this.storage.remove(driverReportKey(stored)); throw error; }
 }

 /** A driver's reviews, newest first, with when the next one is due. */
 async forDriver(id: string, clearedAt: Date | null) {
  const items = await this.db.query(`SELECT r.id, to_char(r."reviewedOn", 'YYYY-MM-DD') AS "reviewedOn", r.outcome, r.note, r."createdAt", r."fromPaper",
    ${personName('u')} AS reviewer,
    CASE WHEN m.id IS NULL THEN NULL ELSE json_build_object('id', m.id, 'pulledOn', to_char(m."pulledOn", 'YYYY-MM-DD'), 'pageCount', m."pageCount") END AS mvr
   FROM driver_annual_reviews r LEFT JOIN users u ON u.id = r."reviewerId" LEFT JOIN driver_reports m ON m.id = r."reportId" WHERE r."driverId" = $1 ORDER BY r."reviewedOn" DESC, r."createdAt" DESC`, [id]) as { reviewedOn: string; outcome: string }[];
  // A driver added from a paper file with no last review on record is due from the day they were added.
  const [added] = await this.db.query(`SELECT "createdAt" FROM existing_driver_records WHERE "driverId" = $1`, [id]) as { createdAt: Date }[];
  const base = items[0]?.reviewedOn ?? (added ? addDays(usDay('latest', added.createdAt), -REVIEW_INTERVAL_DAYS) : clearedAt ? usDay('latest', clearedAt) : null);
  // storageEnabled: whether an MVR file can be attached (it is required then); staging may run without storage.
  return { items, dueOn: base ? addDays(base, REVIEW_INTERVAL_DAYS) : null, notQualified: items[0]?.outcome === 'NOT_QUALIFIED', storageEnabled: this.storage.enabled };
 }

 /** Cleared drivers whose yearly review is overdue, due within REVIEW_WARNING_DAYS, or whose last review found them not qualified. */
 async due() {
  const today = usDay('latest');
  const rows = await this.db.query(`SELECT d.id AS "driverId", d."firstName", d."lastName", to_char(d."clearedAt" AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS "clearedOn",
    (SELECT to_char(r."reviewedOn", 'YYYY-MM-DD') FROM driver_annual_reviews r WHERE r."driverId" = d.id ORDER BY r."reviewedOn" DESC, r."createdAt" DESC LIMIT 1) AS "lastOn",
    (SELECT r.outcome FROM driver_annual_reviews r WHERE r."driverId" = d.id ORDER BY r."reviewedOn" DESC, r."createdAt" DESC LIMIT 1) AS "lastOutcome",
    ${personName('o')} AS owner,
    (SELECT to_char(x."createdAt" AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') FROM existing_driver_records x WHERE x."driverId" = d.id) AS "addedOn"
   FROM drivers d LEFT JOIN driver_owners w ON w."driverId" = d.id AND w."endedAt" IS NULL LEFT JOIN users o ON o.id = w."ownerId" WHERE d.status = 'CLEARED'`) as
   { driverId: string; firstName: string; lastName: string; clearedOn: string; lastOn: string | null; lastOutcome: string | null; owner: string | null; addedOn: string | null }[];
  const items = rows.map(row => ({ driverId: row.driverId, firstName: row.firstName, lastName: row.lastName, owner: row.owner, lastReviewedOn: row.lastOn,
    dueOn: row.lastOn ? addDays(row.lastOn, REVIEW_INTERVAL_DAYS) : row.addedOn ?? addDays(row.clearedOn, REVIEW_INTERVAL_DAYS), notQualified: row.lastOutcome === 'NOT_QUALIFIED' }))
   .filter(row => row.dueOn <= addDays(today, REVIEW_WARNING_DAYS) || row.notQualified)
   .map(row => ({ ...row, overdue: row.dueOn < today })).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  return { today, warningDays: REVIEW_WARNING_DAYS, items };
 }
}
