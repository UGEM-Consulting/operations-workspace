import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type {} from '../auth/session';
import { DataSource, EntityManager, IsNull, Not, QueryFailedError } from 'typeorm';
import { Role, User } from '../users/user.entity';
import { CLOSED_STATUSES, Driver, DriverEvent, DriverEventType, DriverLink, DriverOwner, type RenewalKind } from './safety.entity';

export const SAFETY_ROLES = [Role.SYSTEM_ADMIN, Role.SAFETY_MANAGER, Role.SAFETY_LEAD, Role.SAFETY_STAFF];
/** Who may add leads, change any driver, screen, withdraw and assign owners. Safety staff change only drivers they own. */
export const SCREENERS = [Role.SYSTEM_ADMIN, Role.SAFETY_MANAGER, Role.SAFETY_LEAD];
/** Who decides on a screened driver: the Safety manager (and administrators). */
export const DECIDERS = [Role.SYSTEM_ADMIN, Role.SAFETY_MANAGER];
export const STALE = 'Someone else changed this driver. Reload and try again.';
// Unique indexes, turned into messages a person can act on.
const DUPLICATES: Record<string, string> = {
 UQ_drivers_open_phone: 'Another open driver record already has this phone number.',
 UQ_drivers_open_email: 'Another open driver record already has this email.',
 UQ_driver_owners_open: 'This driver’s Safety Manager changed at the same time. Reload and try again.',
 UQ_driver_reports_current: 'Someone else uploaded a report at the same time. Reload and try again.',
};

export function requireScreener(user: User) {
 if (!SCREENERS.includes(user.role)) throw new ForbiddenException('Only Safety leads and managers can do this.');
}
export async function ownsDriver(em: EntityManager, user: User, driverId: string) {
 return em.getRepository(DriverOwner).existsBy({ driverId, ownerId: user.id, endedAt: IsNull() });
}
/** Locks the driver row (every driver write takes it first), checks the version the person saw and that it is open. */
export async function lockOpenDriver(em: EntityManager, id: string, version: number) {
 const driver = await em.getRepository(Driver).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
 if (!driver) throw new NotFoundException('This driver record no longer exists.');
 if (driver.version !== version) throw new ConflictException(STALE);
 if (CLOSED_STATUSES.includes(driver.status)) throw new ConflictException('This driver record is closed and can’t be changed.');
 return driver;
}
/** Runs a driver write in one transaction, turning unique-index races into a 409 a person can act on. */
export async function writeDriver<T>(db: DataSource, work: (em: EntityManager) => Promise<T>): Promise<T> {
 try { return await db.transaction(work); }
 catch (error) {
  const driver = error instanceof QueryFailedError ? error.driverError as { code?: string; constraint?: string } : null;
  if (driver?.code === '23505') throw new ConflictException(DUPLICATES[driver.constraint ?? ''] ?? 'This record changed at the same time. Reload and try again.');
  throw error;
 }
}
/** Production (and its own deployment purpose) sends links and codes to real addresses; elsewhere only example.test. */
export const isProduction = (config: ConfigService) => config.get('NODE_ENV') === 'production' || config.get('DEPLOYMENT_PURPOSE') === 'production';
/** Whether an address may get Safety's links, codes and reminders here: any in production, else example.test only (any case). */
export const mayEmail = (config: ConfigService, email: string) => isProduction(config) || email.trim().toLowerCase().endsWith('@example.test');
/** Refuses an address mayEmail doesn't allow, before a link is made for it. */
export function requireMayEmail(config: ConfigService, email: string, message = 'Outside production, links go only to fictional example.test addresses.') {
 if (!mayEmail(config, email)) throw new BadRequestException(message);
}
/**
 * Stops a driver's open links: every one, or only those of one purpose (and document). True when one was open. The
 * application link and renewal links are bound to the same email, so an email change stops them all.
 */
export async function revokeOpenLinks(em: EntityManager, driverId: string, only: { purpose?: DriverLink['purpose']; documentKind?: RenewalKind } = {}, driversOwn = false) {
 // driversOwn: only links bound to the driver's email, leaving a truck owner's contract link, which is bound to theirs.
 return !!(await em.getRepository(DriverLink).update({ driverId, revokedAt: IsNull(), completedAt: IsNull(), ...(driversOwn ? { purpose: Not('CONTRACT_OWNER') } : {}), ...only }, { revokedAt: new Date() })).affected;
}
/**
 * The link this driver session verified (an hour, then a fresh code). Each caller then applies its own rules: the
 * application routes need an application link, the renewal routes a renewal link.
 */
export async function sessionLink(em: EntityManager, req: Request) {
 const linkId = req.session?.driverLinkId;
 if (!linkId || !req.session.expiresAt || req.session.expiresAt <= Date.now()) throw new UnauthorizedException('Please verify your email again.');
 const link = await em.getRepository(DriverLink).findOneBy({ id: linkId });
 if (!link) throw new UnauthorizedException('Please verify your email again.');
 return link;
}
/**
 * Whether an unchecked scan was part of the application the driver sent: the current scan when they submitted. It is kept
 * when something replaces it (deleting kept scans belongs to the retention job, which isn't authorized), and it is never
 * a renewal scan waiting for its check.
 */
export const sentWithApplication = (document: { createdAt: Date }, submittedAt: Date | null) => !!submittedAt && document.createdAt.getTime() <= submittedAt.getTime();

/** Metadata only: field names, kinds and flags, never values, reasons or notes. */
export function driverEvent(em: EntityManager, actorId: string | null, driverId: string, event: DriverEventType, metadata: Record<string, unknown>) {
 return em.getRepository(DriverEvent).save({ driverId, actorId, event, metadata });
}
