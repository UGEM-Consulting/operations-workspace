import { createItRequest } from '../it/create-request';
import { createMemberForApproval, createSupportForApproval, supportedDispatcher, supportedTeam } from '../dispatch/create-member';
import { NO_MC } from '../dispatch/dispatch.entity';
import { INDEPENDENT_NOT_MC, isIndependent } from '../lists/lists.entity';
import { acceptPaperwork } from '../dispatch/existing.service';
import { ItOnboardingRequest, ItOnboardingTask, itStatus } from '../it/it.entity';
import { askedAs, provisioningDetails, requiredApplicantFields } from './application-requirements';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { canAccessAssignedApplication } from '../auth/policy';
import { Role, User, UserStatus } from '../users/user.entity';
import { ApplicationQueryDto, ChangeManagerDto, ReviewDto } from './dto';
import { moveApplication, responsibleManager, RESPONSIBLE_ROLES } from './hand-over';
import { ApplicationActivity, ApplicationReview, ApplicationStatus, ApplicationSubmission, DispatcherApplication, Invitation, type RequestableItem } from './entities';
import { StorageService } from '../storage/storage.service';
import { documentStatus } from '../documents/requirements';
import { companyStatement } from '../documents/statements';
import { assertSignatureEmbeds, decodeSignature } from '../documents/images';
import type { ClientContext } from '../documents/client-context';
import { CompanyDocument, DocumentSignature, StaffSavedSignature } from '../documents/documents.entity';
import { onboardingLimit } from './rate-limit';
import { requireTransition } from './transitions';
import { UpdatesService } from '../updates/updates.service';
import { NotificationsService } from '../updates/notifications.service';

