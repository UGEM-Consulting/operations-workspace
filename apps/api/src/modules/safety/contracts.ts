import { randomBytes } from 'node:crypto';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { webOrigins } from '../../config/environment';
import { executedDocument, type CertificateSignature } from '../documents/certificate';
import type { ClientContext } from '../documents/client-context';
import { ApplicantSignatureDto } from '../documents/documents.dto';
import type { FileResult } from '../documents/documents.service';
import { assertSignatureEmbeds, decodeSignature } from '../documents/images';
import { digest } from '../onboarding/verification-code';
import { onboardingLimit } from '../onboarding/rate-limit';
import { driverConsentKey, StorageService } from '../storage/storage.service';
import type { User } from '../users/user.entity';
import { DRIVER_ESIGN_CONSENT, DriverConsentDocument } from './consent.entity';
import { driverEvent, lockOpenDriver, ownsDriver, requireMayEmail, SCREENERS, sessionLink, writeDriver } from './driver-records';
import { Driver, DriverLink, LEAVABLE } from './safety.entity';

/** How long a contract link works, for the driver and for the truck owner's signer. */
export const CONTRACT_LINK_DAYS = 7;
const CLOSED_LINK = 'This link is no longer available. Please contact Safety.';
export class ContractVersionDto { @IsInt() @Min(1) version!: number; }
/** The driver adds their home address when their application didn't give one; the owner's signer gives their title. */
export class ContractSignatureDto extends ApplicantSignatureDto {
 @IsOptional() @IsString() @MinLength(5) @MaxLength(300) @Matches(/^[\x20-\x7E]+$/, { message: 'Type the address in Latin letters.' }) address?: string;
 @IsOptional() @IsString() @MinLength(2) @MaxLength(100) @Matches(/^[A-Za-z][A-Za-z .,'&-]*$/, { message: 'Type your title in Latin letters.' }) title?: string;
}
type ContractRow = { id: string; driverId: string; unitId: string; ownerId: string; documentId: string; createdAt: Date; cancelledAt: Date | null; driverSignedAt: Date | null; ownerSignedAt: Date | null;
 driverName: string | null; driverAddress: string | null; ownerName: string | null; ownerTitle: string | null; ownerCompany: string | null; documentSha256: string; driverViewedAt: Date | null; ownerViewedAt: Date | null };

/**
 * The unit a driver will drive: the one Dispatch assigned them, else the one Safety picked in Ready for the road. Also
 * whose it is: a truck owner's (the acknowledgement applies) or an owner-operator's own.
 */
export async function roadUnit(em: EntityManager, driverId: string) {
 const [row] = await em.query(`SELECT t.id, t.unit AS number, t.kind, t."ownerId", t."driverId" AS "operatorId", o.name AS owner, o.email AS "ownerEmail", o."signerName", o."signerTitle", t."archivedAt"
  FROM drivers d LEFT JOIN driver_assignments a ON a."driverId" = d.id AND a."endedAt" IS NULL LEFT JOIN driver_road_ready r ON r."driverId" = d.id
  JOIN driver_trucks t ON t.id = coalesce(a."unitId", r."unitId") LEFT JOIN truck_owners o ON o.id = t."ownerId" WHERE d.id = $1`, [driverId]) as {
   id: string; number: string; kind: string; ownerId: string | null; operatorId: string | null; owner: string | null; ownerEmail: string | null; signerName: string | null; signerTitle: string | null; archivedAt: Date | null }[];
 return row ?? null;
}

/**
 * The Driver and Contractor Acknowledgement (section 39, AckSignPhoneScreen, OwnerSignLinkScreen, OwnerSignPhoneScreen): for
 * a driver on a truck owner's truck. Safety (leads, the Safety Director, administrators and the driver's Safety Manager)
 * sends the driver a link; once the driver signed, a link for the owner's signer, bound to the owner's email. Both links are
 * driver links with the emailed code (DriverAccessService.begin/verify) and open only this document. The current published
 * version is fixed when the first link is made; the workspace fills in the names, the driver's address and the dates.
 * Signatures are append-only (a trigger); cancelling works until the owner signs. Events hold flags, never names.
 */
@Injectable()
export class ContractsService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService, private readonly storage: StorageService) {}

