import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
export const TASK_STATUSES = ['PENDING','IN_PROGRESS','BLOCKED','COMPLETED'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const IT_CHECKLIST = [
 {key:'GOOGLE_WORKSPACE',label:'Google Workspace',description:'Manually record completion of the approved Workspace account setup using the American display name.'},
 {key:'DISPATCH_GROUP',label:'Dispatch group membership',description:'Confirm membership in the approved Dispatch group.'},
 {key:'RINGCENTRAL',label:'RingCentral',description:'Confirm setup and record the actual assigned RingCentral phone number separately.'},
 {key:'SMS',label:'SMS',description:'Confirm approved RingCentral SMS capability and settings.'},
 {key:'CALL_RECORDING',label:'Call recording',description:'Confirm the company-approved RingCentral recording configuration.'},
 {key:'BUSINESS_SOFTWARE',label:'Approved business software',description:'Confirm only the business software authorized for this dispatcher. Use notes for fictional software names; never store credentials.'},
] as const;
export interface ItProfile {
 legalFirstName:string|null;legalLastName:string|null;
 preferredAmericanFirstName:string|null;preferredAmericanLastName:string|null;proposedDisplayName:string|null;
 personalPhoneNumber:string|null;workPhoneNumber:string|null;personalEmail:string|null;
 mcName:string;teamLead:string;jobTitle:string;
}
@Entity('it_onboarding_requests')
export class ItOnboardingRequest {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') applicationId!:string;
 @Column('uuid') approvalId!:string;
 @Column('uuid') managerId!:string;
 @Column('jsonb') profile!:ItProfile;
 @Column('integer',{default:0}) version!:number;
 @Column('varchar',{nullable:true}) assignedRingCentralPhoneNumber!:string|null;
 @Column('timestamptz',{nullable:true}) workPhoneVerifiedAt!:Date|null;
 @Column('uuid',{nullable:true}) workPhoneVerifiedBy!:string|null;
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
 @UpdateDateColumn({type:'timestamptz'}) updatedAt!:Date;
 @Column('timestamptz',{nullable:true}) completedAt!:Date|null;
}
@Entity('it_onboarding_tasks')
export class ItOnboardingTask {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') requestId!:string;
 @Column('varchar') key!:string;
 @Column('varchar') status!:TaskStatus;
 @Column('text',{default:''}) notes!:string;
 @Column('uuid',{nullable:true}) updatedBy!:string|null;
 @UpdateDateColumn({type:'timestamptz'}) updatedAt!:Date;
}
@Entity('it_onboarding_activity')
export class ItOnboardingActivity {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') requestId!:string;
 @Column('uuid') actorId!:string;
 @Column('varchar') event!:string;
 @Column('jsonb',{default:{}}) metadata!:Record<string,string|boolean|null>;
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
}
@Entity('portal_notifications')
export class PortalNotification {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') recipientId!:string;
 @Column('uuid') requestId!:string;
 @Column('varchar') kind!:string;
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
 @Column('timestamptz',{nullable:true}) readAt!:Date|null;
}
export function itStatus(request: Pick<ItOnboardingRequest,'completedAt'>, tasks:Pick<ItOnboardingTask,'status'>[]):TaskStatus {
 if(request.completedAt)return 'COMPLETED';
 if(tasks.some(task=>task.status==='BLOCKED'))return 'BLOCKED';
 return tasks.some(task=>task.status!=='PENDING')?'IN_PROGRESS':'PENDING';
}
