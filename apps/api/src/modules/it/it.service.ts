import { sharedSignIns } from '../dispatch/account-details';
import { ItAccountRequest } from '../company-accounts/account-requests.entity';
import { endSeatsOnLeaving, removalSeats, syncRecordedSeats } from '../load-boards/seats';
import { companyEmailSql } from '../dispatch/lead-sign-in';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { activateMember } from '../dispatch/create-member';
import { DispatchMember } from '../dispatch/dispatch.entity';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { ApplicationActivity, ApplicationReview, DispatcherApplication } from '../onboarding/entities';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { onboardingLimit } from '../onboarding/rate-limit';
import { photoFor } from '../documents/requirements';
import { Role, User, UserStatus } from '../users/user.entity';
import { ItContactDto, ItQueueDto, ItTasksDto, RemovalTaskDto, TaskUpdateDto } from './it.dto';
import { usDay } from '../safety/screening-rules';
import { NotificationsService } from '../updates/notifications.service';
import { ItLeaveActivity, ItLeaveRequest, ItLeaveTask, LEAVE_CHECKLIST, leaveTaskDone } from './it.entity';
import { IT_CHECKLIST, isOptionalTask, ItOnboardingActivity, ItOnboardingRequest, ItOnboardingTask, ItRemovalActivity, ItRemovalRequest, ItRemovalTask, itStatus, itStatusSql, PortalNotification, REMOVAL_CHECKLIST, removalScheduled, removalTaskDone, taskDone } from './it.entity';

const statusSql=itStatusSql('r');
// Setups (approved, not cancelled) and removals as one list for IT tasks; each row's progress uses the shared rule.
const SETUP_AND_REMOVAL_ROWS=`SELECT 'SETUP' AS kind, r.id, r.profile->>'proposedDisplayName' AS name, r.profile->>'personalEmail' AS email, r.profile->>'mcName' AS mc,
  ${itStatusSql('r')} AS status, (SELECT count(*) FROM it_onboarding_tasks t WHERE t."requestId" = r.id AND t.status IN ('COMPLETED','NOT_NEEDED'))::integer AS done,
  (SELECT count(*) FROM it_onboarding_tasks t WHERE t."requestId" = r.id)::integer AS total, NULL::text AS "dueOn", NULL::timestamptz AS "removeNowAt", r."createdAt", r."updatedAt", r."completedAt",
  NULL::text AS "signIn", r."memberId", NULL::text AS team, r.profile->>'assists' AS assists
 FROM it_onboarding_requests r LEFT JOIN dispatcher_applications a ON a.id = r."applicationId" AND a.status = 'APPROVED'
 LEFT JOIN application_reviews v ON v.id = r."approvalId" AND v."applicationId" = r."applicationId" AND v."decisionType" = 'APPROVE'
 WHERE r."cancelledAt" IS NULL AND (r.purpose = 'SUPPORT' OR (a.id IS NOT NULL AND v.id IS NOT NULL))
 UNION ALL
 SELECT 'REMOVAL', m.id, m.profile->>'displayName', m.profile->>'companyEmail', m.profile->>'mcName', ${itStatusSql('m','it_removal_tasks')},
  (SELECT count(*) FROM it_removal_tasks t WHERE t."requestId" = m.id AND t.status IN ('COMPLETED','NOT_NEEDED'))::integer,
  (SELECT count(*) FROM it_removal_tasks t WHERE t."requestId" = m.id)::integer, m."dueOn"::text, m."removeNowAt", m."createdAt", m."updatedAt", m."completedAt", NULL, NULL, NULL, NULL
 FROM it_removal_requests m WHERE m."cancelledAt" IS NULL`;
