import { EntityManager } from 'typeorm';
import { ApplicationActivity, ApplicationReview, ApplicationFields, DispatcherApplication, Invitation } from '../onboarding/entities';
import { provisioningDetails } from '../onboarding/application-requirements';
import { IT_CHECKLIST, ItOnboardingActivity, ItOnboardingRequest, ItOnboardingTask } from './it.entity';
// Called only inside the approval transaction. Unique constraints enforce one request/checklist.
export async function createItRequest(em:EntityManager,application:DispatcherApplication,approval:ApplicationReview,fields:ApplicationFields,invitation:Invitation) {
 if(application.status!=='APPROVED'||approval.decisionType!=='APPROVE'||!approval.employment)throw new Error('Approved employment is required for IT onboarding');
 const request=await em.getRepository(ItOnboardingRequest).save({applicationId:application.id,approvalId:approval.id,managerId:application.assignedManagerId,
  profile:{...provisioningDetails(fields),personalEmail:invitation.email,...approval.employment},version:0});
 await em.getRepository(ItOnboardingTask).save(IT_CHECKLIST.map(task=>({requestId:request.id,key:task.key,status:'PENDING' as const,notes:''})));
 await em.getRepository(ItOnboardingActivity).save({requestId:request.id,actorId:approval.reviewerId,event:'IT_REQUEST_CREATED',metadata:{}});
 await em.getRepository(ApplicationActivity).save({invitationId:invitation.id,actorId:approval.reviewerId,event:'IT_REQUEST_CREATED'});
 return request;
}
