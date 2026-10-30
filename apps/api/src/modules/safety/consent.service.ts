import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { DataSource } from 'typeorm';
import { executedDocument, inspectPdf } from '../documents/certificate';
import type { ClientContext } from '../documents/client-context';
import type { ApplicantSignatureDto } from '../documents/documents.dto';
import type { FileResult } from '../documents/documents.service';
import { assertSignatureEmbeds, decodePdf, decodeSignature, sha256 } from '../documents/images';
import { onboardingLimit } from '../onboarding/rate-limit';
import { CURRENT_LAYOUT, driverConsentKey, StorageService } from '../storage/storage.service';
import { User } from '../users/user.entity';
import { PublishConsentDto } from './consent.dto';
import { CONSENT_KINDS, CONSENT_RULES, consentStatement, DRIVER_ESIGN_CONSENT, DriverConsentDocument, DriverConsentSignature, DriverConsentView } from './consent.entity';
import { currentConsents } from './consent-rules';
import { DriverAccessService } from './driver-access.service';
import { DECIDERS, driverEvent } from './driver-records';

/**
 * Driver consent forms: the Safety manager (or an administrator) publishes each form as an immutable PDF version, and
 * every Safety role reads them. A driver opens and signs the current version of each published form in their
 * application, with the same signing evidence as dispatchers' documents (e-sign consent, recorded view, statement, typed
 * name, signature image, document fingerprint, time, IP and browser); every Safety role opens the signed copy.
 */
