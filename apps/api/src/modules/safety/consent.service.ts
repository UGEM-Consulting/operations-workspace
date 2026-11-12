import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { DataSource, EntityManager } from 'typeorm';
import { executedDocument } from '../documents/certificate';
import type { ClientContext } from '../documents/client-context';
import type { ApplicantSignatureDto } from '../documents/documents.dto';
import type { FileResult } from '../documents/documents.service';
import { checkedFields } from '../documents/fields';
import { assertSignatureEmbeds, decodeSignature, sha256 } from '../documents/images';
import { onboardingLimit } from '../onboarding/rate-limit';
import { CURRENT_LAYOUT, driverConsentKey, StorageService } from '../storage/storage.service';
import { User } from '../users/user.entity';
import { PublishConsentDto } from './consent.dto';
import { CONSENT_KINDS, CONSENT_RULES, consentStatement, DRIVER_ESIGN_CONSENT, DriverConsentDocument, DriverConsentSignature, DriverConsentView } from './consent.entity';
import { currentConsents } from './consent-rules';
import { DriverAccessService } from './driver-access.service';
import { DECIDERS, driverEvent, sessionLink } from './driver-records';
import { driverLicenseRules } from './license-rules';
import type { DriverLink } from './safety.entity';
import { CatchUpService } from './existing-drivers';
import { publishPdfVersion, readPublishedPdf } from './published-pdfs';
import { personName } from './sql';

/**
 * Driver consent forms: the Safety manager (or an administrator) publishes each form as an immutable PDF version, and
 * every Safety role reads them. A driver opens and signs the current version of each published form in their
 * application, with the same signing evidence as dispatchers' documents (e-sign consent, recorded view, statement, typed
 * name, signature image, document fingerprint, time, IP and browser); every Safety role opens the signed copy.
 */
