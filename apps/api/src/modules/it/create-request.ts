import { EntityManager } from 'typeorm';
import { ApplicationActivity, ApplicationReview, ApplicationFields, DispatcherApplication, Invitation, EmploymentAssignments } from '../onboarding/entities';
import { provisioningDetails } from '../onboarding/application-requirements';
import { IT_CHECKLIST, ItOnboardingActivity, ItOnboardingRequest, ItOnboardingTask } from './it.entity';
// Called only inside the approval transaction, or the promotion transaction of a support approved earlier (who then
// passes the employment confirmed for the promotion). Unique constraints enforce one request/checklist per application.
// actorId is who caused the request now: the approving reviewer, or the promotion's decider (not the original approver).
export async function createItRequest(em:EntityManager,application:DispatcherApplication,approval:ApplicationReview,fields:ApplicationFields,invitation:Invitation,actorId:string,employment:EmploymentAssignments|null=approval.employment) {
 if(application.status!=='APPROVED'||approval.decisionType!=='APPROVE'||!employment)throw new Error('Approved employment is required for IT onboarding');
 const request=await em.getRepository(ItOnboardingRequest).save({applicationId:application.id,approvalId:approval.id,managerId:application.assignedManagerId,
  profile:{...provisioningDetails(fields),personalEmail:invitation.email,...employment},version:0});
 await em.getRepository(ItOnboardingTask).save(IT_CHECKLIST.map(task=>({requestId:request.id,key:task.key,status:'PENDING' as const,notes:''})));
 await em.getRepository(ItOnboardingActivity).save({requestId:request.id,actorId,event:'IT_REQUEST_CREATED',metadata:{}});
 await em.getRepository(ApplicationActivity).save({invitationId:invitation.id,actorId,event:'IT_REQUEST_CREATED'});
 return request;
}
