import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Role, User } from '../users/user.entity';
import { AddEmployerDto, ClearanceItemDto, UpdateEmployerDto } from './clearance.dto';
import { DriverVersionDto } from './driver-application.dto';
import { driverEvent, lockOpenDriver, ownsDriver, writeDriver } from './driver-records';
import { CLEARANCE_ITEMS, CLEARANCE_OPTIONAL, CLEARANCE_RESULTS, type ClearanceKey, type ClearanceStatus, Driver, DriverClearanceItem, DriverPreviousEmployer } from './safety.entity';
import { addDays, usDay } from './screening-rules';

/** Who may run clearance besides the driver's current owner. */
export const CLEARERS = [Role.SYSTEM_ADMIN, Role.SAFETY_MANAGER];
// Results come from the last year: an older test or query has to be done again.
const MAX_AGE_DAYS = 365;
const oldestDate = () => addDays(usDay('earliest'), -MAX_AGE_DAYS);
type EmployerAnswers = { answeredOn: string | null; goodFaithOn: string | null };

/** Why the previous employers item can't have this status with these employers; null when it can. */
function employersProblem(status: string, employers: EmployerAnswers[]): string | null {
 if (status === 'NOT_NEEDED') return employers.length ? 'This item can’t be not needed while employers are listed.' : null;
 if (status !== 'COMPLETED') return null;
 if (!employers.length) return 'Add the employers you asked, or mark this item not needed.';
 return employers.some(row => !row.answeredOn && !row.goodFaithOn) ? 'Every employer needs an answer or a recorded good-faith effort first.' : null;
}

/**
 * What still stands between an approved driver and Cleared, as codes the web turns into words: `owner` (no active safety
 * staff owner), `clearance:<KEY>` (an item not completed or not needed), `expired:<KEY>` (done, but more than a year ago)
 * and `employers` (the item is done but an employer added or changed since doesn't allow it). Empty means ready.
 */
export function clearanceGaps(items: { key: string; status: string; doneOn: string | null }[], hasOwner: boolean, employers: EmployerAnswers[]): string[] {
 const gaps = hasOwner ? [] : ['owner'], oldest = oldestDate();
 for (const key of CLEARANCE_ITEMS) {
  const item = items.find(row => row.key === key);
  if (item?.status !== 'COMPLETED' && item?.status !== 'NOT_NEEDED') gaps.push(`clearance:${key}`);
  else if (item.doneOn && item.doneOn < oldest) gaps.push(`expired:${key}`);
  else if (key === 'PREVIOUS_EMPLOYERS' && employersProblem(item.status, employers)) gaps.push('employers');
 }
 return gaps;
}

/** Whether the driver's current owner can still look after them: an active account that is still safety staff. */
export async function hasActiveOwner(em: EntityManager, driverId: string): Promise<boolean> {
 const rows: unknown[] = await em.query(`SELECT 1 FROM driver_owners x JOIN users u ON u.id = x."ownerId"
  WHERE x."driverId" = $1 AND x."endedAt" IS NULL AND u.status = 'ACTIVE' AND u.role::text = 'SAFETY_STAFF'`, [driverId]);
 return rows.length > 0;
}

/**
 * Clearance of an approved driver: the fixed checklist, the previous employers asked about the driver's safety record, and
 * Cleared. The driver's current owner, the Safety manager and administrators do this; every write locks the driver row,
 * checks its version and the driver's status, and records metadata-only events. Results only: no drug test or medical
 * details are entered (notes say so). Once cleared, the checklist is read-only.
 */
@Injectable()
export class ClearanceService {
 constructor(private readonly db: DataSource) {}