// A team lead's sign-in: one step, so done is 0 or 1 of 1. The email is the one they sign in with: their account's, else the company email on record.
const SIGN_IN_ROWS=`SELECT 'SIGN_IN', s.id, d."firstName" || ' ' || d."lastName", coalesce(u.email, ${companyEmailSql()}),
  mc.name, CASE WHEN s."doneAt" IS NULL THEN 'PENDING' ELSE 'COMPLETED' END, CASE WHEN s."doneAt" IS NULL THEN 0 ELSE 1 END, 1, NULL, NULL, s."createdAt", coalesce(s."doneAt", s."createdAt"), s."doneAt", s.kind, d.id, t.name, NULL
 FROM team_lead_sign_ins s JOIN dispatch_members d ON d.id = s."memberId" LEFT JOIN users u ON u.id = d."accountUserId" LEFT JOIN existing_member_records e ON e."memberId" = d.id
 LEFT JOIN member_assignments a ON a."memberId" = d.id AND a."endedAt" IS NULL LEFT JOIN teams t ON t.id = a."teamId" LEFT JOIN mcs mc ON mc.id = a."mcId" WHERE s."cancelledAt" IS NULL`;
// Leave (section 35): suspending someone's accounts while they're away, and restoring them. Their own kinds, SUSPEND and RESTORE.
const LEAVE_ROWS=`SELECT q.kind, q.id, q.profile->>'displayName', q.profile->>'companyEmail', q.profile->>'mcName', ${itStatusSql('q','it_leave_tasks')},
  (SELECT count(*) FROM it_leave_tasks t WHERE t."requestId" = q.id AND t.status IN ('COMPLETED','NOT_NEEDED'))::integer,
  (SELECT count(*) FROM it_leave_tasks t WHERE t."requestId" = q.id)::integer, q."dueOn"::text, NULL::timestamptz, q."createdAt", q."updatedAt", q."completedAt", NULL, q."memberId", q.profile->>'teamName', NULL
 FROM it_leave_requests q WHERE q."cancelledAt" IS NULL`;
// Company accounts (section 33): CLOSE_ACCOUNT for one account, MOVE_ACCOUNTS for a move's new accounts.
const ACCOUNT_ROWS=`SELECT CASE WHEN q.kind = 'CLOSE' THEN 'CLOSE_ACCOUNT' ELSE 'MOVE_ACCOUNTS' END, q.id, q.profile->>'displayName', NULL, coalesce(q.profile->>'toMc', q.profile->>'fromMc'),
  CASE WHEN q."completedAt" IS NOT NULL THEN 'COMPLETED' WHEN EXISTS (SELECT 1 FROM it_account_tasks t WHERE t."requestId" = q.id AND t.status = 'BLOCKED') THEN 'BLOCKED' WHEN EXISTS (SELECT 1 FROM it_account_tasks t WHERE t."requestId" = q.id AND t.status IN ('IN_PROGRESS','COMPLETED')) THEN 'IN_PROGRESS' ELSE 'PENDING' END,
  (SELECT count(*) FROM it_account_tasks t WHERE t."requestId" = q.id AND t.status = 'COMPLETED')::integer,
  (SELECT count(*) FROM it_account_tasks t WHERE t."requestId" = q.id)::integer, NULL, NULL::timestamptz, q."createdAt", q."updatedAt", q."completedAt", NULL, q."memberId", NULL, NULL
 FROM it_account_requests q WHERE q."cancelledAt" IS NULL`;
