import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { ApplicationActivity, ApplicationReview, DispatcherApplication } from '../onboarding/entities';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { onboardingLimit } from '../onboarding/rate-limit';
import { photoFor } from '../documents/requirements';
import { Role, User, UserStatus } from '../users/user.entity';
import { ItContactDto, ItQueueDto, TaskUpdateDto } from './it.dto';
import { IT_CHECKLIST, isOptionalTask, ItOnboardingActivity, ItOnboardingRequest, ItOnboardingTask, itStatus, itStatusSql, PortalNotification, taskDone } from './it.entity';

const statusSql=itStatusSql('r');
/** IT access requires the approved application and the APPROVE review the request was created from. */
export async function approvedApplication(em:EntityManager,request:ItOnboardingRequest){
 const app=await em.getRepository(DispatcherApplication).findOneBy({id:request.applicationId,status:'APPROVED'});
 const approval=await em.getRepository(ApplicationReview).findOneBy({id:request.approvalId,applicationId:request.applicationId,decisionType:'APPROVE'});
 if(!app||!approval)throw new NotFoundException();return app;
}
@Injectable()
export class ItService {
 constructor(private readonly db:DataSource){}
 private allowIt(user:User){if(user.status!==UserStatus.ACTIVE||![Role.SYSTEM_ADMIN,Role.IT_SPECIALIST].includes(user.role))throw new ForbiddenException();}
 async queue(user:User,input:ItQueueDto){
  this.allowIt(user);
  const query=this.db.getRepository(ItOnboardingRequest).createQueryBuilder('r')
   .innerJoin(DispatcherApplication,'a','a.id=r.applicationId AND a.status = :approved',{approved:'APPROVED'})
   .innerJoin(ApplicationReview,'v',"v.id=r.approvalId AND v.applicationId=r.applicationId AND v.decisionType='APPROVE'");
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
 async get(user:User,id:string){this.allowIt(user);const request=await this.db.getRepository(ItOnboardingRequest).findOneBy({id});if(!request)throw new NotFoundException();await approvedApplication(this.db.manager,request);return this.detail(this.db.manager,request);}
 private async locked(em:EntityManager,id:string,version:number){
  const request=await em.getRepository(ItOnboardingRequest).findOne({where:{id},lock:{mode:'pessimistic_write'}});
  if(!request)throw new NotFoundException();await approvedApplication(em,request);
  if(request.completedAt)throw new ConflictException('This onboarding request is completed and cannot be changed.');
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
  return this.db.transaction(async em=>{
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
   }
   request.version+=1;await em.save(request);return this.detail(em,request);
  });
 }
 /** Open requests waiting for IT (the sidebar count); same approved-application checks as the queue. */
 async openCount(user:User){
  this.allowIt(user);
  return this.db.getRepository(ItOnboardingRequest).createQueryBuilder('r')
   .innerJoin(DispatcherApplication,'a','a.id=r.applicationId AND a.status = :approved',{approved:'APPROVED'})
   .innerJoin(ApplicationReview,'v',"v.id=r.approvalId AND v.applicationId=r.applicationId AND v.decisionType='APPROVE'")
   .where('r.completedAt IS NULL').getCount();
 }
 async unreadCount(user:User){
  if(user.status!==UserStatus.ACTIVE||![Role.SYSTEM_ADMIN,Role.DISPATCHER_MANAGER].includes(user.role))throw new ForbiddenException();
  return this.db.getRepository(PortalNotification).countBy({recipientId:user.id,readAt:IsNull()});
 }
 async notifications(user:User){
  if(user.status!==UserStatus.ACTIVE||![Role.SYSTEM_ADMIN,Role.DISPATCHER_MANAGER].includes(user.role))throw new ForbiddenException();
  const result=await this.db.getRepository(PortalNotification).createQueryBuilder('n').innerJoin(ItOnboardingRequest,'r','r.id=n.requestId AND r.managerId = :owner',{owner:user.id})
   .where('n.recipientId = :owner',{owner:user.id}).addSelect('r.applicationId','applicationId').addSelect("r.profile->>'proposedDisplayName'",'displayName')
   .orderBy('n.createdAt','DESC').addOrderBy('n.id','ASC').limit(50).getRawAndEntities();
  const unread=await this.db.getRepository(PortalNotification).countBy({recipientId:user.id,readAt:IsNull()});
  return {items:result.entities.map((notification,index)=>({...notification,applicationId:result.raw[index].applicationId as string,displayName:result.raw[index].displayName as string|null})),unread};
 }
 async readNotification(user:User,id:string){
  if(user.status!==UserStatus.ACTIVE||![Role.SYSTEM_ADMIN,Role.DISPATCHER_MANAGER].includes(user.role))throw new ForbiddenException();
  await onboardingLimit(this.db,'notification-read:'+user.id,60,60);
  const notification=await this.db.getRepository(PortalNotification).findOneBy({id,recipientId:user.id});if(!notification)throw new NotFoundException();
  if(!notification.readAt)await this.db.getRepository(PortalNotification).update(id,{readAt:new Date()});return {read:true};
 }
}
