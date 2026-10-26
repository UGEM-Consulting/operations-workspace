import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { ApplicationActivity, ApplicationReview, DispatcherApplication } from '../onboarding/entities';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { onboardingLimit } from '../onboarding/rate-limit';
import { photoFor } from '../documents/requirements';
import { Role, User, UserStatus } from '../users/user.entity';
import { ItContactDto, ItQueueDto, TaskUpdateDto } from './it.dto';
import { IT_CHECKLIST, ItOnboardingActivity, ItOnboardingRequest, ItOnboardingTask, itStatus, PortalNotification } from './it.entity';

const statusSql=`CASE WHEN r."completedAt" IS NOT NULL THEN 'COMPLETED'
 WHEN EXISTS (SELECT 1 FROM it_onboarding_tasks t WHERE t."requestId"=r.id AND t.status='BLOCKED') THEN 'BLOCKED'
 WHEN EXISTS (SELECT 1 FROM it_onboarding_tasks t WHERE t."requestId"=r.id AND t.status<>'PENDING') THEN 'IN_PROGRESS' ELSE 'PENDING' END`;
@Injectable()
export class ItService {
 constructor(private readonly db:DataSource){}
 private allowIt(user:User){if(user.status!==UserStatus.ACTIVE||![Role.SYSTEM_ADMIN,Role.IT_SPECIALIST].includes(user.role))throw new ForbiddenException();}
 private async approved(em:EntityManager,request:ItOnboardingRequest){
  const app=await em.getRepository(DispatcherApplication).findOneBy({id:request.applicationId,status:'APPROVED'});
  const approval=await em.getRepository(ApplicationReview).findOneBy({id:request.approvalId,applicationId:request.applicationId,decisionType:'APPROVE'});
  if(!app||!approval)throw new NotFoundException();return app;
 }
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
  if(tasks.length!==IT_CHECKLIST.length)throw new ConflictException('The checklist is incomplete. Contact an administrator.');
  const activity=await em.getRepository(ItOnboardingActivity).find({where:{requestId:request.id},order:{createdAt:'ASC'}});
  // This projection deliberately excludes application revisions, applicant sessions and reviewer comments.
  // IT sees only whether a profile photo (the plain selfie) exists; never the ID selfie.
  const application=await em.getRepository(DispatcherApplication).findOneByOrFail({id:request.applicationId});
  const profilePhoto=!!await photoFor(em,application.id,'SELFIE',application.submittedAt);
  return {request:{...request,status:itStatus(request,tasks),profilePhoto},tasks:IT_CHECKLIST.map(template=>({...tasks.find(task=>task.key===template.key)!,label:template.label,description:template.description})),activity};
 }
 async get(user:User,id:string){this.allowIt(user);const request=await this.db.getRepository(ItOnboardingRequest).findOneBy({id});if(!request)throw new NotFoundException();await this.approved(this.db.manager,request);return this.detail(this.db.manager,request);}
 private async locked(em:EntityManager,id:string,version:number){
  const request=await em.getRepository(ItOnboardingRequest).findOne({where:{id},lock:{mode:'pessimistic_write'}});
  if(!request)throw new NotFoundException();await this.approved(em,request);
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
  if(input.status==='BLOCKED'&&!input.notes.trim())throw new BadRequestException('Provide a reason for a blocked task.');
  return this.db.transaction(async em=>{
   const request=await this.locked(em,id,input.version);
   const task=await em.getRepository(ItOnboardingTask).findOneByOrFail({requestId:id,key});
   if(key==='RINGCENTRAL'&&input.status==='COMPLETED'&&!request.assignedRingCentralPhoneNumber)throw new BadRequestException('Record the actual assigned RingCentral phone number first.');
   if(key==='GOOGLE_WORKSPACE'&&input.status==='COMPLETED'&&!request.companyEmail)throw new BadRequestException('Record the company email first.');
   const previous=task.status;task.status=input.status;task.notes=input.notes;task.updatedBy=user.id;await em.save(task);
   await em.getRepository(ItOnboardingActivity).save({requestId:id,actorId:user.id,event:'TASK_UPDATED',metadata:{key,previousStatus:previous,newStatus:input.status}});
   const tasks=await em.getRepository(ItOnboardingTask).findBy({requestId:id});
   if(tasks.length!==IT_CHECKLIST.length)throw new ConflictException('The checklist is incomplete. Contact an administrator.');
   if(tasks.every(item=>item.status==='COMPLETED')){
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
