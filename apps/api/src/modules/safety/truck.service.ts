import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { FileResult } from '../documents/documents.service';
import { inspectPdf } from '../documents/certificate';
import { decodePdf, sha256 } from '../documents/images';
import { onboardingLimit } from '../onboarding/rate-limit';
import { CURRENT_LAYOUT, ownerDocumentKey, StorageService } from '../storage/storage.service';
import { User } from '../users/user.entity';
import { Driver } from './safety.entity';
import { driverEvent, lockOpenDriver, ownsDriver, SCREENERS, writeDriver } from './driver-records';
import { ArchiveTruckDto, OwnerDocumentDto, TruckDto } from './truck.dto';
import { usDay } from './screening-rules';

const WORKING = ['APPROVED', 'CLEARED'];
const DUPLICATE_VIN = 'Another truck on the list already has this VIN.';
const KIND_WORDS: Record<string, string> = { LEASE: 'lease', INSURANCE: 'insurance', REGISTRATION: 'registration' };

/**
 * Owner-operators' trucks and their lease, insurance and registration PDFs (private storage). Safety leads, the Safety
 * manager, administrators and the driver's current owner add and change them; every Safety role reads them and opens the
 * files (each open is recorded and rate-limited). Dates are typed from the document; nothing is read from the files.
 */