 /** The acknowledgements of a driver, newest first, for their page (never a token or a signature image). */
 async forDriver(driverId: string) {
  return this.db.query(`SELECT c.id, c."unitId", t.unit AS unit, o.name AS owner, c."createdAt", c."cancelledAt", c."driverSignedAt", c."ownerSignedAt", c."ownerName", c."ownerTitle",
    (SELECT json_build_object('purpose', l.purpose, 'email', l.email, 'createdAt', l."createdAt", 'expiresAt', l."expiresAt", 'openedAt', l."openedAt", 'expired', l."expiresAt" <= now()) FROM driver_links l
     WHERE l."contractId" = c.id AND l."revokedAt" IS NULL AND l."completedAt" IS NULL ORDER BY l."createdAt" DESC LIMIT 1) AS link
   FROM driver_contracts c JOIN driver_trucks t ON t.id = c."unitId" JOIN truck_owners o ON o.id = c."ownerId" WHERE c."driverId" = $1 ORDER BY c."createdAt" DESC`, [driverId]);
 }

 /** The driver's link: the acknowledgement for the unit they will drive, made the first time with the current version. */
 async sendDriverLink(user: User, driverId: string, dto: ContractVersionDto) {
  this.requireStorage();
  return writeDriver(this.db, async em => {
   const driver = await this.lockSender(em, user, driverId, dto.version);
   if (!driver.email) throw new BadRequestException('Add the driver’s email first. The link works only with that address.');
   requireMayEmail(this.config, driver.email);
   const unit = await roadUnit(em, driverId);
   if (!unit || !unit.ownerId) throw new ConflictException('The acknowledgement is for a driver on a truck owner’s truck. Choose their unit first.');
   if (unit.archivedAt) throw new ConflictException(`Unit ${unit.number} is archived. Choose the truck they drive now first.`);
   const [document] = await em.query(`SELECT id, sha256 FROM driver_consent_documents WHERE kind = 'CONTRACTOR_ACKNOWLEDGEMENT' ORDER BY version DESC LIMIT 1`) as { id: string; sha256: string }[];
   if (!document) throw new ConflictException('The Safety Director hasn’t published the Driver and Contractor Acknowledgement yet (Forms and letters).');
   let [contract] = await em.query(`SELECT id, "driverSignedAt" FROM driver_contracts WHERE "driverId" = $1 AND "unitId" = $2 AND "cancelledAt" IS NULL AND "ownerSignedAt" IS NULL`, [driverId, unit.id]) as { id: string; driverSignedAt: Date | null }[];
   if (contract?.driverSignedAt) throw new ConflictException('The driver already signed. Send the truck owner’s link next.');
   if (!contract) [contract] = await em.query(`INSERT INTO driver_contracts ("driverId", "unitId", "ownerId", "documentId", "documentSha256", "createdBy") VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, "driverSignedAt"`,
    [driverId, unit.id, unit.ownerId, document.id, document.sha256, user.id]);
   const link = await this.link(em, driver, contract.id, 'CONTRACT', driver.email, user.id);
   await em.getRepository(Driver).update(driverId, { version: driver.version + 1 });
   await driverEvent(em, user.id, driverId, 'CONTRACT_LINK_SENT', { resent: link.resent });
   return { id: driverId, version: driver.version + 1, contractId: contract.id, expiresAt: link.expiresAt, url: link.url };
  });
 }