 async setItem(user: User, id: string, key: string, dto: ClearanceItemDto) {
  if (!CLEARANCE_ITEMS.includes(key as ClearanceKey)) throw new NotFoundException();
  const item = key as ClearanceKey, results = CLEARANCE_RESULTS[item];
  return this.write(user, id, dto.version, async (em, driver) => {
   const items = em.getRepository(DriverClearanceItem), note = dto.note || null;
   let status: ClearanceStatus | null, result: string | null = null;
   if (results) {
    if (dto.status !== undefined && dto.status !== null) throw new BadRequestException('Record the result; it sets the status.');
    if (dto.result === undefined) status = null;
    else {
     if (!(dto.result in results)) throw new BadRequestException('Choose one of the results.');
     result = dto.result; status = results[dto.result];
    }
   } else {
    if (dto.result !== undefined) throw new BadRequestException('This item has no result to record.');
    status = dto.status ?? null;
   }
   if (status === null) {
    // Nothing recorded and nothing chosen: nothing happened, so no event and no new version.
    const removed = await items.delete({ driverId: id, key: item });
    if (!removed.affected) return { id, version: driver.version };
   } else {
    // A result is dated (the date on the lab report or the query); a status-based item only once it is completed.
    const doneOn = result || status === 'COMPLETED' ? this.date(dto.doneOn) : null;
    if (status === 'BLOCKED' && !results && !note) throw new BadRequestException('Say what is blocking this item.');
    if (status === 'NOT_NEEDED' && !CLEARANCE_OPTIONAL.includes(item)) throw new BadRequestException('This item is needed for every driver.');
    if (status === 'NOT_NEEDED' && !note) throw new BadRequestException('Say why this item isn’t needed.');
    if (item === 'PREVIOUS_EMPLOYERS') {
     const problem = employersProblem(status, await em.getRepository(DriverPreviousEmployer).findBy({ driverId: id }));
     if (problem) throw new BadRequestException(problem);
    }
    await items.save({ driverId: id, key: item, status, result, doneOn, note, updatedBy: user.id, updatedAt: new Date() });
   }
   await driverEvent(em, user.id, id, 'CLEARANCE_RECORDED', { item, status });
   return this.bump(em, driver);
  });
 }

 async addEmployer(user: User, id: string, dto: AddEmployerDto) {
  return this.write(user, id, dto.version, async (em, driver) => {
   if (dto.toMonth < dto.fromMonth) throw new BadRequestException('The last month can’t be before the first.');
   if (dto.toMonth > usDay('latest').slice(0, 7)) throw new BadRequestException('The last month can’t be in the future.');
   await em.getRepository(DriverPreviousEmployer).save({ driverId: id, name: dto.name, fromMonth: dto.fromMonth, toMonth: dto.toMonth,
    requestedOn: dto.requestedOn ? this.date(dto.requestedOn) : null, createdBy: user.id });
   await driverEvent(em, user.id, id, 'EMPLOYER_RECORDED', { action: 'added', requested: !!dto.requestedOn });
   return this.bump(em, driver);
  });
 }

 async updateEmployer(user: User, id: string, employerId: string, dto: UpdateEmployerDto) {
  return this.write(user, id, dto.version, async (em, driver) => {
   const employer = await this.employer(em, id, employerId);
   // Only a date that changes is checked again, so a request from over a year ago can still get its answer.
   const entered = (value: string | null | undefined, kept: string | null) => value === undefined || value === kept ? kept : value ? this.date(value) : null;
   const requestedOn = entered(dto.requestedOn, employer.requestedOn), answeredOn = entered(dto.answeredOn, employer.answeredOn), goodFaithOn = entered(dto.goodFaithOn, employer.goodFaithOn);
   const goodFaithNote = goodFaithOn ? dto.goodFaithNote || (dto.goodFaithNote === undefined ? employer.goodFaithNote : null) : null;
   if (employer.requestedOn && !requestedOn) throw new BadRequestException('This employer was already asked, so the request is kept.');
   if ((answeredOn || goodFaithOn) && !requestedOn) throw new BadRequestException('Record when you asked the employer first.');
   if (answeredOn && requestedOn && answeredOn < requestedOn) throw new BadRequestException('The answer can’t be dated before the request.');
   if (goodFaithOn && requestedOn && goodFaithOn < requestedOn) throw new BadRequestException('The good-faith effort can’t be dated before the request.');
   if (goodFaithOn && !goodFaithNote) throw new BadRequestException('Say what you did to reach the employer.');
   if (dto.goodFaithNote && !goodFaithOn) throw new BadRequestException('Enter the date of the good-faith effort.');
   if (requestedOn === employer.requestedOn && answeredOn === employer.answeredOn && goodFaithOn === employer.goodFaithOn && goodFaithNote === employer.goodFaithNote) return { id, version: driver.version };
   await em.getRepository(DriverPreviousEmployer).update(employerId, { requestedOn, answeredOn, goodFaithOn, goodFaithNote });
   await driverEvent(em, user.id, id, 'EMPLOYER_RECORDED', { action: answeredOn && !employer.answeredOn ? 'answered' : goodFaithOn && !employer.goodFaithOn ? 'good-faith' : requestedOn && !employer.requestedOn ? 'requested' : 'updated' });
   return this.bump(em, driver);
  });
 }

