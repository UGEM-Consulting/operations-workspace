import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { RemovalSharing } from '../dispatch/shared-accounts';
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
/**
 * What a dispatch manager can ask IT to set up for a support or updater (section 32), and the checklist tasks each one
 * adds. A RingCentral number is the same three tasks as a new dispatcher's, so IT works it in the same RingCentral section.
 */
export const SUPPORT_IT_ITEMS={COMPANY_EMAIL:['GOOGLE_WORKSPACE'],RINGCENTRAL:['RINGCENTRAL','SMS','CALL_RECORDING'],BUSINESS_SOFTWARE:['BUSINESS_SOFTWARE'],EQUIPMENT:['EQUIPMENT']} as const;
export type SupportItItem=keyof typeof SUPPORT_IT_ITEMS;
export const SUPPORT_IT_ITEM_KEYS=Object.keys(SUPPORT_IT_ITEMS) as SupportItItem[];
// REHIRE and RESTORE (section 41): bringing back someone who left. Like a support's setup they name the member, not an
// application, and hold only the tasks needed; REHIRE makes them Active when IT finishes, RESTORE follows an undone leaving.
export type SetupPurpose='DISPATCHER'|'SUPPORT'|'REHIRE'|'RESTORE';
/** A setup that names the person, not an application: a support's, or one for someone coming back. */
export const memberSetup=(request:Pick<ItOnboardingRequest,'purpose'>)=>request.purpose!=='DISPATCHER';
/** What a returning person's checklist asks IT to bring back rather than create (section 41), by task. */
export const RESTORE_TASKS:Record<string,string>={
 GOOGLE_WORKSPACE:'Restore their company email: give it a full license again and set a new password for them.',
 DISPATCH_GROUP:'Add them back to the Dispatch group.',
 RINGCENTRAL:'Enable their RingCentral user again, with the same number.',
 SMS:'Turn SMS back on for their RingCentral user.',
 CALL_RECORDING:'Turn call recording back on, inbound and outbound.',
 BUSINESS_SOFTWARE:'Give them back their business apps and load board seats. List the apps in notes; never store credentials.',
 EQUIPMENT:'Give them a laptop and headset, or mark Not needed when they use their own.',
};
/** The same for an account IT was never asked to close (someone added from a file as Left): it may still be open, or changed outside the workspace. */
export const RESTORE_UNCLOSED:Record<string,string>={
 GOOGLE_WORKSPACE:'Their email was never closed through the workspace: check it still exists and is theirs, then make sure it has a full license and set a new password for them.',
 RINGCENTRAL:'Their RingCentral user was never turned off through the workspace: check it still has this number and isn’t someone else’s, then make sure it’s enabled.',
};
/** Who is coming back, kept on their checklist's profile so IT sees it without reading the dispatcher record. */
export interface ReturningProfile {kind:'UNDO'|'REHIRE';leftOn:string|null;firstDay:string|null;emailWas:EmailDone|null;emailDeletedOn:string|null;by:string;/** Restored accounts IT was never asked to close, so IT checks them first. */notClosed?:('EMAIL'|'RINGCENTRAL')[];}
/** Completed, or Not needed for an optional task. Setup completes when every task is done. */
export function taskDone(task:Pick<ItOnboardingTask,'key'|'status'>){return task.status==='COMPLETED'||(task.status==='NOT_NEEDED'&&isOptionalTask(task.key));}
export interface ItProfile {
 legalFirstName:string|null;legalLastName:string|null;
 preferredAmericanFirstName:string|null;preferredAmericanLastName:string|null;proposedDisplayName:string|null;
 personalPhoneNumber:string|null;workPhoneNumber:string|null;personalEmail:string|null;
 mcName:string;teamLead:string;jobTitle:string;
 // A support's or updater's setup: who they assist ("Updater for Riley Santos"), shown where a dispatcher's job title would be.
 assists?:string|null;
 // Someone coming back (section 41): what IT restores and why.
 returning?:ReturningProfile;
}
@Entity('it_onboarding_requests')
export class ItOnboardingRequest {
 @PrimaryGeneratedColumn('uuid') id!:string;
 // A new dispatcher's setup (purpose DISPATCHER) comes from their approved application; a support's (SUPPORT) names their
 // dispatcher record instead, with who asked and an optional note for IT.
 @Column('varchar',{default:'DISPATCHER'}) purpose!:SetupPurpose;
 @Column('uuid',{nullable:true}) applicationId!:string|null;
 @Column('uuid',{nullable:true}) approvalId!:string|null;
 @Column('uuid',{nullable:true}) memberId!:string|null;
 @Column('uuid',{nullable:true}) requestedBy!:string|null;
 @Column('varchar',{length:1000,nullable:true}) note!:string|null;
 // Section 41: the tasks that bring an old account back rather than create one.
 @Column('text',{array:true,default:()=>"'{}'"}) restoreKeys!:string[];
 @Column('uuid') managerId!:string;
 @Column('jsonb') profile!:ItProfile;
 @Column('integer',{default:0}) version!:number;
 @Column('varchar',{nullable:true}) assignedRingCentralPhoneNumber!:string|null;
 @Column('varchar',{length:254,nullable:true}) companyEmail!:string|null;
 // Recorded during setup, and never needed to finish it. Load board fields hold a sign-in email, never a password.
 @Column('varchar',{length:6,nullable:true}) ringCentralExtension!:string|null;
 @Column('varchar',{length:254,nullable:true}) datEmail!:string|null;
 @Column('varchar',{length:254,nullable:true}) truckstopEmail!:string|null;
 // Replaced when they came back with a new one or none (section 41): kept here for IT, and no longer read as theirs.
 @Column('varchar',{length:254,nullable:true}) retiredCompanyEmail!:string|null;
 @Column('varchar',{nullable:true}) retiredRingCentralNumber!:string|null;
 @Column('varchar',{length:6,nullable:true}) retiredRingCentralExtension!:string|null;
 @Column('timestamptz',{nullable:true}) accountsRetiredAt!:Date|null;
 @Column('timestamptz',{nullable:true}) workPhoneVerifiedAt!:Date|null;
 @Column('uuid',{nullable:true}) workPhoneVerifiedBy!:string|null;
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
 @UpdateDateColumn({type:'timestamptz'}) updatedAt!:Date;
 @Column('timestamptz',{nullable:true}) completedAt!:Date|null;
 // Set when the dispatcher left before setup finished: the request leaves the queue and their removal takes over.
 @Column('timestamptz',{nullable:true}) cancelledAt!:Date|null;
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
 // A notice names a setup request (IT_ONBOARDING_COMPLETED) or a removal (IT_REMOVAL_COMPLETED), never both.
 @Column('uuid',{nullable:true}) requestId!:string|null;
 @Column('uuid',{nullable:true}) removalId!:string|null;
 // A leave's suspend or restore checklist (IT_SUSPEND_COMPLETED, IT_RESTORE_COMPLETED).
 @Column('uuid',{nullable:true}) leaveRequestId!:string|null;
 // An IT request about company accounts (IT_ACCOUNT_COMPLETED, section 33).
 @Column('uuid',{nullable:true}) accountRequestId!:string|null;
 @Column('varchar') kind!:string;
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
 @Column('timestamptz',{nullable:true}) readAt!:Date|null;
}
/**
 * The single definition of request progress, evaluated in TypeScript (itStatus) and SQL (itStatusSql):
 * COMPLETED once completedAt is set, else the first rule with any task in its statuses, else PENDING.
 */