@Injectable()
export class ConsentService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService, private readonly access: DriverAccessService, private readonly catchUp: CatchUpService) {}

 /**
  * Who is signing: a driver with their application link (while it is a draft), or an existing driver with their catch-up
  * link (while it is open; section 34). Either way the page gets back what it shows, and the forms open to this driver:
  * the current version of each kind their license calls for, never the truck owner's acknowledgement (appliesTo).
  */
 private async signer(em: EntityManager, req: Request, lock: boolean, known?: DriverLink) {
  const first = known ?? await sessionLink(em, req);
  const forms = (driverId: string, hasApplication: boolean) => async () => currentConsents(em, await driverLicenseRules(em, driverId), hasApplication);
  if (first.purpose === 'CATCH_UP') {
   const { link, driver } = await this.catchUp.session(em, req, lock, first);
   return { link, driver, forms: forms(driver.id, false), editable: !link.completedAt, closed: 'You already sent your documents to Safety.', view: () => this.catchUp.describe(em, link) };
  }
  const { link, driver, application } = await this.access.session(em, req, lock, first);
  return { link, driver, forms: forms(driver.id, true), editable: application.status === 'DRAFT' && !link.completedAt, closed: 'Your application was already sent to Safety.', view: () => this.access.view(em, link, application) };
 }
 private requireStorage() { if (!this.storage.enabled) throw new ServiceUnavailableException('Document storage is not configured.'); }

 async list(user: User) {
  const rows: (DriverConsentDocument & { uploader: string | null })[] = await this.db.query(`SELECT d.id, d.kind, d.version, d.title, d.sha256, d."byteSize", d."pageCount", d."createdAt", d.fields,
   ${personName('u')} AS uploader FROM driver_consent_documents d LEFT JOIN users u ON u.id = d."uploadedBy" ORDER BY d.kind, d.version DESC`);
  return { storageEnabled: this.storage.enabled, canPublish: DECIDERS.includes(user.role),
   kinds: CONSENT_KINDS.map(kind => ({ kind, ...CONSENT_RULES[kind], versions: rows.filter(row => row.kind === kind) })) };
 }

 async publish(user: User, dto: PublishConsentDto) {
  if (!DECIDERS.includes(user.role)) throw new ForbiddenException('Only the Safety Director publishes consent forms.');
  this.requireStorage();
  await onboardingLimit(this.db, `consent-publish:${user.id}`, 10, 3600);
  const { file, pageCount } = await readPublishedPdf(dto.file);
  // Acknowledged forms still take a typed name; only a signed one has somewhere to sign. Nobody countersigns.
  // The acknowledgement also has the driver's address and the truck owner's signer (section 39); the other forms are the driver's alone.
  const contract = !!CONSENT_RULES[dto.kind].contract;
  const fields = checkedFields(dto.fields, pageCount, { signature: CONSENT_RULES[dto.kind].signature, typedName: true, countersign: contract, americanName: false, address: contract });
  const id = randomUUID(), stored = { id, kind: dto.kind, storageLayout: CURRENT_LAYOUT };
  return publishPdfVersion(this.db, this.storage, { file, key: driverConsentKey(stored), lock: CONSENT_KINDS.indexOf(dto.kind), table: 'driver_consent_documents', kind: dto.kind,
   save: (em, version) => em.getRepository(DriverConsentDocument).save({ id, kind: dto.kind, version, title: dto.title, sha256: sha256(file), byteSize: file.length, pageCount, uploadedBy: user.id, storageLayout: CURRENT_LAYOUT, fields }) });
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
  const { driver, forms } = await this.signer(this.db.manager, req, false);
  const document = await this.db.getRepository(DriverConsentDocument).findOneBy({ id: documentId });
  const allowed = document && ((await forms()).some(current => current.id === documentId)
   || await this.db.getRepository(DriverConsentSignature).existsBy({ driverId: driver.id, documentId }));
  if (!document || !allowed) throw new NotFoundException();
  return { body: await this.storage.get(driverConsentKey(document)), type: 'application/pdf', filename: `${document.kind.toLowerCase().replace(/_/g, '-')}-v${document.version}.pdf` };
 }

 /** Signing evidence: sent when the driver opens the full current form from their application. Only the first time is kept. */
 async recordView(req: Request, documentId: string) {
  const { link, driver, editable, closed, forms } = await this.signer(this.db.manager, req, false);
  await onboardingLimit(this.db, `consent-view:${link.id}`, 60, 900);
  // Only while the driver can still sign: a view recorded after submitting would later read as "opened before signing".
  if (!editable) throw new ConflictException(closed);
  if (!(await forms()).some(current => current.id === documentId)) throw new NotFoundException();
  await this.db.getRepository(DriverConsentView).createQueryBuilder().insert().values({ driverId: driver.id, documentId }).orIgnore().execute();
  return { documentId, firstViewedAt: (await this.db.getRepository(DriverConsentView).findOneByOrFail({ driverId: driver.id, documentId })).firstViewedAt };
 }

 async sign(req: Request, documentId: string, dto: ApplicantSignatureDto, client: ClientContext) {
  this.requireStorage();
  // The link is read once here for the limit, and passed to the locked check inside the transaction.
  const first = await sessionLink(this.db.manager, req);
  await onboardingLimit(this.db, `consent-sign:${first.id}`, 20, 900);
  const image = dto.signature ? decodeSignature(dto.signature) : null;
  if (image) await assertSignatureEmbeds(image);
  return this.db.transaction(async em => {
   const { driver, editable, closed, view, forms } = await this.signer(em, req, true, first);
   if (!editable) throw new ConflictException(closed);
   const document = (await forms()).find(current => current.id === documentId);
   if (!document) throw new ConflictException('A newer version of this form was published. Reload and review it before signing.');
   const rules = CONSENT_RULES[document.kind];
   if (rules.signature && !image) throw new BadRequestException('Draw your signature.');
   if (!await em.getRepository(DriverConsentView).existsBy({ driverId: driver.id, documentId })) throw new BadRequestException('Open and read the full form before signing. If you already opened it, reload this page and open it again.');
   if (await em.getRepository(DriverConsentSignature).existsBy({ driverId: driver.id, documentId })) throw new ConflictException('You have already signed this form.');
   await em.getRepository(DriverConsentSignature).insert({ driverId: driver.id, documentId, typedName: dto.typedName, signatureImage: rules.signature ? image : null,
    signatureMethod: rules.signature ? dto.signatureMethod ?? 'DRAWN' : null, consent: DRIVER_ESIGN_CONSENT, statement: consentStatement(document), documentSha256: document.sha256, ...client });
   await driverEvent(em, null, driver.id, 'CONSENT_SIGNED', { kind: document.kind });
   return view();
  });
 }

 async driverSignedCopy(req: Request, documentId: string) {
  const { link, driver } = await this.signer(this.db.manager, req, false);
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
