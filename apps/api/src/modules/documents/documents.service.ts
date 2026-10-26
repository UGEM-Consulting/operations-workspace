import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { canAccessAssignedApplication } from '../auth/policy';
import { ItOnboardingRequest } from '../it/it.entity';
import { DispatcherApplication, type DocumentItem } from '../onboarding/entities';
import { OnboardingService } from '../onboarding/onboarding.service';
import { onboardingLimit } from '../onboarding/rate-limit';
import { documentKey, photoKey, StorageService } from '../storage/storage.service';
import { Role, User, UserStatus } from '../users/user.entity';
import { executedDocument, inspectPdf } from './certificate';
import type { ClientContext } from './client-context';
import { ApplicantSignatureDto, PhotoDto, PublishDocumentDto } from './documents.dto';
import { ApplicantPhoto, CompanyDocument, DOCUMENT_KINDS, DOCUMENT_RULES, DocumentSignature, DocumentView, PHOTO_KINDS, type PhotoKind } from './documents.entity';
import { decodeJpeg, decodePdf, decodeSignature, sha256 } from './images';
import { currentDocuments, photoFor } from './requirements';
import { applicantStatement, ESIGN_CONSENT } from './statements';
export interface FileResult {body:Buffer;type:'image/jpeg'|'application/pdf';filename:string;}
const PHOTO_ITEMS: Record<PhotoKind,DocumentItem> = {SELFIE:'selfiePhoto',ID_SELFIE:'idPhoto'};
@Injectable()
export class DocumentsService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService, private readonly onboarding: OnboardingService) {}
 private requireStorage() { if (!this.storage.enabled) throw new ServiceUnavailableException('Document storage is not configured.'); }
 private staff(user: User) { if (user.status !== UserStatus.ACTIVE || ![Role.SYSTEM_ADMIN,Role.DISPATCHER_MANAGER].includes(user.role)) throw new ForbiddenException(); }
 private applicantId(req: Request) { if (!req.session?.applicantApplicationId) throw new UnauthorizedException('Please verify your access again.'); return req.session.applicantApplicationId; }

 // Company documents: published by managers and administrators, company-wide, immutable versions.
 async list(user: User) {
  this.staff(user);
  const rows = await this.db.getRepository(CompanyDocument).createQueryBuilder('d').innerJoin(User,'u','u.id = d.uploadedBy')
   .addSelect('u.firstName','firstName').addSelect('u.lastName','lastName').orderBy('d.kind').addOrderBy('d.version','DESC').getRawAndEntities();
  const versions = rows.entities.map((doc,index) => ({...doc,uploadedBy:{id:doc.uploadedBy,firstName:rows.raw[index].firstName as string,lastName:rows.raw[index].lastName as string}}));
  return { storageEnabled: this.storage.enabled, kinds: DOCUMENT_KINDS.map(kind => ({ kind, ...DOCUMENT_RULES[kind], versions: versions.filter(doc => doc.kind === kind) })) };
 }
 async publish(user: User, input: PublishDocumentDto) {
  this.staff(user); this.requireStorage();
  await onboardingLimit(this.db,'document-publish:'+user.id,10,3600);
  const file = decodePdf(input.file);
  const pageCount = await inspectPdf(file).catch(() => { throw new BadRequestException('The PDF could not be read. Upload an unencrypted PDF.'); });
  const id = randomUUID();
  await this.storage.put(documentKey(id),file,'application/pdf');
  try {
   return await this.db.transaction(async em => {
    // Serialize publishers per kind so version numbers stay sequential.
    await em.query('SELECT pg_advisory_xact_lock(42002028, $1)',[DOCUMENT_KINDS.indexOf(input.kind)]);
    const [{next}] = await em.query('SELECT COALESCE(MAX(version),0)+1 AS next FROM company_documents WHERE kind = $1',[input.kind]);
    return em.getRepository(CompanyDocument).save({id,kind:input.kind,version:Number(next),title:input.title,sha256:sha256(file),byteSize:file.length,pageCount,uploadedBy:user.id});
   });
  } catch (error) { await this.storage.remove(documentKey(id)); throw error; }
 }
 async companyFile(user: User, id: string): Promise<FileResult> {
  this.staff(user);
  const doc = await this.db.getRepository(CompanyDocument).findOneBy({id}); if (!doc) throw new NotFoundException();
  return { body: await this.storage.get(documentKey(doc.id)), type: 'application/pdf', filename: `${doc.kind.toLowerCase()}-v${doc.version}.pdf` };
 }

 // Applicant uploads and signatures. Every write locks the invitation, like draft saves and submissions.
 private async editableTransaction<T>(req: Request, item: DocumentItem, refused: string, work: (em: EntityManager, application: DispatcherApplication) => Promise<T>) {
  return this.db.transaction(async em => {
   const { application, invitation } = await this.onboarding.applicant(em,req,true);
   if (!(await this.onboarding.editable(em,application)).editableFields.includes(item)) throw new ConflictException(refused);
   const event = await work(em,application);
   return this.onboarding.view(em,application,invitation,event as string);
  });
 }
 async uploadPhoto(req: Request, kind: PhotoKind, input: PhotoDto) {
  const applicationId = this.applicantId(req); this.requireStorage();
  await onboardingLimit(this.db,'photo:'+applicationId,20,900);
  const body = decodeJpeg(input.image), id = randomUUID();
  await this.storage.put(photoKey(applicationId,id),body,'image/jpeg');
  const discard: string[] = [];
  try {
   const view = await this.editableTransaction(req,PHOTO_ITEMS[kind],'Photos cannot be changed now.',async (em,application) => {
    const previous = await em.getRepository(ApplicantPhoto).findOneBy({applicationId,kind,replacedAt:IsNull()});
    if (previous) {
     await em.getRepository(ApplicantPhoto).update(previous.id,{replacedAt:new Date()});
     // Keep photos staff may have reviewed (created before the last submission); discard unsent replacements.
     if (!application.submittedAt || previous.createdAt > application.submittedAt) discard.push(previous.id);
    }
    await em.getRepository(ApplicantPhoto).insert({id,applicationId,kind,sha256:sha256(body),byteSize:body.length});
    return 'PHOTO_UPLOADED';
   });
   for (const old of discard) await this.storage.remove(photoKey(applicationId,old));
   return view;
  } catch (error) { await this.storage.remove(photoKey(applicationId,id)); throw error; }
 }
 async applicantPhoto(req: Request, kind: PhotoKind): Promise<FileResult> {
  const { application } = await this.onboarding.applicant(this.db.manager,req);
  const photo = await photoFor(this.db.manager,application.id,kind); if (!photo) throw new NotFoundException();
  return { body: await this.storage.get(photoKey(application.id,photo.id)), type: 'image/jpeg', filename: `${kind.toLowerCase()}.jpg` };
 }
 /** The applicant may open current documents and anything they signed. Opening is recorded as signing evidence. */
 async applicantDocument(req: Request, documentId: string): Promise<FileResult> {
  const { application } = await this.onboarding.applicant(this.db.manager,req);
  const doc = await this.db.getRepository(CompanyDocument).findOneBy({id:documentId});
  const allowed = doc && ((await currentDocuments(this.db.manager)).some(current => current.id === doc.id)
   || await this.db.getRepository(DocumentSignature).existsBy({applicationId:application.id,documentId,signerRole:'APPLICANT'}));
  if (!doc || !allowed) throw new NotFoundException();
  const body = await this.storage.get(documentKey(doc.id));
  await this.db.getRepository(DocumentView).createQueryBuilder().insert().values({applicationId:application.id,documentId}).orIgnore().execute();
  return { body, type: 'application/pdf', filename: `${doc.kind.toLowerCase()}-v${doc.version}.pdf` };
 }
 async sign(req: Request, documentId: string, input: ApplicantSignatureDto, client: ClientContext) {
  const applicationId = this.applicantId(req); this.requireStorage();
  await onboardingLimit(this.db,'sign:'+applicationId,20,900);
  const image = input.signature ? decodeSignature(input.signature) : null;
  return this.editableTransaction(req,'documents','Documents cannot be signed now.',async em => {
   const doc = (await currentDocuments(em)).find(current => current.id === documentId);
   if (!doc) throw new ConflictException('A newer version of this document was published. Reload and review it before signing.');
   if (DOCUMENT_RULES[doc.kind].signature && !image) throw new BadRequestException('Draw your signature.');
   if (!(await em.getRepository(DocumentView).existsBy({applicationId,documentId}))) throw new BadRequestException('Open and read the full document before signing.');
   if (await em.getRepository(DocumentSignature).existsBy({applicationId,documentId,signerRole:'APPLICANT'})) throw new ConflictException('You have already signed this document.');
   await em.getRepository(DocumentSignature).insert({applicationId,documentId,signerRole:'APPLICANT',signerUserId:null,typedName:input.typedName,
    signatureImage:DOCUMENT_RULES[doc.kind].signature ? image : null,consent:ESIGN_CONSENT,...applicantStatement(doc),documentSha256:doc.sha256,...client});
   return DOCUMENT_RULES[doc.kind].signature ? 'DOCUMENT_SIGNED' : 'DOCUMENT_ACKNOWLEDGED';
  });
 }
 async applicantSignedCopy(req: Request, documentId: string) {
  const { application } = await this.onboarding.applicant(this.db.manager,req);
  return this.signedCopy(this.db.manager,application.id,documentId);
 }

 // Staff access: the responsible manager or an administrator, only for submitted applications.
 private async staffApplication(user: User, id: string) {
  this.staff(user);
  const application = await this.db.getRepository(DispatcherApplication).findOneBy({id});
  if (!application || !canAccessAssignedApplication(user,application) || !application.submittedAt) throw new NotFoundException();
  return application;
 }
 async staffPhoto(user: User, id: string, kind: PhotoKind): Promise<FileResult> {
  const application = await this.staffApplication(user,id);
  const photo = await photoFor(this.db.manager,application.id,kind,application.submittedAt); if (!photo) throw new NotFoundException();
  return { body: await this.storage.get(photoKey(application.id,photo.id)), type: 'image/jpeg', filename: `${kind.toLowerCase()}.jpg` };
 }
 async staffSignedCopy(user: User, id: string, documentId: string) {
  const application = await this.staffApplication(user,id);
  return this.signedCopy(this.db.manager,application.id,documentId);
 }
 /** IT sees only the profile photo (plain selfie) of an approved request, never the ID selfie. */
 async itPhoto(user: User, requestId: string): Promise<FileResult> {
  if (user.status !== UserStatus.ACTIVE || ![Role.SYSTEM_ADMIN,Role.IT_SPECIALIST].includes(user.role)) throw new ForbiddenException();
  const request = await this.db.getRepository(ItOnboardingRequest).findOneBy({id:requestId});
  const application = request && await this.db.getRepository(DispatcherApplication).findOneBy({id:request.applicationId,status:'APPROVED'});
  const photo = application && await photoFor(this.db.manager,application.id,'SELFIE',application.submittedAt);
  if (!application || !photo) throw new NotFoundException();
  return { body: await this.storage.get(photoKey(application.id,photo.id)), type: 'image/jpeg', filename: 'profile-photo.jpg' };
 }
 /** The executed copy: the exact signed version plus a certificate page, generated from immutable records. */
 private async signedCopy(em: EntityManager, applicationId: string, documentId: string): Promise<FileResult> {
  const doc = await em.getRepository(CompanyDocument).findOneBy({id:documentId});
  const signatures = await em.getRepository(DocumentSignature).createQueryBuilder('s').addSelect('s.signatureImage')
   .where('s.applicationId = :applicationId AND s.documentId = :documentId',{applicationId,documentId}).orderBy('s.signedAt','ASC').getMany();
  if (!doc || !signatures.some(signature => signature.signerRole === 'APPLICANT')) throw new NotFoundException();
  const view = await em.getRepository(DocumentView).findOneBy({applicationId,documentId});
  const body = await executedDocument(await this.storage.get(documentKey(doc.id)),doc,applicationId,signatures.map(signature => ({...signature,
   firstViewedAt:signature.signerRole === 'APPLICANT' ? view?.firstViewedAt ?? null : null})));
  return { body, type: 'application/pdf', filename: `${doc.kind.toLowerCase()}-v${doc.version}-signed.pdf` };
 }
}
export const photoKindParam = (value: string): PhotoKind => {
 const kind = ({selfie:'SELFIE','id-selfie':'ID_SELFIE'} as Record<string,PhotoKind>)[value];
 if (!kind || !PHOTO_KINDS.includes(kind)) throw new NotFoundException();
 return kind;
};