const PROGRESS_RULES:readonly {status:RequestStatus;anyTask:readonly TaskStatus[]}[]=[
 {status:'BLOCKED',anyTask:['BLOCKED']},
 {status:'IN_PROGRESS',anyTask:TASK_STATUSES.filter(status=>status!=='PENDING')},
];
export function itStatus(request: Pick<ItOnboardingRequest,'completedAt'>, tasks:Pick<ItOnboardingTask,'status'>[]):RequestStatus {
 if(request.completedAt)return 'COMPLETED';
 return PROGRESS_RULES.find(rule=>tasks.some(task=>rule.anyTask.includes(task.status)))?.status??'PENDING';
}
/** SQL for itStatus on the request alias (a removal's tasks with tasks='it_removal_tasks'). The statuses are the constants above, never input. */
export function itStatusSql(alias:string,tasks:'it_onboarding_tasks'|'it_removal_tasks'|'it_leave_tasks'='it_onboarding_tasks'){
 return `CASE WHEN ${alias}."completedAt" IS NOT NULL THEN 'COMPLETED' ${PROGRESS_RULES.map(rule=>
  `WHEN EXISTS (SELECT 1 FROM ${tasks} t WHERE t."requestId"=${alias}.id AND t.status IN (${rule.anyTask.map(status=>`'${status}'`).join(',')})) THEN '${rule.status}'`).join(' ')} ELSE 'PENDING' END`;
}

