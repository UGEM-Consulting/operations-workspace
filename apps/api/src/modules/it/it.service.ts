import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { activateMember } from '../dispatch/create-member';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { ApplicationActivity, ApplicationReview, DispatcherApplication } from '../onboarding/entities';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { onboardingLimit } from '../onboarding/rate-limit';
import { photoFor } from '../documents/requirements';
import { Role, User, UserStatus } from '../users/user.entity';
import { ItContactDto, ItQueueDto, ItTasksDto, RemovalTaskDto, TaskUpdateDto } from './it.dto';
import { usDay } from '../safety/screening-rules';
import { NotificationsService } from '../updates/notifications.service';
import { IT_CHECKLIST, isOptionalTask, ItOnboardingActivity, ItOnboardingRequest, ItOnboardingTask, ItRemovalActivity, ItRemovalRequest, ItRemovalTask, itStatus, itStatusSql, PortalNotification, REMOVAL_CHECKLIST, removalScheduled, removalTaskDone, taskDone } from './it.entity';

const statusSql=itStatusSql('r');
// Setups (approved, not cancelled) and removals as one list for IT tasks; each row's progress uses the shared rule.
const TASK_ROWS=`SELECT 'SETUP' AS kind, r.id, r.profile->>'proposedDisplayName' AS name, r.profile->>'personalEmail' AS email, r.profile->>'mcName' AS mc,
  ${itStatusSql('r')} AS status, (SELECT count(*) FROM it_onboarding_tasks t WHERE t."requestId" = r.id AND t.status IN ('COMPLETED','NOT_NEEDED'))::integer AS done,
  (SELECT count(*) FROM it_onboarding_tasks t WHERE t."requestId" = r.id)::integer AS total, NULL::text AS "dueOn", NULL::timestamptz AS "removeNowAt", r."createdAt", r."updatedAt", r."completedAt"
 FROM it_onboarding_requests r JOIN dispatcher_applications a ON a.id = r."applicationId" AND a.status = 'APPROVED'
 JOIN application_reviews v ON v.id = r."approvalId" AND v."applicationId" = r."applicationId" AND v."decisionType" = 'APPROVE' WHERE r."cancelledAt" IS NULL
 UNION ALL
 SELECT 'REMOVAL', m.id, m.profile->>'displayName', m.profile->>'companyEmail', m.profile->>'mcName', ${itStatusSql('m','it_removal_tasks')},
  (SELECT count(*) FROM it_removal_tasks t WHERE t."requestId" = m.id AND t.status IN ('COMPLETED','NOT_NEEDED'))::integer,
  (SELECT count(*) FROM it_removal_tasks t WHERE t."requestId" = m.id)::integer, m."dueOn"::text, m."removeNowAt", m."createdAt", m."updatedAt", m."completedAt"
 FROM it_removal_requests m WHERE m."cancelledAt" IS NULL`;