const taskRows=(signIns:boolean,leave:boolean,accounts=false)=>[SETUP_AND_REMOVAL_ROWS,...(signIns?[SIGN_IN_ROWS]:[]),...(leave?[LEAVE_ROWS]:[]),...(accounts?[ACCOUNT_ROWS]:[])].join(' UNION ALL ');
// Not due yet: the Eastern date (the given parameter) hasn't reached the last day and nobody asked to remove access now.
const scheduledSql=(today:string)=>`(kind = 'REMOVAL' AND "completedAt" IS NULL AND "removeNowAt" IS NULL AND "dueOn"::date > ${today}::date)`;
const SCHEDULED=scheduledSql('$2');
const VIEW_SQL:Record<ItTasksDto['view'],string>={open:`status <> 'COMPLETED'`,setup:`kind = 'SETUP' AND status <> 'COMPLETED'`,signin:`kind = 'SIGN_IN' AND status <> 'COMPLETED'`,leave:`kind IN ('SUSPEND','RESTORE') AND status <> 'COMPLETED'`,accounts:`kind IN ('CLOSE_ACCOUNT','MOVE_ACCOUNTS') AND status <> 'COMPLETED'`,removal:`kind = 'REMOVAL' AND status <> 'COMPLETED' AND NOT ${SCHEDULED}`,scheduled:SCHEDULED,finished:`status = 'COMPLETED'`,all:'true'};
/**
 * IT access requires the approved application and the APPROVE review a new dispatcher's request was created from. A
 * support's setup needs their dispatcher record, and returns their approved application when they came through onboarding
 * (for the profile photo), else null.
 */