 /** Only an employer Safety hasn't asked yet: once asked, the request is part of the driver's qualification file. */
 async removeEmployer(user: User, id: string, employerId: string, dto: DriverVersionDto) {
  return this.write(user, id, dto.version, async (em, driver) => {
   const employer = await this.employer(em, id, employerId);
   if (employer.requestedOn) throw new ConflictException('This employer was already asked, so the request is kept.');
   await em.getRepository(DriverPreviousEmployer).delete(employerId);
   await driverEvent(em, user.id, id, 'EMPLOYER_RECORDED', { action: 'removed' });
   return this.bump(em, driver);
  });
 }

 /** Approved → Cleared, once the driver has an active owner and every item is completed or not needed, and still current. */
 async clear(user: User, id: string, dto: DriverVersionDto) {
  return this.write(user, id, dto.version, async (em, driver) => {
   const items = await em.getRepository(DriverClearanceItem).findBy({ driverId: id });
   const missing = clearanceGaps(items, await hasActiveOwner(em, id), await em.getRepository(DriverPreviousEmployer).findBy({ driverId: id }));
   if (missing.length) throw new BadRequestException({ message: missing.includes('owner') ? 'Assign an active safety staff owner first.' : 'Finish every clearance item first.', missing });
   const now = new Date();
   await em.getRepository(Driver).update(id, { status: 'CLEARED', clearedAt: now, clearedBy: user.id, version: driver.version + 1 });
   await driverEvent(em, user.id, id, 'CLEARED', {});
   return { id, version: driver.version + 1 };
  });
 }

 /** Locks the driver, checks the version and that they are approved, then who may act (under the lock, so an owner change can't slip in). */
 private write<T>(user: User, id: string, version: number, work: (em: EntityManager, driver: Driver) => Promise<T>) {
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, version);
   if (!CLEARERS.includes(user.role) && !await ownsDriver(em, user, id)) throw new ForbiddenException('Only the driver’s Safety contact and the Safety manager can work on clearance.');
   if (driver.status === 'CLEARED') throw new ConflictException('This driver is already cleared.');
   if (driver.status !== 'APPROVED') throw new ConflictException('Clearance starts once the Safety manager approves the driver.');
   return work(em, driver);
  });
 }
 private async bump(em: EntityManager, driver: Driver) {
  await em.getRepository(Driver).update(driver.id, { version: driver.version + 1 });
  return { id: driver.id, version: driver.version + 1 };
 }
 private async employer(em: EntityManager, driverId: string, id: string) {
  const employer = await em.getRepository(DriverPreviousEmployer).findOneBy({ id, driverId });
  if (!employer) throw new NotFoundException('This employer is no longer on the list.');
  return employer;
 }
 /** A date people entered: required, not in the future, and within the last year. */
 private date(value: string | undefined) {
  if (!value) throw new BadRequestException('Enter the date.');
  if (value > usDay('latest')) throw new BadRequestException('The date can’t be in the future.');
  if (value < oldestDate()) throw new BadRequestException('The date is more than a year ago. This has to be done again.');
  return value;
 }
}