// Not due yet: the Eastern date (the given parameter) hasn't reached the last day and nobody asked to remove access now.
const scheduledSql=(today:string)=>`(kind = 'REMOVAL' AND "completedAt" IS NULL AND "removeNowAt" IS NULL AND "dueOn"::date > ${today}::date)`;
const SCHEDULED=scheduledSql('$2');
const VIEW_SQL:Record<ItTasksDto['view'],string>={open:`status <> 'COMPLETED'`,setup:`kind = 'SETUP' AND status <> 'COMPLETED'`,removal:`kind = 'REMOVAL' AND status <> 'COMPLETED' AND NOT ${SCHEDULED}`,scheduled:SCHEDULED,finished:`status = 'COMPLETED'`,all:'true'};
/** IT access requires the approved application and the APPROVE review the request was created from. */
export async function approvedApplication(em:EntityManager,request:ItOnboardingRequest){
 const app=await em.getRepository(DispatcherApplication).findOneBy({id:request.applicationId,status:'APPROVED'});
 const approval=await em.getRepository(ApplicationReview).findOneBy({id:request.approvalId,applicationId:request.applicationId,decisionType:'APPROVE'});
 if(!app||!approval)throw new NotFoundException();return app;
}
@Injectable()
export class ItService {
 constructor(private readonly db:DataSource,private readonly alerts:NotificationsService){}
 private allowIt(user:User){if(user.status!==UserStatus.ACTIVE||![Role.SYSTEM_ADMIN,Role.IT_SPECIALIST].includes(user.role))throw new ForbiddenException();}
 async queue(user:User,input:ItQueueDto){
  this.allowIt(user);
  const query=this.db.getRepository(ItOnboardingRequest).createQueryBuilder('r')
   .innerJoin(DispatcherApplication,'a','a.id=r.applicationId AND a.status = :approved',{approved:'APPROVED'})
   .innerJoin(ApplicationReview,'v',"v.id=r.approvalId AND v.applicationId=r.applicationId AND v.decisionType='APPROVE'").where('r.cancelledAt IS NULL');
  if(input.status!=='ALL')query.andWhere(`${statusSql} = :status`,{status:input.status});
  if(input.search)query.andWhere(`concat(r.profile->>'proposedDisplayName',' ',r.profile->>'personalEmail',' ',r.profile->>'mcName') ILIKE :search`,{search:'%'+input.search.replace(/[\\%_]/g,'\\$&')+'%'});
  const total=await query.getCount();
  const result=await query.addSelect(statusSql,'progress').orderBy('r.updatedAt','DESC').addOrderBy('r.id','ASC').offset((input.page-1)*input.pageSize).limit(input.pageSize).getRawAndEntities();
  return {items:result.entities.map((row,index)=>({...row,status:result.raw[index].progress as string})),total,page:input.page,pageSize:input.pageSize,pageCount:Math.ceil(total/input.pageSize)};
 }
 private async detail(em:EntityManager,request:ItOnboardingRequest){
  const tasks=await em.getRepository(ItOnboardingTask).findBy({requestId:request.id});
  this.checklistComplete(tasks);
  const activity=await em.getRepository(ItOnboardingActivity).find({where:{requestId:request.id},order:{createdAt:'ASC'}});
  // This projection deliberately excludes application revisions, applicant sessions and reviewer comments.
  // IT sees only whether a profile photo (the plain selfie) exists; never the ID selfie.
  const application=await em.getRepository(DispatcherApplication).findOneByOrFail({id:request.applicationId});
  const profilePhoto=!!await photoFor(em,application.id,'SELFIE',application.submittedAt);
  return {request:{...request,status:itStatus(request,tasks),profilePhoto},tasks:IT_CHECKLIST.flatMap(template=>{const task=tasks.find(item=>item.key===template.key);return task?[{...task,label:template.label,description:template.description,optional:!!template.optional}]:[];}),activity};
 }
 // Every required task must exist. An optional task added later is missing only on requests created before it existed.
 private checklistComplete(tasks:Pick<ItOnboardingTask,'key'>[]){
  if(IT_CHECKLIST.some(template=>!template.optional&&!tasks.some(task=>task.key===template.key)))throw new ConflictException('The checklist is incomplete. Contact an administrator.');
 }
 /**
  * IT tasks: setups and removals together. Removals that are due come first, the earliest first, then setups by most
  * recently updated, with scheduled removals last. Counts for each view and the stat cards cover every task.
  */
 async tasks(user:User,input:ItTasksDto){
  this.allowIt(user);
  const search=input.search?'%'+input.search.replace(/[\\%_]/g,'\\$&')+'%':'';
  const today=usDay('latest');
  const where=`(${VIEW_SQL[input.view]}) AND ($1 = '' OR concat(name,' ',email,' ',mc) ILIKE $1)`;
  const [rows,[count],[stats]]=await Promise.all([
   this.db.query(`WITH rows AS (${TASK_ROWS}) SELECT *, ${SCHEDULED} AS scheduled FROM rows WHERE ${where}
    ORDER BY (kind = 'REMOVAL' AND "completedAt" IS NULL AND NOT ${SCHEDULED}) DESC, ${SCHEDULED} ASC, "dueOn" ASC NULLS LAST, "updatedAt" DESC, id LIMIT $3 OFFSET $4`,[search,today,input.pageSize,(input.page-1)*input.pageSize]),
   this.db.query(`WITH rows AS (${TASK_ROWS}) SELECT count(*)::integer AS total FROM rows WHERE ${where} AND $2::date IS NOT NULL`,[search,today]),
   this.db.query(`WITH rows AS (${TASK_ROWS}) SELECT
     count(*) FILTER (WHERE status <> 'COMPLETED')::integer AS open, count(*) FILTER (WHERE kind = 'SETUP' AND status <> 'COMPLETED')::integer AS setup,
     count(*) FILTER (WHERE kind = 'REMOVAL' AND status <> 'COMPLETED' AND NOT ${scheduledSql('$1')})::integer AS removal, count(*) FILTER (WHERE ${scheduledSql('$1')})::integer AS scheduled, min("dueOn") FILTER (WHERE ${scheduledSql('$1')}) AS "nextScheduled",
     count(*) FILTER (WHERE status = 'COMPLETED')::integer AS finished, count(*)::integer AS "all",
     count(*) FILTER (WHERE kind = 'REMOVAL' AND status <> 'COMPLETED' AND NOT ${scheduledSql('$1')})::integer AS "removalsDue",
     count(*) FILTER (WHERE kind = 'SETUP' AND status = 'PENDING')::integer AS "setupsWaiting", count(*) FILTER (WHERE status = 'BLOCKED')::integer AS blocked,
     count(*) FILTER (WHERE status = 'COMPLETED' AND "completedAt" >= date_trunc('month', now()))::integer AS "finishedThisMonth" FROM rows`,[today]),
  ]);
  return {items:rows,total:count.total,page:input.page,pageSize:input.pageSize,pageCount:Math.ceil(count.total/input.pageSize),stats};
 }
 async get(user:User,id:string){this.allowIt(user);const request=await this.db.getRepository(ItOnboardingRequest).findOneBy({id});if(!request)throw new NotFoundException();await approvedApplication(this.db.manager,request);return this.detail(this.db.manager,request);}
 private async locked(em:EntityManager,id:string,version:number){
  const request=await em.getRepository(ItOnboardingRequest).findOne({where:{id},lock:{mode:'pessimistic_write'}});
  if(!request)throw new NotFoundException();await approvedApplication(em,request);
  if(request.completedAt)throw new ConflictException('This onboarding request is completed and cannot be changed.');
  if(request.cancelledAt)throw new ConflictException('This setup was cancelled because the dispatcher left. Their accounts are on the removal checklist.');
  if(request.version!==version)throw new ConflictException('This request changed. Reload before saving.');return request;
 }
 async contact(user:User,id:string,input:ItContactDto){
  this.allowIt(user);await onboardingLimit(this.db,'it-contact:'+user.id,60,60);
  return this.db.transaction(async em=>{
   const request=await this.locked(em,id,input.version);
   if(input.workPhoneVerified&&(!request.profile.workPhoneNumber||!INTERNATIONAL_PHONE_PATTERN.test(request.profile.workPhoneNumber.trim())))throw new BadRequestException('The applicant work phone must be valid before IT can verify it.');
   const assigned=input.assignedRingCentralPhoneNumber===undefined?request.assignedRingCentralPhoneNumber:input.assignedRingCentralPhoneNumber||null;
   const companyEmail=input.companyEmail===undefined?request.companyEmail:input.companyEmail||null;
   const ringCentral=await em.getRepository(ItOnboardingTask).findOneByOrFail({requestId:id,key:'RINGCENTRAL'});
   if(ringCentral.status==='COMPLETED'&&!assigned)throw new BadRequestException('A completed RingCentral task requires an assigned number.');
   const workspace=await em.getRepository(ItOnboardingTask).findOneByOrFail({requestId:id,key:'GOOGLE_WORKSPACE'});
   if(workspace.status==='COMPLETED'&&!companyEmail)throw new BadRequestException('A completed Google Workspace task requires the company email.');
   const wasVerified=!!request.workPhoneVerifiedAt;
   if(input.workPhoneVerified&&!wasVerified){request.workPhoneVerifiedAt=new Date();request.workPhoneVerifiedBy=user.id;}
   if(!input.workPhoneVerified){request.workPhoneVerifiedAt=null;request.workPhoneVerifiedBy=null;}
   request.assignedRingCentralPhoneNumber=assigned;request.companyEmail=companyEmail;request.version+=1;await em.save(request);
   await em.getRepository(ItOnboardingActivity).save({requestId:id,actorId:user.id,event:'CONTACT_VERIFICATION_UPDATED',metadata:{workPhoneVerified:input.workPhoneVerified,assignedNumberRecorded:!!assigned,companyEmailRecorded:!!companyEmail}});
   return this.detail(em,request);
  });
 }
 async task(user:User,id:string,key:string,input:TaskUpdateDto){
  this.allowIt(user);await onboardingLimit(this.db,'it-task:'+user.id,120,60);
  if(!IT_CHECKLIST.some(template=>template.key===key))throw new NotFoundException();
  if(input.status==='NOT_NEEDED'&&!isOptionalTask(key))throw new BadRequestException('Only optional tasks can be marked not needed.');
  // The new hire's "setup complete" message is queued with the completion and sent after it commits.
  let notices:string[]=[];
  const result=await this.db.transaction(async em=>{
   const request=await this.locked(em,id,input.version);
   // A request created before an optional task existed has no row for it.
   const task=await em.getRepository(ItOnboardingTask).findOneBy({requestId:id,key});if(!task)throw new NotFoundException();
   // Omitted notes keep the recorded ones; a blocked task always needs a reason, new or existing.
   const notes=input.notes??task.notes;
   if(input.status==='BLOCKED'&&!notes.trim())throw new BadRequestException('Provide a reason for a blocked task.');
   if(key==='RINGCENTRAL'&&input.status==='COMPLETED'&&!request.assignedRingCentralPhoneNumber)throw new BadRequestException('Record the actual assigned RingCentral phone number first.');
   if(key==='GOOGLE_WORKSPACE'&&input.status==='COMPLETED'&&!request.companyEmail)throw new BadRequestException('Record the company email first.');
   const previous=task.status;task.status=input.status;task.notes=notes;task.updatedBy=user.id;await em.save(task);
   await em.getRepository(ItOnboardingActivity).save({requestId:id,actorId:user.id,event:'TASK_UPDATED',metadata:{key,previousStatus:previous,newStatus:input.status}});
   const tasks=await em.getRepository(ItOnboardingTask).findBy({requestId:id});
   this.checklistComplete(tasks);
   if(tasks.every(taskDone)){
    if((request.profile.workPhoneNumber?.trim()&&!request.workPhoneVerifiedAt)||!request.assignedRingCentralPhoneNumber||!request.companyEmail)throw new BadRequestException('Record the company email and assigned RingCentral number, and verify any existing applicant-provided work phone, before completing onboarding.');
    request.completedAt=new Date();
    await em.getRepository(PortalNotification).save({recipientId:request.managerId,requestId:id,kind:'IT_ONBOARDING_COMPLETED'});
    await em.getRepository(ItOnboardingActivity).save({requestId:id,actorId:user.id,event:'IT_ONBOARDING_COMPLETED',metadata:{}});
    const application=await em.getRepository(DispatcherApplication).findOneByOrFail({id:request.applicationId});
    await em.getRepository(ApplicationActivity).save({invitationId:application.invitationId,actorId:user.id,event:'IT_ONBOARDING_COMPLETED'});
    notices=await this.alerts.queueSetupComplete(em,request);
    // The dispatcher record leaves Onboarding with the completed setup.
    await activateMember(em,request.applicationId);
   }
   request.version+=1;await em.save(request);return this.detail(em,request);
  });
  this.alerts.dispatch(notices);
  return result;
 }
  /** Open setups and removals waiting for IT (the sidebar count); same approved-application checks as the queue. */
 async openCount(user:User){
  this.allowIt(user);
  const setups=await this.db.getRepository(ItOnboardingRequest).createQueryBuilder('r')
   .innerJoin(DispatcherApplication,'a','a.id=r.applicationId AND a.status = :approved',{approved:'APPROVED'})
   .innerJoin(ApplicationReview,'v',"v.id=r.approvalId AND v.applicationId=r.applicationId AND v.decisionType='APPROVE'")
   .where('r.completedAt IS NULL AND r.cancelledAt IS NULL').getCount();
  return setups+await this.db.getRepository(ItRemovalRequest).countBy({completedAt:IsNull(),cancelledAt:IsNull()});
 }