// Joins each application's latest submitted revision once (at most one row: versions are unique per application),
// so search, sorting and projection read s.fields instead of repeating a correlated subquery per expression.
const LATEST_SUBMISSION = 's.applicationId = a.id AND s.version = (SELECT MAX(x.version) FROM application_submissions x WHERE x."applicationId" = a.id)';
const submittedFields = 's.fields';
// After rejecting outstanding corrections, how long the applicant can still sign in to read the outcome.
const REJECTED_CORRECTION_ACCESS_MS = 7*86400000;
@Injectable()
export class ReviewService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService, private readonly updates: UpdatesService, private readonly notifications: NotificationsService) {}
 private scoped(user: User) {
  if (user.status !== UserStatus.ACTIVE || ![Role.SYSTEM_ADMIN,Role.DISPATCHER_MANAGER].includes(user.role)) throw new ForbiddenException();
  const query = this.db.getRepository(DispatcherApplication).createQueryBuilder('a');
  if (user.role !== Role.SYSTEM_ADMIN) query.where('a.assignedManagerId = :manager',{manager:user.id});
  return query;
 }
 /** The review queues: catch-up paperwork is handled from the Dispatchers page. */
 private listed(user: User) {
  return this.scoped(user).andWhere('a.invitationId NOT IN (SELECT i.id FROM invitations i WHERE i."catchUpMemberId" IS NOT NULL)');
 }
 async summary(user: User) {
  const counts: { status: ApplicationStatus; count: string }[] = await this.listed(user).select('a.status','status').addSelect('COUNT(*)','count').groupBy('a.status').getRawMany();
  const count = (status: ApplicationStatus) => Number(counts.find(row => row.status === status)?.count ?? 0);
  return { awaitingReview: count('SUBMITTED')+count('RESUBMITTED'), changesRequested: count('CHANGES_REQUESTED'), resubmitted: count('RESUBMITTED'), approved: count('APPROVED'), rejected: count('REJECTED') };
 }
 async queue(user: User, input: ApplicationQueryDto) {
  const query = this.listed(user).innerJoin(Invitation,'i','i.id = a.invitationId').leftJoin(ApplicationSubmission,'s',LATEST_SUBMISSION);
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
  const query = this.listed(user).leftJoin(ApplicationSubmission,'s',LATEST_SUBMISSION).addSelect(`COALESCE(${submittedFields}, '{}'::jsonb)`,'submittedFields').orderBy('a.updatedAt','DESC').limit(200);
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
  // Who is responsible now, every earlier change with its note, and whom it can be handed to.
  const [responsible]=await this.db.query(`SELECT id, "firstName", "lastName", role FROM users WHERE id = $1`,[application.assignedManagerId]);
  const managerChanges=await this.db.query(`SELECT c.id, c.reason, c.note, c."createdAt", f."firstName" || ' ' || f."lastName" AS "from", t."firstName" || ' ' || t."lastName" AS "to",
    a."firstName" || ' ' || a."lastName" AS "by" FROM application_manager_changes c JOIN users f ON f.id = c."fromUserId" JOIN users t ON t.id = c."toUserId" JOIN users a ON a.id = c."actorId"
   WHERE c."applicationId" = $1 ORDER BY c."createdAt"`,[id]);
  const managerOptions=await this.db.query(`SELECT id, "firstName", "lastName", role FROM users WHERE status = 'ACTIVE' AND role = ANY($1) AND id <> $2 ORDER BY lower("firstName"), lower("lastName")`,[RESPONSIBLE_ROLES,application.assignedManagerId]);
  const itTasks=itRequest?await this.db.getRepository(ItOnboardingTask).findBy({requestId:itRequest.id}):[];
  // Photos as of the last submission; signatures are final acts and visible once made.
  const documents=await documentStatus(this.db.manager,id,this.storage.enabled,application.submittedAt);
  const canReview=['SUBMITTED','RESUBMITTED'].includes(application.status);
  // Outstanding corrections can still be rejected (CHANGES_REQUESTED -> REJECTED); approval waits for a resubmission.
  const catchUp=!!invitation.catchUpMemberId;
  const canReject=!catchUp&&(canReview||application.status==='CHANGES_REQUESTED');
  const pendingCountersign=documents.documents.find(doc=>doc.countersign&&doc.applicant&&!doc.company)?.applicant;
  // Active list entries for the approval pickers. The decision still carries the chosen names as text, so an older web
  // client without pickers keeps working, and approval matches the text back to these entries.
  const support=invitation.position==='SUPPORT'&&!catchUp;
  // Once someone is a member, what they're called is on their record: a change or a promotion never reaches the invitation.
  const [member]:{position:string;supportType:string}[]=await this.db.query('SELECT position,"supportType" FROM dispatch_members WHERE "applicationId"=$1',[application.id]);
  const employmentOptions=canReview&&!support&&!catchUp?await this.employmentOptions():null;
  // Who a support assists, and the dispatchers and teams a manager may pick instead while deciding.
  const supports=support?{supportsMemberId:invitation.supportsMemberId,supportsTeamId:invitation.supportsTeamId,supportType:invitation.supportType,options:await this.dispatcherOptions(invitation.supportsMemberId),teamOptions:await this.teamOptions(invitation.supportsTeamId)}:null;
  // Never disclose in-progress correction drafts to staff; only submitted revisions.
  return { application:{...application,fields:submissions.at(-1)?.fields ?? {}}, invitation, member:member??null, submissions, activity,
   reviews:reviews.entities.map((review,index)=>({...review,reviewer:{id:review.reviewerId,firstName:reviews.raw[index].reviewerFirstName as string,lastName:reviews.raw[index].reviewerLastName as string}})),
   // The responsible manager sees the company accounts IT created; never IT notes or verification metadata.
   itOnboarding:itRequest?{id:itRequest.id,status:itStatus(itRequest,itTasks),completedAt:itRequest.completedAt,cancelledAt:itRequest.cancelledAt,companyEmail:itRequest.companyEmail,workPhoneNumber:itRequest.assignedRingCentralPhoneNumber}:null,
   // Historical decisions are never second-guessed: missing photos/signatures only matter while the application is open.
   requiredFields:[...requiredApplicantFields(submissions.at(-1)?.fields ?? {},askedAs(invitation)),...(['APPROVED','REJECTED'].includes(application.status)?[]:documents.missing)], itDetails:provisioningDetails(submissions.at(-1)?.fields ?? {}),
   documents:{required:documents.required,photos:{selfie:!!documents.photos.SELFIE,idSelfie:!!documents.photos.ID_SELFIE},
    items:documents.documents.map(({kind,label,requiresSignature,current,applicant,company})=>({kind,label,requiresSignature,current,applicant,company})),
    countersign:canReview&&pendingCountersign?{documentId:pendingCountersign.documentId,title:pendingCountersign.title,version:pendingCountersign.version,fields:pendingCountersign.fields,
     // What the form fills in first, so they only change what's different: their own name, and their last title or else their role.
     signerName:`${user.firstName} ${user.lastName}`.trim(),signerRole:user.role,
     lastTitle:(await this.db.query(`SELECT "signerTitle" FROM document_signatures WHERE "signerUserId" = $1 AND "signerTitle" IS NOT NULL ORDER BY "signedAt" DESC LIMIT 1`,[user.id]))[0]?.signerTitle??null,
     statement:companyStatement({kind:'NDA',title:pendingCountersign.title,version:pendingCountersign.version},pendingCountersign.typedName)}:null},
   canReview, canReject, readyForIt:application.status === 'APPROVED'&&!support&&!catchUp, employmentOptions, supports, catchUp,
   responsibleManager:responsible?{id:responsible.id,firstName:responsible.firstName,lastName:responsible.lastName}:null, managerChanges, managerOptions };
 }
 /**
  * Hands an application, with its invitation and any unfinished IT setup, to another active dispatch manager or
  * administrator (designed and approved 2026-11-02). The current manager or an administrator may do it; the previous
  * manager loses access unless they are an administrator. The applicant isn't told. Finished applications can move too.
  */
 async changeManager(user: User, id: string, dto: ChangeManagerDto) {
  await onboardingLimit(this.db,'manager-change:'+user.id,30,60);
  return this.db.transaction(async em => {
   const current = await em.getRepository(DispatcherApplication).findOneBy({id});
   if (!current || !canAccessAssignedApplication(user,current)) throw new NotFoundException();
   // The invitation first, as every application write does, then the application again under the lock.
   await em.getRepository(Invitation).findOne({where:{id:current.invitationId},lock:{mode:'pessimistic_write'}});
   const application = await em.getRepository(DispatcherApplication).findOneByOrFail({id});
   if (!canAccessAssignedApplication(user,application)) throw new NotFoundException();
   if (dto.managerId === application.assignedManagerId) throw new BadRequestException('They are already the responsible manager.');
   const manager = await responsibleManager(em, dto.managerId);
   await moveApplication(em,{applicationId:id,invitationId:application.invitationId,fromId:application.assignedManagerId,toId:manager.id,actorId:user.id,reason:'CHANGED',note:dto.note||null});
   return { responsibleManager: { id: manager.id, firstName: manager.firstName, lastName: manager.lastName }, canStillOpen: user.role === Role.SYSTEM_ADMIN };
  });
 }
 /** Current dispatchers (not left or leaving, including those in IT setup) with where they work now, plus the one already picked. */
 async dispatcherOptions(current: string | null) {
  return this.db.query(`SELECT d.id, d."firstName" || ' ' || d."lastName" AS name, d.status, CASE WHEN a."mcId" IS NULL THEN '${NO_MC}' ELSE m.name END AS mc, t.name AS team, n.id IS NOT NULL AS leaving
   FROM dispatch_members d LEFT JOIN LATERAL (SELECT * FROM member_assignments a WHERE a."memberId" = d.id AND a."endedAt" IS NULL LIMIT 1) a ON true
   LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN teams t ON t.id = a."teamId"
   LEFT JOIN member_notices n ON n."memberId" = d.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL
   WHERE d.position = 'DISPATCHER' AND ((d.status <> 'LEFT' AND n.id IS NULL) OR d.id = $1) ORDER BY lower(d."firstName"), lower(d."lastName")`, [current]);
 }
 async teamOptions(current: string | null) {
  return this.db.query(`SELECT t.id, t.name, m.name AS mc, t."archivedAt" IS NOT NULL AS archived FROM teams t JOIN mcs m ON m.id = t."mcId" WHERE t."archivedAt" IS NULL OR t.id = $1 ORDER BY t."nameKey"`, [current]);
 }
 async employmentOptions() {
  const [mcs, teams, jobTitles] = await Promise.all([
   this.db.query(`SELECT id, name FROM mcs WHERE "archivedAt" IS NULL ORDER BY "nameKey"`),
   this.db.query(`SELECT t.id, t.name, t."mcId", CASE WHEN l.id IS NULL THEN NULL ELSE l."firstName" || ' ' || l."lastName" END AS lead
    FROM teams t LEFT JOIN dispatch_members l ON l.id = t."leadMemberId" WHERE t."archivedAt" IS NULL ORDER BY t."nameKey"`),
   this.db.query(`SELECT id, name FROM job_titles WHERE "archivedAt" IS NULL ORDER BY "nameKey"`)]);
  return { mcs, teams, jobTitles };
 }
 async decide(user: User, id: string, input: ReviewDto, client: ClientContext) {
  await onboardingLimit(this.db,'review:'+user.id,30,60);
  if (input.countersignature && input.decisionType !== 'APPROVE') throw new BadRequestException('The NDA is countersigned only during approval.');
  const useSaved = !!input.countersignature?.useSavedSignature;
  const drawnImage = !useSaved && input.countersignature?.signature ? decodeSignature(input.countersignature.signature) : null;
  if (drawnImage) await assertSignatureEmbeds(drawnImage);
  if (input.decisionType !== 'APPROVE' && !input.reason?.trim()) throw new BadRequestException('A reason is required.');
  if (input.decisionType === 'REQUEST_CHANGES' && !input.requestedFields.length) throw new BadRequestException('Select at least one field to correct.');
  if (input.decisionType !== 'REQUEST_CHANGES' && !input.confirmed) throw new BadRequestException('Confirm the decision before continuing.');
  if (input.decisionType !== 'REQUEST_CHANGES' && input.requestedFields.length) throw new BadRequestException('Correction fields are only valid for a change request.');
  let alerts: string[] = [];
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
   // Someone catching up already works here: accepting finishes their paperwork, with no employment, IT setup or new record, and there's nothing to reject.
   const catchUpMemberId = invitation.catchUpMemberId;
   if (catchUpMemberId && invitation.revokedAt) throw new ConflictException('This person has left, so their paperwork is closed.');
   if (catchUpMemberId && input.decisionType === 'REJECT') throw new BadRequestException('Paperwork can be accepted or sent back for changes, not rejected.');
   if (catchUpMemberId && (input.employment || input.employmentConfirmed || input.supportsMemberId || input.supportsTeamId)) throw new BadRequestException('Accepting paperwork doesn’t change where they work.');
   // Supports have no employment of their own and no IT setup; approval confirms the dispatcher or team they assist.
   const support = invitation.position === 'SUPPORT' && !catchUpMemberId;
   if (support && (input.employment || input.employmentConfirmed)) throw new BadRequestException('Supports have no MC, team or job title of their own; they follow their dispatcher.');
   if (!support && (input.supportsMemberId || input.supportsTeamId)) throw new BadRequestException('Only a support is approved with a dispatcher or team.');
   if (input.supportsMemberId && input.supportsTeamId) throw new BadRequestException('Choose a dispatcher or a team, not both.');
   if (input.supportType && (!support || input.decisionType !== 'APPROVE')) throw new BadRequestException('Support or updater is confirmed when approving a support.');
   if ((input.supportsMemberId || input.supportsTeamId) && input.decisionType !== 'APPROVE') throw new BadRequestException('The dispatcher or team is confirmed during approval.');
   if (!support && !catchUpMemberId && input.decisionType === 'APPROVE' && (!input.employmentConfirmed || !input.employment)) throw new BadRequestException('Confirm MC, team lead and job title before approval.');
   if (input.employment && input.decisionType !== 'APPROVE') throw new BadRequestException('Employment assignments may be finalized during approval; request applicant corrections otherwise.');
   // Independent is a team choice under an MC, never an MC (an older page may still offer it).
   if (input.employment && isIndependent(input.employment.mcName)) throw new BadRequestException(INDEPENDENT_NOT_MC.staff);
   const submitted = await em.getRepository(ApplicationSubmission).findOne({where:{applicationId:id},order:{version:'DESC'}});
   // Under the invitation lock, so the applicant cannot upload or sign concurrently.
   const documents = await documentStatus(em,id,this.storage.enabled);
   const missing: RequestableItem[] = [...requiredApplicantFields(submitted?.fields ?? {},askedAs(invitation)),...documents.missing];
   if (input.decisionType === 'APPROVE' && missing.length) throw new BadRequestException(`Required applicant fields must be completed before approval. Request corrections for: ${missing.join(', ')}.`);
   const countersign = input.decisionType === 'APPROVE' ? documents.documents.find(doc=>doc.countersign&&doc.applicant&&!doc.company)?.applicant : undefined;
   if (input.countersignature && !countersign) throw new BadRequestException('No NDA countersignature is needed for this application.');
   // The saved signature is read at signing time, inside the decision transaction, and copied into this record.
   const saved = countersign && useSaved ? await em.getRepository(StaffSavedSignature).createQueryBuilder('s').addSelect('s.signatureImage').where('s.userId = :id',{id:user.id}).getOne() : null;
   if (countersign && useSaved && !saved) throw new BadRequestException('Your saved signature is no longer available. Sign here instead.');
   const countersignImage = saved?.signatureImage ?? drawnImage;
   if (countersign && !countersignImage) throw new BadRequestException('Countersign the NDA before approval.');
   if (countersign && !input.countersignature?.title && countersign.fields.some(field=>field.signer==='COMPANY'&&field.kind==='TITLE')) throw new BadRequestException('Add your job title to countersign the NDA.');
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
   // Rejecting outstanding corrections ends the 30-day correction window: REJECTED is terminal, so nothing stays
   // editable, and sign-in remains possible for at most a week so the applicant can read the emailed outcome.
   if (previousStatus === 'CHANGES_REQUESTED' && nextStatus === 'REJECTED') application.applicantAccessUntil = new Date(Math.min(application.applicantAccessUntil.getTime(),Date.now()+REJECTED_CORRECTION_ACCESS_MS));
   await em.save(application);
   const review = await em.getRepository(ApplicationReview).save({applicationId:id,reviewerId:user.id,decisionType:input.decisionType,
    reason:input.reason?.trim() || null,requestedFields,previousStatus,newStatus:nextStatus,applicationVersion:application.version,employment:input.employment ?? null,previousEmployment});
   if (countersign && input.countersignature && countersignImage) {
    const doc = await em.getRepository(CompanyDocument).findOneByOrFail({id:countersign.documentId});
    await em.getRepository(DocumentSignature).save({applicationId:id,documentId:doc.id,signerRole:'COMPANY',signerUserId:user.id,typedName:saved?.typedName ?? input.countersignature.typedName ?? '',signerTitle:input.countersignature.title ?? null,
     signatureImage:countersignImage,signatureMethod:saved?.signatureMethod ?? input.countersignature.signatureMethod ?? 'DRAWN',fromSavedSignature:!!saved,consent:null,statement:companyStatement(doc,countersign.typedName),translatedStatement:null,documentSha256:doc.sha256,...client});
    await em.getRepository(ApplicationActivity).save({invitationId:invitation.id,actorId:user.id,event:'NDA_COUNTERSIGNED'});
   }
   // A new IT checklist alerts the IT specialists; sent after the approval commits.
   if(nextStatus==='APPROVED'&&catchUpMemberId)await acceptPaperwork(em,catchUpMemberId,application.id,submitted?.fields??{},user.id,review.createdAt);
   if(nextStatus==='APPROVED'&&!support&&!catchUpMemberId)alerts=await this.notifications.queueItSetupWaiting(em,await createItRequest(em,application,review,submitted?.fields??{},invitation,user.id));
   // The approved dispatcher becomes a dispatch member record (no login), placed by the confirmed assignments.
   if(nextStatus==='APPROVED'&&!support&&!catchUpMemberId&&input.employment)await createMemberForApproval(em,application,submitted?.fields??{},input.employment,review.createdAt);
   // An approved support becomes an active support record linked to the dispatcher or team confirmed here (no IT setup).
   if(nextStatus==='APPROVED'&&support){
    // A choice made here replaces what the invitation said, either way round.
    const dispatcherId=input.supportsTeamId?null:input.supportsMemberId??invitation.supportsMemberId,teamId=input.supportsMemberId?null:input.supportsTeamId??invitation.supportsTeamId;
    if(!dispatcherId&&!teamId)throw new BadRequestException('Choose the dispatcher or team this support will assist.');
    if(dispatcherId)await supportedDispatcher(em,dispatcherId);else await supportedTeam(em,teamId!);
    const supportType=input.supportType??invitation.supportType;
    if(dispatcherId!==invitation.supportsMemberId||teamId!==invitation.supportsTeamId||supportType!==invitation.supportType){invitation.supportsMemberId=dispatcherId;invitation.supportsTeamId=teamId;invitation.supportType=supportType;await em.save(invitation);}
    await createSupportForApproval(em,application,submitted?.fields??{},{dispatcherId,teamId},review.createdAt,supportType);
   }
   // Durable notification-ready events; no delivery claim or personal field snapshots in audit data.
   await em.getRepository(ApplicationActivity).save({invitationId:application.invitationId,actorId:user.id,event:'APPLICATION_'+nextStatus});
   // The applicant's chosen channels are queued with the decision and sent only after it commits.
   // Accepting paperwork sends no message: nothing about their job changed. Asking for changes sends the usual one.
   if(!(catchUpMemberId&&nextStatus==='APPROVED'))await this.updates.queue(em,application,review);
   return {id:review.id,status:application.status,version:application.version,readyForIt:application.status==='APPROVED'&&!support&&!catchUpMemberId};
  });
  this.updates.dispatch(result.id);
  this.notifications.dispatch(alerts);
  return result;
 }
}