 /** The truck owner's link, once the driver signed: bound to the owner's email, signed by the person on the owner's page. */
 async sendOwnerLink(user: User, driverId: string, contractId: string, dto: ContractVersionDto) {
  // Signing stores the owner's signature with the form, so a link that could never be signed isn't sent.
  this.requireStorage();
  return writeDriver(this.db, async em => {
   const driver = await this.lockSender(em, user, driverId, dto.version);
   const contract = await this.contract(em, contractId, driverId, true);
   if (contract.cancelledAt) throw new ConflictException('This acknowledgement was cancelled.');
   if (!contract.driverSignedAt) throw new ConflictException('The driver signs first.');
   if (contract.ownerSignedAt) throw new ConflictException('The truck owner already signed.');
   if ((await roadUnit(em, driverId))?.id !== contract.unitId) throw new ConflictException('The driver no longer drives this truck. Cancel this acknowledgement and send one for their truck now.');
   const [owner] = await em.query(`SELECT email, "signerName" FROM truck_owners WHERE id = $1`, [contract.ownerId]) as { email: string | null; signerName: string | null }[];
   if (!owner?.email) throw new BadRequestException('Add the truck owner’s email on their page first. The link works only with that address.');
   requireMayEmail(this.config, owner.email);
   const link = await this.link(em, driver, contract.id, 'CONTRACT_OWNER', owner.email.toLowerCase(), user.id);
   await em.getRepository(Driver).update(driverId, { version: driver.version + 1 });
   await driverEvent(em, user.id, driverId, 'OWNER_LINK_SENT', { resent: link.resent });
   return { id: driverId, version: driver.version + 1, expiresAt: link.expiresAt, url: link.url, email: owner.email.toLowerCase(), signerName: owner.signerName };
  });
 }

 /** Stops an acknowledgement nobody finished (a different truck, a mistake); a signed one stays as evidence. */
 async cancel(user: User, driverId: string, contractId: string, dto: ContractVersionDto) {
  return writeDriver(this.db, async em => {
   const driver = await this.lockSender(em, user, driverId, dto.version);
   const contract = await this.contract(em, contractId, driverId, true);
   if (contract.cancelledAt || contract.ownerSignedAt) throw new ConflictException('Only an acknowledgement still waiting for a signature can be cancelled.');
   await em.query(`UPDATE driver_contracts SET "cancelledAt" = now() WHERE id = $1`, [contractId]);
   await em.query(`UPDATE driver_links SET "revokedAt" = now() WHERE "contractId" = $1 AND "revokedAt" IS NULL AND "completedAt" IS NULL`, [contractId]);
   await em.getRepository(Driver).update(driverId, { version: driver.version + 1 });
   await driverEvent(em, user.id, driverId, 'CONTRACT_CANCELLED', { driverSigned: !!contract.driverSignedAt });
   return { id: driverId, version: driver.version + 1 };
  });
 }

 async staffSignedCopy(user: User, driverId: string, contractId: string) {
  await onboardingLimit(this.db, `contract-copy:${user.id}`, 60, 900);
  return this.signedCopy(await this.contract(this.db.manager, contractId, driverId, false), 'staff');
 }

 // The driver's and the owner's side, through their verified link session.