 // ── Removal: the reverse of setup, opened when a dispatcher who had IT setup is marked as left ──
 private async removalDetail(em:EntityManager,removal:ItRemovalRequest){
  const tasks=await em.getRepository(ItRemovalTask).findBy({requestId:removal.id});
  const activity=await em.getRepository(ItRemovalActivity).find({where:{requestId:removal.id},order:{createdAt:'ASC'}});
  const [names]=await em.query(`SELECT (SELECT "firstName" || ' ' || "lastName" FROM users WHERE id = $1) AS manager, (SELECT "firstName" || ' ' || "lastName" FROM users WHERE id = $2) AS "forwardTo",
    (SELECT "leftAt" FROM dispatch_members WHERE id = $3) AS "leftAt", (SELECT "firstName" || ' ' || "lastName" FROM users WHERE id = $4) AS "recordedBy"`,[removal.managerId,removal.forwardTo,removal.memberId,removal.createdBy]);
  return {request:{...removal,status:itStatus(removal,tasks),scheduled:removalScheduled(removal,usDay('latest')),managerName:names.manager as string|null,recordedByName:names.recordedBy as string|null,forwardToName:names.forwardTo as string|null,leftAt:names.leftAt as Date|null},
   tasks:REMOVAL_CHECKLIST.flatMap(template=>{const task=tasks.find(item=>item.key===template.key);return task?[{...task,label:template.label,description:template.description,optional:!!template.optional}]:[];}),activity};
 }
 async getRemoval(user:User,id:string){
  this.allowIt(user);const removal=await this.db.getRepository(ItRemovalRequest).findOneBy({id});if(!removal)throw new NotFoundException();
  return this.removalDetail(this.db.manager,removal);
 }
 async removalTask(user:User,id:string,key:string,input:RemovalTaskDto){
  this.allowIt(user);await onboardingLimit(this.db,'it-task:'+user.id,120,60);
  const template=REMOVAL_CHECKLIST.find(item=>item.key===key);if(!template)throw new NotFoundException();
  if(input.status==='NOT_NEEDED'&&!template.optional)throw new BadRequestException('Only optional tasks can be marked not needed.');
  if(input.numberOutcome&&key!=='RINGCENTRAL')throw new BadRequestException('Only the RingCentral task records what happens to the number.');
  return this.db.transaction(async em=>{
   const removal=await em.getRepository(ItRemovalRequest).findOne({where:{id},lock:{mode:'pessimistic_write'}});if(!removal)throw new NotFoundException();
   if(removal.completedAt)throw new ConflictException('This removal is finished and cannot be changed.');
   if(removal.cancelledAt)throw new ConflictException('This removal was cancelled: the dispatcher is staying.');
   // Planning is fine while it is scheduled; nothing is removed before the last day unless a manager asked for it now.
   if(removalScheduled(removal,usDay('latest'))&&(input.status==='COMPLETED'||input.status==='NOT_NEEDED'))throw new BadRequestException('They’re still working: tasks can be marked completed from their last day.');
   if(removal.version!==input.version)throw new ConflictException('This request changed. Reload before saving.');
   const task=await em.getRepository(ItRemovalTask).findOneBy({requestId:id,key});if(!task)throw new NotFoundException();
   const notes=input.notes??task.notes;
   if(input.status==='BLOCKED'&&!notes.trim())throw new BadRequestException('Provide a reason for a blocked task.');
   if(input.numberOutcome)removal.numberOutcome=input.numberOutcome;
   if(key==='RINGCENTRAL'&&input.status==='COMPLETED'&&removal.profile.ringCentralNumber&&!removal.numberOutcome)throw new BadRequestException('Choose what happens to the RingCentral number first.');
   const previous=task.status;task.status=input.status;task.notes=notes;task.updatedBy=user.id;await em.save(task);
   await em.getRepository(ItRemovalActivity).save({requestId:id,actorId:user.id,event:'TASK_UPDATED',metadata:{key,previousStatus:previous,newStatus:input.status,...(input.numberOutcome?{numberOutcome:input.numberOutcome}:{})}});
   const tasks=await em.getRepository(ItRemovalTask).findBy({requestId:id});
   if(tasks.length===REMOVAL_CHECKLIST.length&&tasks.every(removalTaskDone)){
    removal.completedAt=new Date();
    // The manager who marked them as left learns their access is gone.
    await em.getRepository(PortalNotification).save({recipientId:removal.managerId,requestId:null,removalId:id,kind:'IT_REMOVAL_COMPLETED'});
    await em.getRepository(ItRemovalActivity).save({requestId:id,actorId:user.id,event:'IT_REMOVAL_COMPLETED',metadata:{}});
   }
   removal.version+=1;await em.save(removal);return this.removalDetail(em,removal);
  });
 }
 async unreadCount(user:User){
  if(user.status!==UserStatus.ACTIVE||![Role.SYSTEM_ADMIN,Role.DISPATCHER_MANAGER].includes(user.role))throw new ForbiddenException();
  return this.db.getRepository(PortalNotification).countBy({recipientId:user.id,readAt:IsNull()});
 }
 async notifications(user:User){
  if(user.status!==UserStatus.ACTIVE||![Role.SYSTEM_ADMIN,Role.DISPATCHER_MANAGER].includes(user.role))throw new ForbiddenException();
  // A setup notice belongs to the request's current manager; a removal notice to whoever marked the dispatcher as left.
  const result=await this.db.getRepository(PortalNotification).createQueryBuilder('n')
   .leftJoin(ItOnboardingRequest,'r','r.id=n.requestId').leftJoin(ItRemovalRequest,'m','m.id=n.removalId')
   .where('n.recipientId = :owner AND (r.managerId = :owner OR m.id IS NOT NULL)',{owner:user.id})
   .addSelect('r.applicationId','applicationId').addSelect('m.memberId','memberId').addSelect("coalesce(r.profile->>'proposedDisplayName', m.profile->>'displayName')",'displayName')
   .orderBy('n.createdAt','DESC').addOrderBy('n.id','ASC').limit(50).getRawAndEntities();
  const unread=await this.db.getRepository(PortalNotification).countBy({recipientId:user.id,readAt:IsNull()});
  return {items:result.entities.map((notification,index)=>({...notification,applicationId:result.raw[index].applicationId as string|null,memberId:result.raw[index].memberId as string|null,displayName:result.raw[index].displayName as string|null})),unread};
 }
 async readNotification(user:User,id:string){
  if(user.status!==UserStatus.ACTIVE||![Role.SYSTEM_ADMIN,Role.DISPATCHER_MANAGER].includes(user.role))throw new ForbiddenException();
  await onboardingLimit(this.db,'notification-read:'+user.id,60,60);
  const notification=await this.db.getRepository(PortalNotification).findOneBy({id,recipientId:user.id});if(!notification)throw new NotFoundException();
  if(!notification.readAt)await this.db.getRepository(PortalNotification).update(id,{readAt:new Date()});return {read:true};
 }
}
