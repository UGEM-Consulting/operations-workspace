import { createItRequest } from '../it/create-request';
import { ItOnboardingRequest, ItOnboardingTask, itStatus } from '../it/it.entity';
import { provisioningDetails, requiredApplicantFields } from './application-requirements';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { canAccessAssignedApplication } from '../auth/policy';
import { Role, User, UserStatus } from '../users/user.entity';
import { ApplicationQueryDto, ReviewDto } from './dto';
import { ApplicationActivity, ApplicationReview, ApplicationStatus, ApplicationSubmission, DispatcherApplication, Invitation, type RequestableItem } from './entities';
import { StorageService } from '../storage/storage.service';
import { documentStatus } from '../documents/requirements';
import { companyStatement } from '../documents/statements';
import { decodeSignature } from '../documents/images';
import type { ClientContext } from '../documents/client-context';
import { CompanyDocument, DocumentSignature } from '../documents/documents.entity';
import { onboardingLimit } from './rate-limit';
import { requireTransition } from './transitions';
import { UpdatesService } from '../updates/updates.service';

const submittedFields = `(SELECT s.fields FROM application_submissions s WHERE s."applicationId" = a.id ORDER BY s.version DESC LIMIT 1)`;
@Injectable()
export class ReviewService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService, private readonly updates: UpdatesService) {}
 private scoped(user: User) {
  if (user.status !== UserStatus.ACTIVE || ![Role.SYSTEM_ADMIN,Role.DISPATCHER_MANAGER].includes(user.role)) throw new ForbiddenException();
  const query = this.db.getRepository(DispatcherApplication).createQueryBuilder('a');
  if (user.role !== Role.SYSTEM_ADMIN) query.where('a.assignedManagerId = :manager',{manager:user.id});
  return query;
 }
 async summary(user: User) {
  const counts: { status: ApplicationStatus; count: string }[] = await this.scoped(user).select('a.status','status').addSelect('COUNT(*)','count').groupBy('a.status').getRawMany();
  const count = (status: ApplicationStatus) => Number(counts.find(row => row.status === status)?.count ?? 0);
  return { awaitingReview: count('SUBMITTED')+count('RESUBMITTED'), changesRequested: count('CHANGES_REQUESTED'), resubmitted: count('RESUBMITTED'), approved: count('APPROVED'), rejected: count('REJECTED') };
 }
 async queue(user: User, input: ApplicationQueryDto) {
  const query = this.scoped(user).innerJoin(Invitation,'i','i.id = a.invitationId');
  if (input.status === 'AWAITING_REVIEW') query.andWhere('a.status IN (:...statuses)',{statuses:['SUBMITTED','RESUBMITTED']});
  else if (input.status !== 'ALL') query.andWhere('a.status = :status',{status:input.status});
  if (input.search) {
   const search = '%' + input.search.replace(/[\\%_]/g, '\\$&') + '%';
   query.andWhere(`(concat(${submittedFields}->>'firstName',' ',${submittedFields}->>'lastName') ILIKE :search OR i.email ILIKE :search OR (COALESCE(i."mcName",${submittedFields}->>'mcName')) ILIKE :search OR (COALESCE(i."teamLead",${submittedFields}->>'teamLead')) ILIKE :search OR CAST(a.id AS text) ILIKE :search)`,{search});
  }
  const total = await query.getCount();
  const sort = { updatedAt:'a.updatedAt', submittedAt:'a.submittedAt', name:`${submittedFields}->>'lastName'`, status:'a.status' }[input.sort] ?? 'a.updatedAt';
  const result = await query.addSelect(`COALESCE(${submittedFields}, '{}'::jsonb)`,'submittedFields')
   .addSelect('i.email','email').addSelect(`COALESCE(i."mcName",${submittedFields}->>'mcName')`,'mcName').addSelect(`COALESCE(i."teamLead",${submittedFields}->>'teamLead')`,'teamLead')
   .orderBy(sort,input.direction,'NULLS LAST').addOrderBy('a.id','ASC').offset((input.page-1)*input.pageSize).limit(input.pageSize).getRawAndEntities();
  const items = result.entities.map((application,index) => ({ ...application, fields: result.raw[index].submittedFields,
   email: result.raw[index].email as string, mcName: result.raw[index].mcName as string, teamLead: result.raw[index].teamLead as string }));
  return { items, total, page: input.page, pageSize: input.pageSize, pageCount: Math.ceil(total/input.pageSize) };
 }
 async legacyList(user: User) {
  // Preserve the original array API; the review UI uses the paginated queue.
  const query = this.scoped(user).addSelect(`COALESCE(${submittedFields}, '{}'::jsonb)`,'submittedFields').orderBy('a.updatedAt','DESC').limit(200);
  const result = await query.getRawAndEntities();
  return result.entities.map((application,index) => ({ ...application,fields:result.raw[index].submittedFields }));
 }
 async detail(user: User, id: string) {
  const application = await this.scoped(user).andWhere('a.id = :id',{id}).getOne();
  if (!application) throw new NotFoundException();
  if (!application.submittedAt) throw new ConflictException('Application has not been submitted.');
  const invitation = await this.db.getRepository(Invitation).findOneByOrFail({id:application.invitationId});
  const submissions = await this.db.getRepository(ApplicationSubmission).find({where:{applicationId:id},order:{version:'ASC'}});
  const reviews = await this.db.getRepository(ApplicationReview).createQueryBuilder('r').innerJoin(User,'u','u.id = r.reviewerId')
   .addSelect('u.firstName','reviewerFirstName').addSelect('u.lastName','reviewerLastName')
   .where('r.applicationId = :id',{id}).orderBy('r.applicationVersion','ASC').getRawAndEntities();
  const activity = await this.db.getRepository(ApplicationActivity).find({where:{invitationId:invitation.id},order:{createdAt:'ASC'}});
  const itRequest=await this.db.getRepository(ItOnboardingRequest).findOneBy({applicationId:id});
  const itTasks=itRequest?await this.db.getRepository(ItOnboardingTask).findBy({requestId:itRequest.id}):[];
  // Photos as of the last submission; signatures are final acts and visible once made.
  const documents=await documentStatus(this.db.manager,id,this.storage.enabled,application.submittedAt);
  const canReview=['SUBMITTED','RESUBMITTED'].includes(application.status);
  const pendingCountersign=documents.documents.find(doc=>doc.countersign&&doc.applicant&&!doc.company)?.applicant;
  // Never disclose in-progress correction drafts to staff; only submitted revisions.
  return { application:{...application,fields:submissions.at(-1)?.fields ?? {}}, invitation, submissions, activity,
   reviews:reviews.entities.map((review,index)=>({...review,reviewer:{id:review.reviewerId,firstName:reviews.raw[index].reviewerFirstName as string,lastName:reviews.raw[index].reviewerLastName as string}})),
   // The responsible manager sees the company accounts IT created; never IT notes or verification metadata.
   itOnboarding:itRequest?{id:itRequest.id,status:itStatus(itRequest,itTasks),completedAt:itRequest.completedAt,companyEmail:itRequest.companyEmail,workPhoneNumber:itRequest.assignedRingCentralPhoneNumber}:null,
   // Historical decisions are never second-guessed: missing photos/signatures only matter while the application is open.
   requiredFields:[...requiredApplicantFields(submissions.at(-1)?.fields ?? {}),...(['APPROVED','REJECTED'].includes(application.status)?[]:documents.missing)], itDetails:provisioningDetails(submissions.at(-1)?.fields ?? {}),
   documents:{required:documents.required,photos:{selfie:!!documents.photos.SELFIE,idSelfie:!!documents.photos.ID_SELFIE},
    items:documents.documents.map(({kind,label,requiresSignature,current,applicant,company})=>({kind,label,requiresSignature,current,applicant,company})),
    countersign:canReview&&pendingCountersign?{documentId:pendingCountersign.documentId,title:pendingCountersign.title,version:pendingCountersign.version,
     statement:companyStatement({kind:'NDA',title:pendingCountersign.title,version:pendingCountersign.version},pendingCountersign.typedName)}:null},
   canReview, readyForIt:application.status === 'APPROVED' };
 }
 async decide(user: User, id: string, input: ReviewDto, client: ClientContext) {
  await onboardingLimit(this.db,'review:'+user.id,30,60);
  if (input.countersignature && input.decisionType !== 'APPROVE') throw new BadRequestException('The NDA is countersigned only during approval.');
  const countersignImage = input.countersignature?.signature ? decodeSignature(input.countersignature.signature) : null;
  if (input.decisionType !== 'APPROVE' && !input.reason?.trim()) throw new BadRequestException('A reason is required.');
  if (input.decisionType === 'REQUEST_CHANGES' && !input.requestedFields.length) throw new BadRequestException('Select at least one field to correct.');
  if (input.decisionType !== 'REQUEST_CHANGES' && !input.confirmed) throw new BadRequestException('Confirm the decision before continuing.');
  if (input.decisionType !== 'REQUEST_CHANGES' && input.requestedFields.length) throw new BadRequestException('Correction fields are only valid for a change request.');
  const result = await this.db.transaction(async em => {
   const initial = await em.getRepository(DispatcherApplication).findOneBy({id});
   if (!initial || !canAccessAssignedApplication(user,initial)) throw new NotFoundException();
   // Same lock ordering as applicant saves/revocation. Re-read after obtaining the lock.
   const invitation = await em.getRepository(Invitation).findOneOrFail({where:{id:initial.invitationId},lock:{mode:'pessimistic_write'}});
   const application = await em.getRepository(DispatcherApplication).findOneByOrFail({id});
   if (!canAccessAssignedApplication(user,application)) throw new NotFoundException();
   if (application.version !== input.version) throw new ConflictException('This application changed. Reload before deciding.');
   const nextStatus: ApplicationStatus = input.decisionType === 'APPROVE' ? 'APPROVED' : input.decisionType === 'REJECT' ? 'REJECTED' : 'CHANGES_REQUESTED';
   requireTransition(application.status,nextStatus);
   if (input.decisionType === 'APPROVE' && (!input.employmentConfirmed || !input.employment)) throw new BadRequestException('Confirm MC, team lead and job title before approval.');
   if (input.employment && input.decisionType !== 'APPROVE') throw new BadRequestException('Employment assignments may be finalized during approval; request applicant corrections otherwise.');
   const submitted = await em.getRepository(ApplicationSubmission).findOne({where:{applicationId:id},order:{version:'DESC'}});
   // Under the invitation lock, so the applicant cannot upload or sign concurrently.
   const documents = await documentStatus(em,id,this.storage.enabled);
   const missing: RequestableItem[] = [...requiredApplicantFields(submitted?.fields ?? {}),...documents.missing];
   if (input.decisionType === 'APPROVE' && missing.length) throw new BadRequestException(`Required applicant fields must be completed before approval. Request corrections for: ${missing.join(', ')}.`);
   const countersign = input.decisionType === 'APPROVE' ? documents.documents.find(doc=>doc.countersign&&doc.applicant&&!doc.company)?.applicant : undefined;
   if (input.countersignature && !countersign) throw new BadRequestException('No NDA countersignature is needed for this application.');
   if (countersign && !countersignImage) throw new BadRequestException('Countersign the NDA before approval.');
   const requestedFields = input.decisionType === 'REQUEST_CHANGES' ? [...new Set([...input.requestedFields,...missing])] : input.requestedFields;
   const previousEmployment = input.employment ? {mcName:invitation.mcName ?? '',teamLead:invitation.teamLead ?? '',jobTitle:invitation.jobTitle ?? ''} : null;
   if (input.employment) {
    invitation.mcName = input.employment.mcName;
    invitation.teamLead = input.employment.teamLead;
    invitation.jobTitle = input.employment.jobTitle;
    await em.save(invitation);
    await em.getRepository(ApplicationActivity).save({invitationId:invitation.id,actorId:user.id,event:'EMPLOYMENT_CONFIRMED'});
   }
   const previousStatus = application.status;
   application.status = nextStatus;
   application.version += 1;
   if (nextStatus === 'CHANGES_REQUESTED') application.applicantAccessUntil = new Date(Date.now()+30*86400000);
   await em.save(application);
   const review = await em.getRepository(ApplicationReview).save({applicationId:id,reviewerId:user.id,decisionType:input.decisionType,
    reason:input.reason?.trim() || null,requestedFields,previousStatus,newStatus:nextStatus,applicationVersion:application.version,employment:input.employment ?? null,previousEmployment});
   if (countersign && input.countersignature && countersignImage) {
    const doc = await em.getRepository(CompanyDocument).findOneByOrFail({id:countersign.documentId});
    await em.getRepository(DocumentSignature).save({applicationId:id,documentId:doc.id,signerRole:'COMPANY',signerUserId:user.id,typedName:input.countersignature.typedName,
     signatureImage:countersignImage,consent:null,statement:companyStatement(doc,countersign.typedName),translatedStatement:null,documentSha256:doc.sha256,...client});
    await em.getRepository(ApplicationActivity).save({invitationId:invitation.id,actorId:user.id,event:'NDA_COUNTERSIGNED'});
   }
   if(nextStatus==='APPROVED')await createItRequest(em,application,review,submitted?.fields??{},invitation);
   // Durable notification-ready events; no delivery claim or personal field snapshots in audit data.
   await em.getRepository(ApplicationActivity).save({invitationId:application.invitationId,actorId:user.id,event:'APPLICATION_'+nextStatus});
   // The applicant's chosen channels are queued with the decision and sent only after it commits.
   await this.updates.queue(em,application,review);
   return {id:review.id,status:application.status,version:application.version,readyForIt:application.status==='APPROVED'};
  });
  this.updates.dispatch(result.id);
  return result;
 }
}