 /** What the signing page shows: the document, who signs now, and what the workspace fills in. */
 async view(req: Request) {
  const { link, contract } = await this.session(this.db.manager, req, false);
  return this.describe(this.db.manager, link, contract);
 }
 async file(req: Request): Promise<FileResult> {
  const { contract } = await this.session(this.db.manager, req, false);
  const document = await this.db.getRepository(DriverConsentDocument).findOneByOrFail({ id: contract.documentId });
  return { body: await this.storage.get(driverConsentKey(document)), type: 'application/pdf', filename: 'driver-and-contractor-acknowledgement.pdf' };
 }
 /** Signing evidence: the first time the signer opened the full document from this page. */
 async recordView(req: Request) {
  const { link, contract } = await this.session(this.db.manager, req, false);
  await onboardingLimit(this.db, `contract-view:${link.id}`, 60, 900);
  if (link.completedAt) throw new ConflictException('You already signed.');
  const column = link.purpose === 'CONTRACT' ? 'driverViewedAt' : 'ownerViewedAt';
  await this.db.query(`UPDATE driver_contracts SET "${column}" = coalesce("${column}", now()) WHERE id = $1`, [contract.id]);
  return { viewed: true };
 }
 async sign(req: Request, dto: ContractSignatureDto, client: ClientContext) {
  this.requireStorage();
  const first = await this.session(this.db.manager, req, false);
  await onboardingLimit(this.db, `contract-sign:${first.link.id}`, 20, 900);
  if (!dto.signature) throw new BadRequestException('Draw your signature.');
  const image = decodeSignature(dto.signature);
  await assertSignatureEmbeds(image);
  return this.db.transaction(async em => {
   const { link, contract, driver } = await this.session(em, req, true);
   if (link.completedAt) throw new ConflictException('You already signed.');
   const document = await em.getRepository(DriverConsentDocument).findOneByOrFail({ id: contract.documentId });
   const owner = link.purpose === 'CONTRACT_OWNER', viewed = owner ? contract.ownerViewedAt : contract.driverViewedAt;
   if (!viewed) throw new BadRequestException('Open and read the whole document before signing. If you already opened it, reload this page and open it again.');
   const statement = `I have read the entire ${document.title} (version ${document.version}) and I agree to it${owner ? ' on behalf of the company' : ''}. I intend my typed name and my signature (drawn, or adopted from my typed name) to be my legally binding electronic signature.`;
   if (owner) {
    if (!dto.title) throw new BadRequestException('Type your title, for example Owner.');
    const [company] = await em.query(`SELECT name FROM truck_owners WHERE id = $1`, [contract.ownerId]) as { name: string }[];
    await em.query(`UPDATE driver_contracts SET "ownerName" = $2, "ownerTitle" = $3, "ownerCompany" = $4, "ownerImage" = $5, "ownerMethod" = $6, "ownerConsent" = $7, "ownerStatement" = $8, "ownerIp" = $9, "ownerAgent" = $10, "ownerSignedAt" = now()
     WHERE id = $1`, [contract.id, dto.typedName, dto.title, company.name, image, dto.signatureMethod ?? 'DRAWN', DRIVER_ESIGN_CONSENT, statement, client.ipAddress, client.userAgent]);
   } else {
    const address = dto.address?.trim() || await applicationAddress(em, driver.id);
    if (!address) throw new BadRequestException('Type your home address. It goes on the document.');
    await em.query(`UPDATE driver_contracts SET "driverName" = $2, "driverAddress" = $3, "driverImage" = $4, "driverMethod" = $5, "driverConsent" = $6, "driverStatement" = $7, "driverIp" = $8, "driverAgent" = $9, "driverSignedAt" = now()
     WHERE id = $1`, [contract.id, dto.typedName, address, image, dto.signatureMethod ?? 'DRAWN', DRIVER_ESIGN_CONSENT, statement, client.ipAddress, client.userAgent]);
   }
   await em.getRepository(DriverLink).update(link.id, { completedAt: new Date() });
   await em.getRepository(Driver).update(driver.id, { version: driver.version + 1 });
   await driverEvent(em, null, driver.id, owner ? 'OWNER_SIGNED' : 'CONTRACT_SIGNED', {});
   return this.describe(em, { ...link, completedAt: new Date() }, await this.contract(em, contract.id, driver.id, false));
  });
 }
 /** The signed copy, for whoever signed through this link: once both have signed. */
 async signedCopyFor(req: Request) {
  const { link, contract } = await this.session(this.db.manager, req, false);
  await onboardingLimit(this.db, `contract-copy:${link.id}`, 30, 900);
  if (!contract.ownerSignedAt) throw new ConflictException('The signed copy is ready once both have signed.');
  // Each side's copy leaves out the other side's IP address and browser.
  return this.signedCopy(contract, link.purpose === 'CONTRACT_OWNER' ? 'countersigner' : 'applicant');
 }