@Injectable()
export class TruckService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService) {}

 private async write<T>(user: User, id: string, version: number, work: (em: Parameters<Parameters<typeof writeDriver>[1]>[0], driver: Driver) => Promise<T>) {
  return writeDriver(this.db, async em => {
   const driver = await lockOpenDriver(em, id, version);
   await this.mayChange(em, user, id);
   if (driver.driverType !== 'OWNER_OPERATOR') throw new ConflictException('Trucks are kept for owner-operators.');
   if (!WORKING.includes(driver.status)) throw new ConflictException('Trucks are added once the Safety manager approves the driver.');
   return work(em, driver);
  });
 }
 private async mayChange(em: Parameters<Parameters<typeof writeDriver>[1]>[0], user: User, id: string) {
  if (!SCREENERS.includes(user.role) && !await ownsDriver(em, user, id)) throw new ForbiddenException('Only Safety leads, the Safety manager and the driver’s Safety contact can change trucks.');
 }
 private async truck(em:Parameters<Parameters<typeof writeDriver>[1]>[0], driverId: string, truckId: string) {
  const [row] = await em.query(`SELECT id, "archivedAt" FROM driver_trucks WHERE id = $1 AND "driverId" = $2 FOR UPDATE`, [truckId, driverId]) as { id: string; archivedAt: Date | null }[];
  if (!row) throw new NotFoundException('This truck is no longer on the list.');
  return row;
 }

 async add(user: User, id: string, dto: TruckDto) {
  return this.write(user, id, dto.version, async (em, driver) => {
   if ((dto.plate ? 1 : 0) !== (dto.plateState ? 1 : 0)) throw new BadRequestException('Enter the plate and its state together.');
   await em.query(`INSERT INTO driver_trucks ("driverId", unit, vin, year, make, plate, "plateState", "createdBy") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, dto.unit, dto.vin, dto.year, dto.make, dto.plate || null, dto.plateState || null, user.id]).catch(duplicate);
   await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [id]);
   await driverEvent(em, user.id, id, 'TRUCK_SAVED', { action: 'added' });
   return { id, version: driver.version + 1 };
  });
 }

 async update(user: User, id: string, truckId: string, dto: TruckDto) {
  return this.write(user, id, dto.version, async (em, driver) => {
   if ((dto.plate ? 1 : 0) !== (dto.plateState ? 1 : 0)) throw new BadRequestException('Enter the plate and its state together.');
   const truck = await this.truck(em, id, truckId);
   if (truck.archivedAt) throw new ConflictException('This truck is archived.');
   await em.query(`UPDATE driver_trucks SET unit = $2, vin = $3, year = $4, make = $5, plate = $6, "plateState" = $7, "updatedAt" = now() WHERE id = $1`,
    [truckId, dto.unit, dto.vin, dto.year, dto.make, dto.plate || null, dto.plateState || null]).catch(duplicate);
   await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [id]);
   await driverEvent(em, user.id, id, 'TRUCK_SAVED', { action: 'updated' });
   return { id, version: driver.version + 1 };
  });
 }

 async archive(user: User, id: string, truckId: string, dto: ArchiveTruckDto) {
  return this.write(user, id, dto.version, async (em, driver) => {
   const truck = await this.truck(em, id, truckId);
   if (truck.archivedAt) throw new ConflictException('This truck is already archived.');
   await em.query(`UPDATE driver_trucks SET "archivedAt" = now(), "updatedAt" = now() WHERE id = $1`, [truckId]);
   await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [id]);
   await driverEvent(em, user.id, id, 'TRUCK_SAVED', { action: 'archived' });
   return { id, version: driver.version + 1 };
  });
 }

 /** Stores a PDF for a truck; it replaces the current one of its kind, which is kept. */
 async upload(user: User, id: string, truckId: string, dto: OwnerDocumentDto) {
  if (!this.storage.enabled) throw new ServiceUnavailableException('Uploads aren’t available right now.');
  if (dto.kind !== 'LEASE' && !dto.expiresOn) throw new BadRequestException(`Enter the expiration date shown on the ${KIND_WORDS[dto.kind]}.`);
  if (dto.expiresOn && dto.expiresOn < '2000-01-01') throw new BadRequestException('Enter the expiration date shown on the document.');
  // Checked again under the driver lock; this early check keeps someone who'd be refused from storing a file first.
  await this.mayChange(this.db.manager, user, id);
  await onboardingLimit(this.db, `driver-owner-doc:${user.id}`, 30, 3600);
  const file = decodePdf(dto.file);
  const pageCount = await inspectPdf(file).catch(() => { throw new BadRequestException('The PDF could not be read. Upload an unencrypted PDF.'); });
  const documentId = randomUUID(), stored = { id: documentId, driverId: id, kind: dto.kind };
  await this.storage.put(ownerDocumentKey(stored), file, 'application/pdf');
  try {
   return await this.write(user, id, dto.version, async (em, driver) => {
    const truck = await this.truck(em, id, truckId);
    if (truck.archivedAt) throw new ConflictException('This truck is archived.');
    await em.query(`UPDATE driver_owner_documents SET "replacedAt" = now() WHERE "truckId" = $1 AND kind = $2 AND "replacedAt" IS NULL`, [truckId, dto.kind]);
    await em.query(`INSERT INTO driver_owner_documents (id, "driverId", "truckId", kind, "expiresOn", "pageCount", sha256, "byteSize", "storageLayout", "uploadedBy") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
     [documentId, id, truckId, dto.kind, dto.expiresOn || null, pageCount, sha256(file), file.length, CURRENT_LAYOUT, user.id]);
    await em.query(`UPDATE drivers SET version = version + 1 WHERE id = $1`, [id]);
    await driverEvent(em, user.id, id, 'OWNER_DOCUMENT_UPLOADED', { kind: dto.kind });
    return { id, version: driver.version + 1 };
   });
  } catch (error) { await this.storage.remove(ownerDocumentKey(stored)); throw error; }
 }

 /** A document file for any Safety role (checked by the controller's roles); every open is recorded. */
 async file(user: User, id: string, truckId: string, documentId: string): Promise<FileResult> {
  await onboardingLimit(this.db, `driver-owner-doc-view:${user.id}`, 60, 900);
  const [row] = await this.db.query(`SELECT id, kind, "driverId" FROM driver_owner_documents WHERE id = $1 AND "driverId" = $2 AND "truckId" = $3`, [documentId, id, truckId]) as { id: string; kind: string; driverId: string }[];
  if (!row) throw new NotFoundException('This document no longer exists.');
  const body = await this.storage.get(ownerDocumentKey(row));
  await driverEvent(this.db.manager, user.id, id, 'OWNER_DOCUMENT_VIEWED', { kind: row.kind });
  return { body, type: 'application/pdf', filename: `${KIND_WORDS[row.kind]}.pdf` };
 }

 /** A driver's trucks (archived last) with their current documents. */
 async forDriver(id: string) {
  const trucks = await this.db.query(`SELECT t.id, t.unit, t.vin, t.year, t.make, t.plate, t."plateState", t."archivedAt" FROM driver_trucks t WHERE t."driverId" = $1 ORDER BY (t."archivedAt" IS NOT NULL), t."createdAt"`, [id]) as { id: string }[];
  const documents = await this.db.query(`SELECT d.id, d."truckId", d.kind, to_char(d."expiresOn", 'YYYY-MM-DD') AS "expiresOn", d."pageCount", d."createdAt" FROM driver_owner_documents d WHERE d."driverId" = $1 AND d."replacedAt" IS NULL`, [id]) as { truckId: string }[];
  return { items: trucks.map(truck => ({ ...truck, documents: documents.filter(doc => doc.truckId === truck.id) })) };
 }

 /** Every owner-operator truck on the list, for Safety › Trucks. */
 async list() {
  const items = await this.db.query(`SELECT t.id, t."driverId", d."firstName", d."lastName", t.unit, t.vin, t.year, t.make, t.plate, t."plateState", t."archivedAt",
    (SELECT to_char(x."expiresOn", 'YYYY-MM-DD') FROM driver_owner_documents x WHERE x."truckId" = t.id AND x.kind = 'INSURANCE' AND x."replacedAt" IS NULL) AS "insuranceExpiresOn",
    (SELECT to_char(x."expiresOn", 'YYYY-MM-DD') FROM driver_owner_documents x WHERE x."truckId" = t.id AND x.kind = 'REGISTRATION' AND x."replacedAt" IS NULL) AS "registrationExpiresOn",
    EXISTS(SELECT 1 FROM driver_owner_documents x WHERE x."truckId" = t.id AND x.kind = 'LEASE' AND x."replacedAt" IS NULL) AS "hasLease"
   FROM driver_trucks t JOIN drivers d ON d.id = t."driverId" ORDER BY (t."archivedAt" IS NOT NULL), d."lastName", d."firstName", t.unit LIMIT 1000`);
  return { today: usDay('latest'), items };
 }
}
function duplicate(error: unknown): never {
 const driver = (error as { driverError?: { code?: string; constraint?: string } }).driverError;
 if (driver?.code === '23505' && driver.constraint === 'UQ_driver_trucks_vin') throw new ConflictException(DUPLICATE_VIN);
 throw error;
}