export async function approvedApplication(em:EntityManager,request:ItOnboardingRequest):Promise<DispatcherApplication|null>{
 if(request.purpose==='SUPPORT'){
  const member=await em.getRepository(DispatchMember).findOneBy({id:request.memberId!});if(!member)throw new NotFoundException();
  return member.applicationId?em.getRepository(DispatcherApplication).findOneBy({id:member.applicationId,status:'APPROVED'}):null;
 }
 const app=await em.getRepository(DispatcherApplication).findOneBy({id:request.applicationId!,status:'APPROVED'});
 const approval=await em.getRepository(ApplicationReview).findOneBy({id:request.approvalId!,applicationId:request.applicationId!,decisionType:'APPROVE'});
 if(!app||!approval)throw new NotFoundException();return app;
}
@Injectable()
export class ItService {
 constructor(private readonly db:DataSource,private readonly alerts:NotificationsService,private readonly config:ConfigService){}
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
  // A support's setup names who asked: joined to the tasks (every request has some), so a task save runs no extra query.
  const loaded=await em.getRepository(ItOnboardingTask).createQueryBuilder('t').leftJoin(User,'u','u.id = :asker',{asker:request.requestedBy})
   .addSelect(`u."firstName" || ' ' || u."lastName"`,'asker').where('t.requestId = :id',{id:request.id}).getRawAndEntities();
  const tasks=loaded.entities;
  this.checklistComplete(request,tasks);
  const activity=await em.getRepository(ItOnboardingActivity).find({where:{requestId:request.id},order:{createdAt:'ASC'}});
  // This projection deliberately excludes application revisions, applicant sessions and reviewer comments.
  // IT sees only whether a profile photo (the plain selfie) exists; never the ID selfie.
  const application=await approvedApplication(em,request);
  const profilePhoto=!!application&&!!await photoFor(em,application.id,'SELFIE',application.submittedAt);
  return {request:{...request,status:itStatus(request,tasks),profilePhoto,requestedByName:(loaded.raw[0]?.asker as string|null|undefined)??null},tasks:IT_CHECKLIST.flatMap(template=>{const task=tasks.find(item=>item.key===template.key);return task?[{...task,label:template.label,description:template.description,optional:!!template.optional}]:[];}),activity};
 }
  // Every required task must exist on a new dispatcher's setup. An optional task added later is missing only on requests created
 // before it existed. A support's setup has only the tasks a manager asked for.
 private checklistComplete(request:Pick<ItOnboardingRequest,'purpose'>,tasks:Pick<ItOnboardingTask,'key'>[]){
  if(request.purpose==='SUPPORT'?!tasks.length:IT_CHECKLIST.some(template=>!template.optional&&!tasks.some(task=>task.key===template.key)))throw new ConflictException('The checklist is incomplete. Contact an administrator.');
 }
 /**
  * IT tasks: setups and removals together. Removals that are due come first, the earliest first, then setups by most
  * recently updated, with scheduled removals last. Counts for each view and the stat cards cover every task.
  */
 async tasks(user:User,input:ItTasksDto){
  this.allowIt(user);
  const search=input.search?'%'+input.search.replace(/[\\%_]/g,'\\$&')+'%':'';
  const today=usDay('latest');
  const taskSql=taskRows(input.signIns==='1',input.leave==='1',input.accounts==='1');
  const where=`(${VIEW_SQL[input.view]}) AND ($1 = '' OR concat(name,' ',email,' ',mc) ILIKE $1)`;
  const [rows,[count],[stats]]=await Promise.all([
   this.db.query(`WITH rows AS (${taskSql}) SELECT *, ${SCHEDULED} AS scheduled FROM rows WHERE ${where}
    ORDER BY (kind = 'REMOVAL' AND "completedAt" IS NULL AND NOT ${SCHEDULED}) DESC, ${SCHEDULED} ASC, "dueOn" ASC NULLS LAST, "updatedAt" DESC, id LIMIT $3 OFFSET $4`,[search,today,input.pageSize,(input.page-1)*input.pageSize]),
   this.db.query(`WITH rows AS (${taskSql}) SELECT count(*)::integer AS total FROM rows WHERE ${where} AND $2::date IS NOT NULL`,[search,today]),
   this.db.query(`WITH rows AS (${taskSql}) SELECT
     count(*) FILTER (WHERE status <> 'COMPLETED')::integer AS open, count(*) FILTER (WHERE kind = 'SETUP' AND status <> 'COMPLETED')::integer AS setup,
     count(*) FILTER (WHERE kind = 'REMOVAL' AND status <> 'COMPLETED' AND NOT ${scheduledSql('$1')})::integer AS removal, count(*) FILTER (WHERE ${scheduledSql('$1')})::integer AS scheduled, min("dueOn") FILTER (WHERE ${scheduledSql('$1')}) AS "nextScheduled",
     count(*) FILTER (WHERE status = 'COMPLETED')::integer AS finished, count(*)::integer AS "all",
     count(*) FILTER (WHERE kind = 'REMOVAL' AND status <> 'COMPLETED' AND NOT ${scheduledSql('$1')})::integer AS "removalsDue",
     count(*) FILTER (WHERE kind = 'SETUP' AND status = 'PENDING')::integer AS "setupsWaiting", count(*) FILTER (WHERE status = 'BLOCKED')::integer AS blocked, count(*) FILTER (WHERE kind = 'SIGN_IN' AND status <> 'COMPLETED')::integer AS "signIns", count(*) FILTER (WHERE kind IN ('SUSPEND','RESTORE') AND status <> 'COMPLETED')::integer AS leave, count(*) FILTER (WHERE kind IN ('CLOSE_ACCOUNT','MOVE_ACCOUNTS') AND status <> 'COMPLETED')::integer AS accounts,
     count(*) FILTER (WHERE status = 'COMPLETED' AND "completedAt" >= date_trunc('month', now()))::integer AS "finishedThisMonth" FROM rows`,[today]),
  ]);
  return {items:rows,total:count.total,page:input.page,pageSize:input.pageSize,pageCount:Math.ceil(count.total/input.pageSize),stats};
 }
 async get(user:User,id:string){this.allowIt(user);const request=await this.db.getRepository(ItOnboardingRequest).findOneBy({id});if(!request)throw new NotFoundException();await approvedApplication(this.db.manager,request);return this.detail(this.db.manager,request);}
 private async locked(em:EntityManager,id:string,version:number){
  const request=await em.getRepository(ItOnboardingRequest).findOne({where:{id},lock:{mode:'pessimistic_write'}});
  if(!request)throw new NotFoundException();await approvedApplication(em,request);
  if(request.completedAt)throw new ConflictException('This onboarding request is completed and cannot be changed.');
  if(request.cancelledAt)throw new ConflictException(`This setup was cancelled because the ${request.purpose==='SUPPORT'?'person':'dispatcher'} left. Their accounts are on the removal checklist.`);
  if(request.version!==version)throw new ConflictException('This request changed. Reload before saving.');return request;
 }
 async contact(user:User,id:string,input:ItContactDto){
  this.allowIt(user);await onboardingLimit(this.db,'it-contact:'+user.id,60,60);
  const fictionalOnly=!(this.config.get('NODE_ENV')==='production'||this.config.get('DEPLOYMENT_PURPOSE')==='production');
  if(fictionalOnly&&[input.companyEmail,input.datEmail,input.truckstopEmail].some(email=>email&&!email.endsWith('@example.test')))throw new BadRequestException('Outside production, emails must be fictional example.test addresses.');
  return this.db.transaction(async em=>{
   const request=await this.locked(em,id,input.version);
   if(input.workPhoneVerified&&(!request.profile.workPhoneNumber||!INTERNATIONAL_PHONE_PATTERN.test(request.profile.workPhoneNumber.trim())))throw new BadRequestException('The applicant work phone must be valid before IT can verify it.');
   const assigned=input.assignedRingCentralPhoneNumber===undefined?request.assignedRingCentralPhoneNumber:input.assignedRingCentralPhoneNumber||null;
   const companyEmail=input.companyEmail===undefined?request.companyEmail:input.companyEmail||null;
   const ringCentral=await em.getRepository(ItOnboardingTask).findOneBy({requestId:id,key:'RINGCENTRAL'});
   if(ringCentral?.status==='COMPLETED'&&!assigned)throw new BadRequestException('A completed RingCentral task requires an assigned number.');
   const workspace=await em.getRepository(ItOnboardingTask).findOneBy({requestId:id,key:'GOOGLE_WORKSPACE'});
   if(workspace?.status==='COMPLETED'&&!companyEmail)throw new BadRequestException('A completed Google Workspace task requires the company email.');
   const wasVerified=!!request.workPhoneVerifiedAt;
   if(input.workPhoneVerified&&!wasVerified){request.workPhoneVerifiedAt=new Date();request.workPhoneVerifiedBy=user.id;}
   if(!input.workPhoneVerified){request.workPhoneVerifiedAt=null;request.workPhoneVerifiedBy=null;}
   request.assignedRingCentralPhoneNumber=assigned;request.companyEmail=companyEmail;
   if(input.ringCentralExtension!==undefined)request.ringCentralExtension=input.ringCentralExtension||null;
   if(input.datEmail!==undefined)request.datEmail=input.datEmail||null;
   if(input.truckstopEmail!==undefined)request.truckstopEmail=input.truckstopEmail||null;
   request.version+=1;await em.save(request);
   // A load board sign-in IT records becomes a seat until IT moves it to its real account (section 33).
   if(input.datEmail!==undefined||input.truckstopEmail!==undefined){const [member]=await em.query(`SELECT id FROM dispatch_members WHERE id = $1 OR "applicationId" = $2 LIMIT 1`,[request.memberId,request.applicationId]);if(member)await syncRecordedSeats(em,member.id,user.id);}
   await em.getRepository(ItOnboardingActivity).save({requestId:id,actorId:user.id,event:'CONTACT_VERIFICATION_UPDATED',metadata:{workPhoneVerified:input.workPhoneVerified,assignedNumberRecorded:!!assigned,companyEmailRecorded:!!companyEmail,extensionRecorded:!!request.ringCentralExtension,datRecorded:!!request.datEmail,truckstopRecorded:!!request.truckstopEmail}});
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
   this.checklistComplete(request,tasks);
   if(tasks.every(taskDone)&&request.purpose==='SUPPORT'){
    // A support's setup needs a number or company email only when that was asked for. The manager who asked gets a notice; the person isn't messaged.
    if(tasks.some(item=>item.key==='RINGCENTRAL')&&!request.assignedRingCentralPhoneNumber||tasks.some(item=>item.key==='GOOGLE_WORKSPACE')&&!request.companyEmail)
     throw new BadRequestException('Record the company email and RingCentral number that were asked for before finishing setup.');
    request.completedAt=new Date();
    await em.getRepository(PortalNotification).save({recipientId:request.managerId,requestId:id,kind:'IT_ONBOARDING_COMPLETED'});
    await em.getRepository(ItOnboardingActivity).save({requestId:id,actorId:user.id,event:'IT_ONBOARDING_COMPLETED',metadata:{}});
   }else if(tasks.every(taskDone)){
    if((request.profile.workPhoneNumber?.trim()&&!request.workPhoneVerifiedAt)||!request.assignedRingCentralPhoneNumber||!request.companyEmail)throw new BadRequestException('Record the company email and assigned RingCentral number, and verify any existing applicant-provided work phone, before completing onboarding.');
    request.completedAt=new Date();
    await em.getRepository(PortalNotification).save({recipientId:request.managerId,requestId:id,kind:'IT_ONBOARDING_COMPLETED'});
    await em.getRepository(ItOnboardingActivity).save({requestId:id,actorId:user.id,event:'IT_ONBOARDING_COMPLETED',metadata:{}});
    const application=await em.getRepository(DispatcherApplication).findOneByOrFail({id:request.applicationId!});
    await em.getRepository(ApplicationActivity).save({invitationId:application.invitationId,actorId:user.id,event:'IT_ONBOARDING_COMPLETED'});
    notices=await this.alerts.queueSetupComplete(em,{id:request.id,applicationId:request.applicationId!});
    // The dispatcher record leaves Onboarding with the completed setup.
    await activateMember(em,request.applicationId!);
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
   .leftJoin(DispatcherApplication,'a','a.id=r.applicationId AND a.status = :approved',{approved:'APPROVED'})
   .leftJoin(ApplicationReview,'v',"v.id=r.approvalId AND v.applicationId=r.applicationId AND v.decisionType='APPROVE'")
   .where("r.completedAt IS NULL AND r.cancelledAt IS NULL AND (r.purpose = 'SUPPORT' OR (a.id IS NOT NULL AND v.id IS NOT NULL))").getCount();
  const [{signIns}]=await this.db.query(`SELECT count(*)::integer AS "signIns" FROM team_lead_sign_ins WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL`);
  const leave=await this.db.getRepository(ItLeaveRequest).countBy({completedAt:IsNull(),cancelledAt:IsNull()});
  const accounts=await this.db.getRepository(ItAccountRequest).countBy({completedAt:IsNull(),cancelledAt:IsNull()});
  return setups+signIns+leave+accounts+await this.db.getRepository(ItRemovalRequest).countBy({completedAt:IsNull(),cancelledAt:IsNull()});
 }

 // ── Removal: the reverse of setup, opened when a dispatcher who had IT setup is marked as left ──
 private async removalDetail(em:EntityManager,removal:ItRemovalRequest){
  const tasks=await em.getRepository(ItRemovalTask).findBy({requestId:removal.id});
  const activity=await em.getRepository(ItRemovalActivity).find({where:{requestId:removal.id},order:{createdAt:'ASC'}});
  const [names]=await em.query(`SELECT (SELECT "firstName" || ' ' || "lastName" FROM users WHERE id = $1) AS manager, (SELECT "firstName" || ' ' || "lastName" FROM users WHERE id = $2) AS "forwardTo",
    (SELECT d."leftAt" FROM dispatch_members d LEFT JOIN existing_member_records e ON e."memberId" = d.id WHERE d.id = $3 AND coalesce(e."leftDateKnown", true)) AS "leftAt", (SELECT "firstName" || ' ' || "lastName" FROM users WHERE id = $4) AS "recordedBy"`,[removal.managerId,removal.forwardTo,removal.memberId,removal.createdBy]);
  // Anyone else using these sign-ins: IT changes the password rather than closing an account someone still needs.
  const shared=await sharedSignIns(em,removal.memberId,{dat:removal.profile.datEmail??null,truckstop:removal.profile.truckstopEmail??null});
  // Their load board seats: live while IT works on it (who shares each sign-in now), as they were once it's finished.
  const seats=removal.completedAt?((removal.profile as unknown as {seats?:unknown[]}).seats??[]):await removalSeats(em,removal.memberId);
  return {sharedSignIns:shared,seats,request:{...removal,status:itStatus(removal,tasks),scheduled:removalScheduled(removal,usDay('latest')),managerName:names.manager as string|null,recordedByName:names.recordedBy as string|null,forwardToName:names.forwardTo as string|null,leftAt:names.leftAt as Date|null},
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
   if(tasks.length>0&&tasks.every(removalTaskDone)){
    removal.completedAt=new Date();
    // Their access is gone: their load board seats end, kept as history.
    await endSeatsOnLeaving(em,removal.memberId,user.id);
    // The manager who marked them as left learns their access is gone.
    await em.getRepository(PortalNotification).save({recipientId:removal.managerId,requestId:null,removalId:id,kind:'IT_REMOVAL_COMPLETED'});
    await em.getRepository(ItRemovalActivity).save({requestId:id,actorId:user.id,event:'IT_REMOVAL_COMPLETED',metadata:{}});
   }
   removal.version+=1;await em.save(removal);return this.removalDetail(em,removal);
  });
 }
 // ── Leave (section 35): suspending someone's accounts while they're away, and restoring them ──
 private async leaveDetail(em:EntityManager,request:ItLeaveRequest){
  const tasks=await em.getRepository(ItLeaveTask).findBy({requestId:request.id});
  const activity=await em.getRepository(ItLeaveActivity).find({where:{requestId:request.id},order:{createdAt:'ASC'}});
  const [names]=await em.query(`SELECT (SELECT "firstName" || ' ' || "lastName" FROM users WHERE id = $1) AS manager, (SELECT "leftAt" IS NOT NULL FROM dispatch_members WHERE id = $2) AS left,
   (SELECT "endedHow" FROM member_leaves WHERE id = $3) AS "leaveEnded"`,[request.managerId,request.memberId,request.leaveId]);
  const shared=await sharedSignIns(em,request.memberId,{dat:request.profile.datEmail??null,truckstop:request.profile.truckstopEmail??null});
  // A restore says who suspended (the last suspend task IT completed) and whether a lead's sign-in waits in Sign-ins (ItRestoreScreen).
  const [suspended]=request.kind==='RESTORE'?await em.query(`SELECT u."firstName" || ' ' || u."lastName" AS by, t."updatedAt" AS at FROM it_leave_tasks t JOIN it_leave_requests r ON r.id = t."requestId" AND r.kind = 'SUSPEND' AND r."leaveId" = $1
    LEFT JOIN users u ON u.id = t."updatedBy" WHERE t.status = 'COMPLETED' ORDER BY t."updatedAt" DESC LIMIT 1`,[request.leaveId]):[];
  const [signIn]=request.kind==='RESTORE'&&request.profile.teamLead?await em.query(`SELECT kind FROM team_lead_sign_ins WHERE "memberId" = $1 AND "doneAt" IS NULL AND "cancelledAt" IS NULL LIMIT 1`,[request.memberId]):[];
  return {sharedSignIns:shared,request:{...request,status:itStatus(request,tasks),scheduled:this.leaveScheduled(request),managerName:names.manager as string|null,suspended:suspended?{by:suspended.by as string|null,at:new Date(suspended.at).toISOString()}:null,signInWaiting:!!signIn,leaveEnded:names.leaveEnded as string|null},
   tasks:LEAVE_CHECKLIST.flatMap(template=>{const task=tasks.find(item=>item.key===template.key);return task?[{...task,label:template.label,description:request.kind==='SUSPEND'?template.suspend:template.restore,optional:!!template.optional}]:[];}),activity};
 }
 /** Suspending waits for the first day away: IT plans before then, but nothing is suspended while they're still working. */
 private leaveScheduled(request:Pick<ItLeaveRequest,'kind'|'dueOn'|'completedAt'>){return request.kind==='SUSPEND'&&!request.completedAt&&request.dueOn>usDay('latest');}
 async getLeave(user:User,id:string){
  this.allowIt(user);const request=await this.db.getRepository(ItLeaveRequest).findOneBy({id});if(!request)throw new NotFoundException();
  return this.leaveDetail(this.db.manager,request);
 }
 async leaveTask(user:User,id:string,key:string,input:TaskUpdateDto){
  this.allowIt(user);await onboardingLimit(this.db,'it-task:'+user.id,120,60);
  const template=LEAVE_CHECKLIST.find(item=>item.key===key);if(!template)throw new NotFoundException();
  if(input.status==='NOT_NEEDED'&&!template.optional)throw new BadRequestException('Only business software can be marked not needed.');
  return this.db.transaction(async em=>{
   const request=await em.getRepository(ItLeaveRequest).findOne({where:{id},lock:{mode:'pessimistic_write'}});if(!request)throw new NotFoundException();
   if(request.completedAt)throw new ConflictException('This checklist is finished and cannot be changed.');
   if(request.cancelledAt)throw new ConflictException('This checklist was stopped: their leave ended before it was finished.');
   if(this.leaveScheduled(request)&&(input.status==='COMPLETED'||input.status==='NOT_NEEDED'))throw new BadRequestException('They’re still working: tasks can be marked completed from their first day away.');
   if(request.version!==input.version)throw new ConflictException('This request changed. Reload before saving.');
   const task=await em.getRepository(ItLeaveTask).findOneBy({requestId:id,key});if(!task)throw new NotFoundException();
   const notes=input.notes??task.notes;
   if(input.status==='BLOCKED'&&!notes.trim())throw new BadRequestException('Provide a reason for a blocked task.');
   const previous=task.status;task.status=input.status;task.notes=notes;task.updatedBy=user.id;await em.save(task);
   await em.getRepository(ItLeaveActivity).save({requestId:id,actorId:user.id,event:'TASK_UPDATED',metadata:{key,previousStatus:previous,newStatus:input.status}});
   const tasks=await em.getRepository(ItLeaveTask).findBy({requestId:id});
   if(tasks.length>0&&tasks.every(leaveTaskDone)){
    request.completedAt=new Date();
    // Whoever recorded the leave learns IT is done; the person on leave is never messaged.
    await em.getRepository(PortalNotification).save({recipientId:request.managerId,requestId:null,removalId:null,leaveRequestId:id,kind:request.kind==='SUSPEND'?'IT_SUSPEND_COMPLETED':'IT_RESTORE_COMPLETED'});
    await em.getRepository(ItLeaveActivity).save({requestId:id,actorId:user.id,event:request.kind==='SUSPEND'?'IT_SUSPEND_COMPLETED':'IT_RESTORE_COMPLETED',metadata:{}});
   }
   request.version+=1;await em.save(request);return this.leaveDetail(em,request);
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
   .leftJoin(ItOnboardingRequest,'r','r.id=n.requestId').leftJoin(ItRemovalRequest,'m','m.id=n.removalId').leftJoin(ItLeaveRequest,'l','l.id=n.leaveRequestId').leftJoin(ItAccountRequest,'q','q.id=n.accountRequestId')
   .where('n.recipientId = :owner AND (r.managerId = :owner OR m.id IS NOT NULL OR l.id IS NOT NULL OR q.id IS NOT NULL)',{owner:user.id})
   .addSelect('r.applicationId','applicationId').addSelect('coalesce(m.memberId, r.memberId, l.memberId, q.memberId)','memberId').addSelect("coalesce(r.profile->>'proposedDisplayName', m.profile->>'displayName', l.profile->>'displayName', q.profile->>'displayName')",'displayName')
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