 private async signedCopy(contract: ContractRow, audience: 'staff' | 'applicant' | 'countersigner'): Promise<FileResult> {
  if (!contract.ownerSignedAt && !contract.driverSignedAt) throw new NotFoundException('Nobody has signed this acknowledgement yet.');
  const document = await this.db.getRepository(DriverConsentDocument).findOneByOrFail({ id: contract.documentId });
  const [images] = await this.db.query(`SELECT "driverImage", "driverMethod", "driverConsent", "driverStatement", "driverIp", "driverAgent", "ownerImage", "ownerMethod", "ownerConsent", "ownerStatement", "ownerIp", "ownerAgent"
   FROM driver_contracts WHERE id = $1`, [contract.id]) as Record<string, string | Buffer | null>[];
  const signatures: (CertificateSignature & { address?: string | null })[] = [{ signerRole: 'APPLICANT', typedName: contract.driverName!, signedAt: contract.driverSignedAt!, address: contract.driverAddress,
   signatureImage: images.driverImage as Buffer, signatureMethod: images.driverMethod as 'DRAWN' | 'TYPED', consent: images.driverConsent as string, statement: images.driverStatement as string,
   ipAddress: images.driverIp as string | null, userAgent: images.driverAgent as string | null, translatedStatement: null, firstViewedAt: contract.driverViewedAt }];
  if (contract.ownerSignedAt) signatures.push({ signerRole: 'COMPANY', typedName: contract.ownerName!, signedAt: contract.ownerSignedAt, signerTitle: `${contract.ownerTitle}, ${contract.ownerCompany}`,
   signatureImage: images.ownerImage as Buffer, signatureMethod: images.ownerMethod as 'DRAWN' | 'TYPED', consent: images.ownerConsent as string, statement: images.ownerStatement as string,
   ipAddress: images.ownerIp as string | null, userAgent: images.ownerAgent as string | null, translatedStatement: null, firstViewedAt: contract.ownerViewedAt });
  const body = await executedDocument(await this.storage.get(driverConsentKey(document)), { ...document, sha256: contract.documentSha256 }, null, signatures, audience);
  return { body, type: 'application/pdf', filename: 'driver-and-contractor-acknowledgement-signed.pdf' };
 }