@Injectable()
export class ConsentService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService, private readonly access: DriverAccessService) {}
 private requireStorage() { if (!this.storage.enabled) throw new ServiceUnavailableException('Document storage is not configured.'); }

 async list(user: User) {
  const rows: (DriverConsentDocument & { uploader: string | null })[] = await this.db.query(`SELECT d.id, d.kind, d.version, d.title, d.sha256, d."byteSize", d."pageCount", d."createdAt",
   CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS uploader FROM driver_consent_documents d LEFT JOIN users u ON u.id = d."uploadedBy" ORDER BY d.kind, d.version DESC`);
  return { storageEnabled: this.storage.enabled, canPublish: DECIDERS.includes(user.role),
   kinds: CONSENT_KINDS.map(kind => ({ kind, ...CONSENT_RULES[kind], versions: rows.filter(row => row.kind === kind) })) };
 }

 async publish(user: User, dto: PublishConsentDto) {
  if (!DECIDERS.includes(user.role)) throw new ForbiddenException('Only the Safety manager publishes consent forms.');
  this.requireStorage();
  await onboardingLimit(this.db, `consent-publish:${user.id}`, 10, 3600);
  const file = decodePdf(dto.file);
  const pageCount = await inspectPdf(file).catch(() => { throw new BadRequestException('The PDF could not be read. Upload an unencrypted PDF.'); });
  const id = randomUUID(), stored = { id, kind: dto.kind, storageLayout: CURRENT_LAYOUT };
  await this.storage.put(driverConsentKey(stored), file, 'application/pdf');
  try {
   return await this.db.transaction(async em => {
    // Publishers of one kind take turns, so version numbers stay sequential.
    await em.query('SELECT pg_advisory_xact_lock(42002032, $1)', [CONSENT_KINDS.indexOf(dto.kind)]);
    const [{ next }] = await em.query('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM driver_consent_documents WHERE kind = $1', [dto.kind]);
    return em.getRepository(DriverConsentDocument).save({ id, kind: dto.kind, version: Number(next), title: dto.title, sha256: sha256(file), byteSize: file.length, pageCount, uploadedBy: user.id, storageLayout: CURRENT_LAYOUT });
   });
  } catch (error) { await this.storage.remove(driverConsentKey(stored)); throw error; }
 }

 async staffFile(id: string): Promise<FileResult> {
  const document = await this.db.getRepository(DriverConsentDocument).findOneBy({ id });
  if (!document) throw new NotFoundException();
  return { body: await this.storage.get(driverConsentKey(document)), type: 'application/pdf', filename: `${document.kind.toLowerCase().replace(/_/g, '-')}-v${document.version}.pdf` };
 }

 async staffSignedCopy(user: User, driverId: string, documentId: string) {
  await onboardingLimit(this.db, `consent-copy:${user.id}`, 60, 900);
  return this.signedCopy(driverId, documentId);
 }

 // The driver's side, through their verified link session.

 /** The current form, or one the driver signed. Fetching the file records nothing. */
 async driverFile(req: Request, documentId: string): Promise<FileResult> {
  const { driver } = await this.access.session(this.db.manager, req, false);
  const document = await this.db.getRepository(DriverConsentDocument).findOneBy({ id: documentId });
  const allowed = document && ((await currentConsents(this.db.manager)).some(current => current.id === documentId)
   || await this.db.getRepository(DriverConsentSignature).existsBy({ driverId: driver.id, documentId }));
  if (!document || !allowed) throw new NotFoundException();
  return { body: await this.storage.get(driverConsentKey(document)), type: 'application/pdf', filename: `${document.kind.toLowerCase().replace(/_/g, '-')}-v${document.version}.pdf` };
 }

 /** Signing evidence: sent when the driver opens the full current form from their application. Only the first time is kept. */
 async recordView(req: Request, documentId: string) {
  const { link, driver, application } = await this.access.session(this.db.manager, req, false);
  await onboardingLimit(this.db, `consent-view:${link.id}`, 60, 900);
  // Only while the driver can still sign: a view recorded after submitting would later read as "opened before signing".
  if (application.status !== 'DRAFT' || link.completedAt) throw new ConflictException('Your application was already sent to Safety.');
  if (!(await currentConsents(this.db.manager)).some(current => current.id === documentId)) throw new NotFoundException();
  await this.db.getRepository(DriverConsentView).createQueryBuilder().insert().values({ driverId: driver.id, documentId }).orIgnore().execute();
  return { documentId, firstViewedAt: (await this.db.getRepository(DriverConsentView).findOneByOrFail({ driverId: driver.id, documentId })).firstViewedAt };
 }

 async sign(req: Request, documentId: string, dto: ApplicantSignatureDto, client: ClientContext) {
  this.requireStorage();
  const first = await this.access.session(this.db.manager, req, false);
  await onboardingLimit(this.db, `consent-sign:${first.link.id}`, 20, 900);
  const image = dto.signature ? decodeSignature(dto.signature) : null;
  if (image) await assertSignatureEmbeds(image);
  return this.db.transaction(async em => {
   const { link, driver, application } = await this.access.session(em, req, true);
   if (application.status !== 'DRAFT' || link.completedAt) throw new ConflictException('Your application was already sent to Safety.');
   const document = (await currentConsents(em)).find(current => current.id === documentId);
   if (!document) throw new ConflictException('A newer version of this form was published. Reload and review it before signing.');
   const rules = CONSENT_RULES[document.kind];
   if (rules.signature && !image) throw new BadRequestException('Draw your signature.');
   if (!await em.getRepository(DriverConsentView).existsBy({ driverId: driver.id, documentId })) throw new BadRequestException('Open and read the full form before signing. If you already opened it, reload this page and open it again.');
   if (await em.getRepository(DriverConsentSignature).existsBy({ driverId: driver.id, documentId })) throw new ConflictException('You have already signed this form.');
   await em.getRepository(DriverConsentSignature).insert({ driverId: driver.id, documentId, typedName: dto.typedName, signatureImage: rules.signature ? image : null,
    signatureMethod: rules.signature ? dto.signatureMethod ?? 'DRAWN' : null, consent: DRIVER_ESIGN_CONSENT, statement: consentStatement(document), documentSha256: document.sha256, ...client });
   await driverEvent(em, null, driver.id, 'CONSENT_SIGNED', { kind: document.kind });
   return this.access.view(em, link, application);
  });
 }

 async driverSignedCopy(req: Request, documentId: string) {
  const { link, driver } = await this.access.session(this.db.manager, req, false);
  await onboardingLimit(this.db, `consent-copy:${link.id}`, 30, 900);
  return this.signedCopy(driver.id, documentId, 'applicant');
 }

 /** The executed copy: the exact form version that was signed plus a certificate page, from the immutable records. Also saved by SignedCopyArchive. */
 async signedCopy(driverId: string, documentId: string, audience: 'applicant' | 'staff' = 'staff'): Promise<FileResult> {
  const document = await this.db.getRepository(DriverConsentDocument).findOneBy({ id: documentId });
  const signature = await this.db.getRepository(DriverConsentSignature).createQueryBuilder('s').addSelect('s.signatureImage')
   .where('s."driverId" = :driverId AND s."documentId" = :documentId', { driverId, documentId }).getOne();
  if (!document || !signature) throw new NotFoundException();
  const view = await this.db.getRepository(DriverConsentView).findOneBy({ driverId, documentId });
  const body = await executedDocument(await this.storage.get(driverConsentKey(document)), document, null,
   [{ ...signature, signerRole: 'APPLICANT', translatedStatement: null, firstViewedAt: view?.firstViewedAt ?? null }], audience);
  return { body, type: 'application/pdf', filename: `${document.kind.toLowerCase().replace(/_/g, '-')}-v${document.version}-signed.pdf` };
 }
}
