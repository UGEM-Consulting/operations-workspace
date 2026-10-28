import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
// Request progress is derived from its tasks. NOT_NEEDED is a task outcome for optional tasks only.
export const REQUEST_STATUSES = ['PENDING','IN_PROGRESS','BLOCKED','COMPLETED'] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];
export const TASK_STATUSES = [...REQUEST_STATUSES,'NOT_NEEDED'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const IT_CHECKLIST: readonly {key:string;label:string;description:string;optional?:boolean}[] = [
 {key:'GOOGLE_WORKSPACE',label:'Google Workspace',description:'Create the Workspace account using the American display name and record the company email.'},
 {key:'DISPATCH_GROUP',label:'Dispatch group membership',description:'Confirm membership in the approved Dispatch group.'},
 {key:'RINGCENTRAL',label:'RingCentral',description:'Confirm setup and record the actual assigned RingCentral phone number separately.'},
 {key:'SMS',label:'SMS',description:'Confirm approved RingCentral SMS capability and settings.'},
 {key:'CALL_RECORDING',label:'Call recording',description:'Confirm the company-approved RingCentral recording configuration.'},
 {key:'BUSINESS_SOFTWARE',label:'Approved business software',description:'Confirm only the business software authorized for this dispatcher. List the software in notes; never store credentials.'},
 {key:'EQUIPMENT',label:'Equipment',description:'Confirm the headset and laptop are ready, or mark Not needed when the dispatcher uses their own.',optional:true},
];
export function isOptionalTask(key:string){return IT_CHECKLIST.some(task=>task.key===key&&task.optional);}
/** Completed, or Not needed for an optional task. Setup completes when every task is done. */
export function taskDone(task:Pick<ItOnboardingTask,'key'|'status'>){return task.status==='COMPLETED'||(task.status==='NOT_NEEDED'&&isOptionalTask(task.key));}
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
 @Column('varchar',{length:254,nullable:true}) companyEmail!:string|null;
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
export function itStatus(request: Pick<ItOnboardingRequest,'completedAt'>, tasks:Pick<ItOnboardingTask,'status'>[]):RequestStatus {
 if(request.completedAt)return 'COMPLETED';
 if(tasks.some(task=>task.status==='BLOCKED'))return 'BLOCKED';
 return tasks.some(task=>task.status!=='PENDING')?'IN_PROGRESS':'PENDING';
}