 /** The verified contract link, its driver and the acknowledgement. After signing, the page stays readable for the session. */
 private async session(em: EntityManager, req: Request, lock: boolean) {
  const first = await sessionLink(em, req);
  if (first.purpose !== 'CONTRACT' && first.purpose !== 'CONTRACT_OWNER') throw new UnauthorizedException('Please verify your email again.');
  const driver = await em.getRepository(Driver).findOne({ where: { id: first.driverId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  const link = lock ? await em.getRepository(DriverLink).findOneByOrFail({ id: first.id }) : first;
  const contract = await this.contract(em, link.contractId!, first.driverId, lock);
  if (!driver || link.revokedAt || contract.cancelledAt || (!link.completedAt && (link.expiresAt.getTime() <= Date.now() || !LEAVABLE.includes(driver.status)))) throw new UnauthorizedException(CLOSED_LINK);
  // The acknowledgement is for one truck: once the driver drives another, an unfinished link for this one stops working.
  if (!link.completedAt && (await roadUnit(em, driver.id))?.id !== contract.unitId) throw new UnauthorizedException(CLOSED_LINK);
  return { link, driver, contract };
 }
 private async describe(em: EntityManager, link: DriverLink, contract: ContractRow) {
  const owner = link.purpose === 'CONTRACT_OWNER';
  const [details] = await em.query(`SELECT d."firstName", d."lastName", t.unit, o.name AS company, o."signerName", o."signerTitle", v.title, v.version, v."pageCount", v.fields
   FROM drivers d JOIN driver_trucks t ON t.id = $2 JOIN truck_owners o ON o.id = $3 JOIN driver_consent_documents v ON v.id = $4 WHERE d.id = $1`,
   [contract.driverId, contract.unitId, contract.ownerId, contract.documentId]) as Record<string, unknown>[];
  return { role: owner ? 'OWNER' : 'DRIVER', email: link.email, expiresAt: link.expiresAt, signedAt: owner ? contract.ownerSignedAt : contract.driverSignedAt,
   bothSigned: !!contract.ownerSignedAt, consent: DRIVER_ESIGN_CONSENT, unit: details.unit, company: details.company, driver: `${details.firstName} ${details.lastName}`.trim(),
   driverSignedAt: contract.driverSignedAt, viewed: !!(owner ? contract.ownerViewedAt : contract.driverViewedAt),
   // What the page offers to start with: the driver's address from their application; the signer and title on the owner's page.
   address: owner ? null : await applicationAddress(em, contract.driverId), signerName: owner ? details.signerName : null, signerTitle: owner ? details.signerTitle : null,
   document: { id: contract.documentId, title: details.title, version: details.version, pageCount: details.pageCount, fields: details.fields } };
 }
 private async contract(em: EntityManager, id: string, driverId: string, lock: boolean): Promise<ContractRow> {
  const [row] = await em.query(`SELECT id, "driverId", "unitId", "ownerId", "documentId", "createdAt", "cancelledAt", "driverSignedAt", "ownerSignedAt", "driverName", "driverAddress", "ownerName", "ownerTitle", "ownerCompany",
   "documentSha256", "driverViewedAt", "ownerViewedAt" FROM driver_contracts WHERE id = $1 AND "driverId" = $2${lock ? ' FOR UPDATE' : ''}`, [id, driverId]) as ContractRow[];
  if (!row) throw new NotFoundException('This acknowledgement no longer exists.');
  return row;
 }
 private async link(em: EntityManager, driver: Driver, contractId: string, purpose: 'CONTRACT' | 'CONTRACT_OWNER', email: string, createdBy: string) {
  const revoked = (await em.getRepository(DriverLink).update({ contractId, purpose, revokedAt: IsNull(), completedAt: IsNull() }, { revokedAt: new Date() })).affected ?? 0;
  const token = randomBytes(32).toString('hex');
  const saved = await em.getRepository(DriverLink).save({ driverId: driver.id, tokenHash: digest(token), email, createdBy, purpose, contractId, expiresAt: new Date(Date.now() + CONTRACT_LINK_DAYS * 86400_000) });
  return { resent: revoked > 0, expiresAt: saved.expiresAt, url: `${webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0]}/driver#${token}` };
 }
 private async lockSender(em: EntityManager, user: User, driverId: string, version: number) {
  const driver = await lockOpenDriver(em, driverId, version);
  if (!SCREENERS.includes(user.role) && !await ownsDriver(em, user, driverId)) throw new ForbiddenException('Only Safety leads, the Safety Director and the driver’s Safety Manager can send contracts.');
  if (!LEAVABLE.includes(driver.status)) throw new ConflictException('Contracts are signed once the driver is approved.');
  return driver;
 }
 private requireStorage() { if (!this.storage.enabled) throw new ServiceUnavailableException('Document storage is not configured.'); }
}

/** The driver's current home address from their application, one line; null when there is none (a driver added from paper). */
async function applicationAddress(em: EntityManager, driverId: string): Promise<string | null> {
 const [row] = await em.query(`SELECT fields FROM driver_applications WHERE "driverId" = $1`, [driverId]) as { fields: Record<string, string> }[];
 const fields = row?.fields ?? {};
 return [fields.addressLine1, fields.addressLine2, fields.city, [fields.state, fields.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
}
