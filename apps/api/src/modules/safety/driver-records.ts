import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, QueryFailedError } from 'typeorm';
import { Role, User } from '../users/user.entity';
import { CLOSED_STATUSES, Driver, DriverEvent, DriverEventType, DriverOwner } from './safety.entity';

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
 UQ_driver_owners_open: 'This driver’s owner changed at the same time. Reload and try again.',
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
/** Metadata only: field names, kinds and flags, never values, reasons or notes. */
export function driverEvent(em: EntityManager, actorId: string | null, driverId: string, event: DriverEventType, metadata: Record<string, unknown>) {
 return em.getRepository(DriverEvent).save({ driverId, actorId, event, metadata });
}