// Removal: the reverse of setup, opened when a dispatcher who had IT setup is marked as left. Same task rules as setup.
export const REMOVAL_CHECKLIST: readonly {key:string;label:string;description:string;optional?:boolean}[] = [
 {key:'GOOGLE_WORKSPACE',label:'Google Workspace',description:'Archive, suspend or delete the account as the manager chose, and sign it out everywhere. Record what you did.'},
 {key:'DISPATCH_GROUP',label:'Dispatch group membership',description:'Remove them from the Dispatch group.'},
 {key:'RINGCENTRAL',label:'RingCentral',description:'Disable the user, with SMS and call recording (inbound and outbound) turned off. Don’t delete it: the number stays with the disabled user.'},
 {key:'BUSINESS_SOFTWARE',label:'Business software',description:'Remove their access to every business app they had, including any load board sign-ins listed here. List the apps in notes; never store credentials.'},
 {key:'SHARED_PASSWORDS',label:'Shared passwords',description:'Change any shared password they knew, such as load board or carrier portal logins.'},
 {key:'EQUIPMENT',label:'Equipment',description:'Record the laptop and headset as returned, or Not needed when they used their own.',optional:true},
];
export function removalTaskDone(task:Pick<ItRemovalTask,'key'|'status'>){return task.status==='COMPLETED'||(task.status==='NOT_NEEDED'&&REMOVAL_CHECKLIST.some(item=>item.key===task.key&&item.optional));}
// Before section 40 IT recorded what happened to the number; finished removals keep it, nothing new records it.
export const NUMBER_OUTCOMES=['KEPT','FORWARDED','RELEASED'] as const;
export type NumberOutcome=typeof NUMBER_OUTCOMES[number];
// Section 40 (approved 2026-11-23): the manager chooses what happens to the company email, IT records what it did, and a
// RingCentral user is disabled with these turned off. SUSPEND is what every earlier request meant.
export const EMAIL_ACTIONS=['ARCHIVE','SUSPEND','DELETE'] as const;
export type EmailAction=typeof EMAIL_ACTIONS[number];
export const EMAIL_DONE=['ARCHIVED','SUSPENDED','DELETED'] as const;
export type EmailDone=typeof EMAIL_DONE[number];
export const RINGCENTRAL_OFF=['USER','SMS','INBOUND_RECORDING','OUTBOUND_RECORDING'] as const;
export type RingCentralOff=typeof RINGCENTRAL_OFF[number];
/** Their email or number goes to someone staying (section 35): IT keeps it open, so there's nothing to archive or turn off. */
export function handedOver(profile:Pick<RemovalProfile,'shared'>,kind:'EMAIL'|'RINGCENTRAL'){return !!profile.shared?.handOverToId&&profile.shared.usedBy.some(item=>item.kind===kind);}
/** A step opened again for an account IT wasn't told about: what IT recorded was for the others, so it records again. */
export function forgetDone(removal:Pick<ItRemovalRequest,'emailDone'|'ringCentralOff'>,steps:string[]){
 let changed=false;
 if(steps.includes('GOOGLE_WORKSPACE')&&removal.emailDone){removal.emailDone=null;changed=true;}
 if(steps.includes('RINGCENTRAL')&&removal.ringCentralOff.length){removal.ringCentralOff=[];changed=true;}
 return changed;
}
/** What IT removes, copied from the setup request and the dispatcher record when they left. */
export interface RemovalProfile {displayName:string;position?:string;companyEmail:string|null;ringCentralNumber:string|null;mcName:string|null;teamName:string|null;setUpAt:string|null;noSetupRecord?:boolean;suspendedOnLeave?:boolean;ringCentralExtension?:string|null;datEmail?:string|null;truckstopEmail?:string|null;seats?:RemovalSeat[];companyAccounts?:RemovalCompanyAccount[];shared?:RemovalSharing;}
/** An account at another of our companies, as IT's removal lists it (section 33). */
export interface RemovalCompanyAccount {id:string;company:string;nameUsed:string|null;companyEmail:string|null;ringCentralNumber:string|null;ringCentralExtension:string|null;status:string;keptFor:string[];}
/** A load board seat as IT's removal lists it (section 33). */
export interface RemovalSeat {id:string;account:string;provider:string;signInEmail:string;status:string;sharedWith:string[];}
@Entity('it_removal_requests')
export class ItRemovalRequest {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') memberId!:string;
 // The setup this reverses; empty for someone recorded by hand, who never had one here.
 @Column('uuid',{nullable:true}) setupRequestId!:string|null;
 // Who gets the portal notice and, when chosen, new email: whoever marked them as left, or who took over from them.
 @Column('uuid') managerId!:string;
 // Who marked them as left; never changes.
 @Column('uuid') createdBy!:string;
 @Column('jsonb') profile!:RemovalProfile;
 @Column('varchar') emailAfter!:'FORWARD'|'SUSPEND';
 @Column('uuid',{nullable:true}) forwardTo!:string|null;
 @Column('varchar',{default:'SUSPEND'}) emailAction!:EmailAction;
 @Column('varchar',{nullable:true}) emailDone!:EmailDone|null;
 @Column('text',{array:true,default:()=>"'{}'"}) ringCentralOff!:RingCentralOff[];
 @Column('date') dueOn!:string;
 @Column('varchar',{nullable:true}) numberOutcome!:NumberOutcome|null;
 @Column('integer',{default:0}) version!:number;
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
 @UpdateDateColumn({type:'timestamptz'}) updatedAt!:Date;
 @Column('timestamptz',{nullable:true}) completedAt!:Date|null;
 // A manager asked to remove access before the last day: due today, tasks can be completed at once.
 @Column('timestamptz',{nullable:true}) removeNowAt!:Date|null;
 @Column('text',{nullable:true}) removeNowReason!:string|null;
 // A short note for IT from whoever asked to close the accounts of someone added as Left (never passwords).
 @Column('varchar',{length:500,nullable:true}) note!:string|null;
 // When IT got the alert that the removal is due; empty while it is scheduled.
 @Column('timestamptz',{nullable:true}) dueAlertedAt!:Date|null;
 // The notice was cancelled before IT started. Kept for the history; out of every list.
 @Column('timestamptz',{nullable:true}) cancelledAt!:Date|null;
 // A finished removal undone or reversed by a rehire (section 41): cancelledAt too, so a later leaving opens a new one, but IT keeps it as finished.
 @Column('timestamptz',{nullable:true}) reversedAt!:Date|null;
}
/** Scheduled until the last day has begun (the Eastern date reaches it) or access must go now: IT plans, but can't mark tasks completed. */
export function removalScheduled(removal:Pick<ItRemovalRequest,'dueOn'|'removeNowAt'|'completedAt'>,today:string){return !removal.completedAt&&!removal.removeNowAt&&removal.dueOn>today;}
@Entity('it_removal_tasks')
export class ItRemovalTask {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') requestId!:string;
 @Column('varchar') key!:string;
 @Column('varchar') status!:TaskStatus;
 @Column('text',{default:''}) notes!:string;
 @Column('uuid',{nullable:true}) updatedBy!:string|null;
 @UpdateDateColumn({type:'timestamptz'}) updatedAt!:Date;
}
@Entity('it_removal_activity')
export class ItRemovalActivity {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') requestId!:string;
 @Column('uuid') actorId!:string;
 @Column('varchar') event!:string;
 @Column('jsonb',{default:{}}) metadata!:Record<string,string|boolean|null>;
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
}

