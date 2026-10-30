import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, In, IsNull, QueryFailedError } from 'typeorm';
import { webOrigins } from '../../config/environment';
import { onboardingLimit } from '../onboarding/rate-limit';
import { digest } from '../onboarding/verification-code';
import { DriverVersionDto } from './driver-application.dto';
import { PiiService } from './pii';
import { Role, User, UserStatus } from '../users/user.entity';
import { AssignOwnerDto, CreateDriverDto, ReopenDriverDto, UpdateDriverDto, WithdrawDriverDto } from './safety.dto';
import { CLOSED_STATUSES, Driver, DriverApplication, DriverEvent, DriverEventType, DriverLink, DriverOwner, OWNABLE, phoneKey, WITHDRAWABLE } from './safety.entity';
/** How long an application link works: until the driver submits, Safety cancels it, or this many days pass. */
export const DRIVER_LINK_DAYS = 14;

export const SAFETY_ROLES = [Role.SYSTEM_ADMIN, Role.SAFETY_MANAGER, Role.SAFETY_LEAD, Role.SAFETY_STAFF];
/** Who may add leads, change any driver, withdraw and assign owners. Safety staff change only drivers they own. */
const SCREENERS = [Role.SYSTEM_ADMIN, Role.SAFETY_MANAGER, Role.SAFETY_LEAD];
const STALE = 'Someone else changed this driver. Reload and try again.';
// Unique indexes from SafetyDrivers1792860000000, turned into messages a person can act on.
const DUPLICATES: Record<string, string> = {
 UQ_drivers_open_phone: 'Another open driver record already has this phone number.',
 UQ_drivers_open_email: 'Another open driver record already has this email.',
 UQ_driver_owners_open: 'This driver’s owner changed at the same time. Reload and try again.',
};
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
 constructor(private readonly db: DataSource, private readonly config: ConfigService, private readonly pii: PiiService) {}

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
  const [owners, activity, [link], [application]] = await Promise.all([
   this.db.query(`SELECT x.id, x."startedAt", x."endedAt", x.reason, ${person('o')} AS owner, CASE WHEN a.id IS NULL THEN NULL ELSE a."firstName" || ' ' || a."lastName" END AS "assignedBy"
    FROM driver_owners x LEFT JOIN users o ON o.id = x."ownerId" LEFT JOIN users a ON a.id = x."actorId" WHERE x."driverId" = $1 ORDER BY x."startedAt" DESC, x."createdAt" DESC`, [id]),
   this.db.query(`SELECT e.id, e.event, e.metadata, e."createdAt", CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS actor
    FROM driver_events e LEFT JOIN users u ON u.id = e."actorId" WHERE e."driverId" = $1 ORDER BY e."createdAt" DESC LIMIT 200`, [id]),
   // The open link (never its token) and the driver's answers; the SSN only as its last four digits.
   this.db.query(`SELECT email, "createdAt", "expiresAt", "openedAt", "expiresAt" <= now() AS expired FROM driver_links WHERE "driverId" = $1 AND "revokedAt" IS NULL AND "completedAt" IS NULL`, [id]),
   this.db.query(`SELECT status, fields, "ssnLast4", version, "submittedAt", "updatedAt" FROM driver_applications WHERE "driverId" = $1`, [id]),
  ]);
  return { ...driver, owner: owners.find((row: { endedAt: Date | null }) => row.endedAt === null)?.owner ?? null, owners, activity, link: link ?? null, application: application ?? null };
 }

 /** Active people to pick: Safety leads (and managers, who can act as one) and safety staff owners. */
 async people() {
  const rows: { id: string; name: string; role: Role }[] = await this.db.query(`SELECT id, "firstName" || ' ' || "lastName" AS name, role FROM users
   WHERE status = 'ACTIVE' AND role::text IN ('SAFETY_MANAGER','SAFETY_LEAD','SAFETY_STAFF') ORDER BY lower("firstName"), lower("lastName")`);
  return { leads: rows.filter(row => row.role !== Role.SAFETY_STAFF), staff: rows.filter(row => row.role === Role.SAFETY_STAFF) };
 }

 async create(user: User, dto: CreateDriverDto) {
  this.requireScreener(user);
  return this.write(async em => {
   const safetyLeadId = dto.safetyLeadId === undefined || dto.safetyLeadId === null
    ? ([Role.SAFETY_LEAD, Role.SAFETY_MANAGER].includes(user.role) ? user.id : null) : await this.safetyLead(em, dto.safetyLeadId);
   const driver = await em.getRepository(Driver).save({ firstName: dto.firstName, lastName: dto.lastName, phone: dto.phone, phoneKey: phoneKey(dto.phone),
    email: dto.email ?? null, driverType: dto.driverType, licenseType: dto.licenseType ?? null, licenseState: dto.licenseState ?? null,
    experienceYears: dto.experienceYears ?? null, source: blank(dto.source) ?? null, notes: blank(dto.notes) ?? null, safetyLeadId, createdBy: user.id });
   await this.event(em, user, driver.id, 'CREATED', { fields: EDITABLE.filter(field => driver[field] !== null) });
   return { id: driver.id, version: driver.version };
  });
 }

 async update(user: User, id: string, dto: UpdateDriverDto) {
  return this.write(async em => {
   const driver = await this.lockOpen(em, id, dto.version);
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
   let leadChanged = false;
   if (dto.safetyLeadId !== undefined && dto.safetyLeadId !== driver.safetyLeadId) {
    this.requireScreener(user);
    driver.safetyLeadId = dto.safetyLeadId === null ? null : await this.safetyLead(em, dto.safetyLeadId);
    leadChanged = true;
   }
   if (!fields.length && !leadChanged) return { id, version: driver.version };
   driver.version += 1;
   await em.getRepository(Driver).save(driver);
   if (fields.length) await this.event(em, user, id, 'UPDATED', { fields });
   if (leadChanged) await this.event(em, user, id, 'SAFETY_LEAD_CHANGED', {});
   if (linkCancelled) await this.event(em, user, id, 'LINK_CANCELLED', { emailChanged: true });
   return { id, version: driver.version };
  });
 }

 async withdraw(user: User, id: string, dto: WithdrawDriverDto) {
  this.requireScreener(user);
  return this.write(async em => {
   const driver = await this.lockOpen(em, id, dto.version);
   if (!WITHDRAWABLE.includes(driver.status)) throw new ConflictException('Only a driver who isn’t approved yet can be withdrawn.');
   await em.getRepository(DriverLink).update({ driverId: id, revokedAt: IsNull(), completedAt: IsNull() }, { revokedAt: new Date() });
   await em.getRepository(Driver).update(id, { status: 'WITHDRAWN', statusReason: dto.reason, closedAt: new Date(), version: driver.version + 1 });
   await this.event(em, user, id, 'WITHDRAWN', { from: driver.status });
   return { id, version: driver.version + 1 };
  });
 }

 /** A withdrawn driver comes back as a lead (their earlier steps are started again). */
 async reopen(user: User, id: string, dto: ReopenDriverDto) {
  this.requireScreener(user);
  return this.write(async em => {
   const driver = await em.getRepository(Driver).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!driver) throw new NotFoundException('This driver record no longer exists.');
   if (driver.version !== dto.version) throw new ConflictException(STALE);
   if (driver.status !== 'WITHDRAWN') throw new ConflictException('Only a withdrawn driver can be reopened.');
   await em.getRepository(Driver).update(id, { status: 'LEAD', statusReason: null, closedAt: null, version: driver.version + 1 });
   await this.event(em, user, id, 'REOPENED', {});
   return { id, version: driver.version + 1 };
  });
 }

 async assignOwner(user: User, id: string, dto: AssignOwnerDto) {
  this.requireScreener(user);
  return this.write(async em => {
   const driver = await this.lockOpen(em, id, dto.version);
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
   await this.event(em, user, id, 'OWNER_ASSIGNED', { first: !current });
   return { id, version: driver.version + 1 };
  });
 }

 /**
  * Sends (or resends) the driver's application link, bound to the email on their record; any earlier open link stops
  * working. The token is returned once and travels in the URL fragment, so it never reaches server logs.
  */
 async sendLink(user: User, id: string, dto: DriverVersionDto) {
  this.requireScreener(user);
  return this.write(async em => {
   const driver = await this.lockOpen(em, id, dto.version);
   if (!['LEAD', 'APPLYING'].includes(driver.status)) throw new ConflictException('This driver has already sent their application.');
   if (!driver.email) throw new BadRequestException('Add the driver’s email first. The link works only with that address.');
   const production = this.config.get('NODE_ENV') === 'production' || this.config.get('DEPLOYMENT_PURPOSE') === 'production';
   if (!production && !driver.email.endsWith('@example.test')) throw new BadRequestException('Outside production, links go only to fictional example.test addresses.');
   const resent = await this.cancelOpenLink(em, driver);
   const token = randomBytes(32).toString('hex');
   const link = await em.getRepository(DriverLink).save({ driverId: id, tokenHash: digest(token), email: driver.email, createdBy: user.id, expiresAt: new Date(Date.now() + DRIVER_LINK_DAYS * 86400_000) });
   await em.getRepository(Driver).update(id, { status: 'APPLYING', version: driver.version + 1 });
   await this.event(em, user, id, 'LINK_SENT', { resent });
   return { id, version: driver.version + 1, expiresAt: link.expiresAt, url: `${webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0]}/driver#${token}` };
  });
 }

 /** Stops the open link; a driver who hasn't submitted goes back to being a lead. Their saved answers are kept. */
 async cancelLink(user: User, id: string, dto: DriverVersionDto) {
  this.requireScreener(user);
  return this.write(async em => {
   const driver = await this.lockOpen(em, id, dto.version);
   if (!await this.cancelOpenLink(em, driver)) throw new ConflictException('This driver has no open application link.');
   await em.getRepository(Driver).update(id, { status: driver.status, version: driver.version + 1 });
   await this.event(em, user, id, 'LINK_CANCELLED', {});
   return { id, version: driver.version + 1 };
  });
 }

 /** The full SSN, for Safety leads, managers, administrators and the driver's owner. Every view is recorded. */
 async revealSsn(user: User, id: string) {
  if (!SCREENERS.includes(user.role) && !await this.db.getRepository(DriverOwner).existsBy({ driverId: id, ownerId: user.id, endedAt: IsNull() }))
   throw new ForbiddenException('Only Safety leads, managers and the driver’s owner can view the full number.');
  await onboardingLimit(this.db, `ssn-reveal:${user.id}`, 30, 3600);
  const application = await this.db.getRepository(DriverApplication).createQueryBuilder('a').addSelect('a.ssnCiphertext').where('a."driverId" = :id', { id }).getOne();
  if (!application?.ssnCiphertext) throw new NotFoundException('No Social Security number on file.');
  const ssn = this.pii.openSsn(application.ssnCiphertext, id);
  await this.event(this.db.manager, user, id, 'SSN_REVEALED', {});
  return { ssn };
 }

 /** Revokes the open link, if any; an applying driver goes back to LEAD on the entity passed in (the caller saves it). */
 private async cancelOpenLink(em: EntityManager, driver: Driver) {
  const result = await em.getRepository(DriverLink).update({ driverId: driver.id, revokedAt: IsNull(), completedAt: IsNull() }, { revokedAt: new Date() });
  if (!result.affected) return false;
  if (driver.status === 'APPLYING') driver.status = 'LEAD';
  return true;
 }
 private requireScreener(user: User) {
  if (!SCREENERS.includes(user.role)) throw new ForbiddenException('Only Safety leads and managers can do this.');
 }
 private async requireEditor(em: EntityManager, user: User, driver: Driver) {
  if (SCREENERS.includes(user.role)) return;
  const owns = await em.getRepository(DriverOwner).existsBy({ driverId: driver.id, ownerId: user.id, endedAt: IsNull() });
  if (!owns) throw new ForbiddenException('Safety staff can change only the drivers they own.');
 }
 private async lockOpen(em: EntityManager, id: string, version: number) {
  const driver = await em.getRepository(Driver).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  if (!driver) throw new NotFoundException('This driver record no longer exists.');
  if (driver.version !== version) throw new ConflictException(STALE);
  if (CLOSED_STATUSES.includes(driver.status)) throw new ConflictException('This driver record is closed and can’t be changed.');
  return driver;
 }
 private async safetyLead(em: EntityManager, id: string) {
  const lead = await em.getRepository(User).findOneBy({ id, role: In([Role.SAFETY_LEAD, Role.SAFETY_MANAGER]), status: UserStatus.ACTIVE });
  if (!lead) throw new BadRequestException('Choose an active Safety lead or manager.');
  return lead.id;
 }
 private async write<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
  try { return await this.db.transaction(work); }
  catch (error) {
   const driver = error instanceof QueryFailedError ? error.driverError as { code?: string; constraint?: string } : null;
   if (driver?.code === '23505') throw new ConflictException(DUPLICATES[driver.constraint ?? ''] ?? 'This record changed at the same time. Reload and try again.');
   throw error;
  }
 }
 private event(em: EntityManager, user: User, driverId: string, event: DriverEventType, metadata: Record<string, unknown>) {
  return em.getRepository(DriverEvent).save({ driverId, actorId: user.id, event, metadata });
 }
}