// Leave (section 35): IT suspends a person's accounts while they're away and restores them when they're back. Only the
// accounts they have get a task; business software may be Not needed when they use shared sign-ins only.
export const LEAVE_CHECKLIST: readonly {key:string;label:string;suspend:string;restore:string;optional?:boolean}[] = [
 {key:'GOOGLE_WORKSPACE',label:'Google Workspace',suspend:'Suspend the account and sign it out everywhere, then forward new email or set the auto-reply as asked. Keep the mailbox.',restore:'Restore the account and remove the forwarding or auto-reply.'},
 {key:'RINGCENTRAL',label:'RingCentral',suspend:'Forward calls and texts, or send them to voicemail, as asked. Keep the user and the number.',restore:'Stop forwarding calls and texts.'},
 {key:'BUSINESS_SOFTWARE',label:'Business software',suspend:'Sign them out of business apps they use alone. Shared sign-ins stay as they are. Never store credentials in notes.',restore:'Give back the app access you signed out.',optional:true},
];
export type LeaveKind='SUSPEND'|'RESTORE';
export interface LeaveProfile {displayName:string;position:string;companyEmail:string|null;ringCentralNumber:string|null;mcName:string|null;teamName:string|null;firstDay:string;backOn:string;emailWhileAway:'FORWARD'|'AUTO_REPLY'|null;callsWhileAway:'FORWARD'|'VOICEMAIL'|null;forwardToName:string|null;datEmail:string|null;truckstopEmail:string|null;teamLead?:boolean;}
export function leaveTaskDone(task:Pick<ItLeaveTask,'key'|'status'>){return task.status==='COMPLETED'||(task.status==='NOT_NEEDED'&&LEAVE_CHECKLIST.some(item=>item.key===task.key&&item.optional));}
@Entity('it_leave_requests')
export class ItLeaveRequest {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') leaveId!:string;
 @Column('uuid') memberId!:string;
 @Column('varchar') kind!:LeaveKind;
 // Who recorded the leave: they get the portal notice when IT finishes.
 @Column('uuid') managerId!:string;
 @Column('jsonb') profile!:LeaveProfile;
 // Suspending can be completed from the first day away; restoring is due on the return day.
 @Column('date') dueOn!:string;
 @Column('integer',{default:0}) version!:number;
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
 @UpdateDateColumn({type:'timestamptz'}) updatedAt!:Date;
 @Column('timestamptz',{nullable:true}) completedAt!:Date|null;
 @Column('timestamptz',{nullable:true}) cancelledAt!:Date|null;
}
@Entity('it_leave_tasks')
export class ItLeaveTask {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') requestId!:string;
 @Column('varchar') key!:string;
 @Column('varchar') status!:TaskStatus;
 @Column('text',{default:''}) notes!:string;
 @Column('uuid',{nullable:true}) updatedBy!:string|null;
 @UpdateDateColumn({type:'timestamptz'}) updatedAt!:Date;
}
@Entity('it_leave_activity')
export class ItLeaveActivity {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') requestId!:string;
 @Column('uuid',{nullable:true}) actorId!:string|null;
 @Column('varchar') event!:string;
 @Column('jsonb',{default:{}}) metadata!:Record<string,string|boolean|null>;
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
}
