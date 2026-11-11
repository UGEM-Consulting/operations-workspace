export const taskStatuses=['PENDING','IN_PROGRESS','BLOCKED','COMPLETED'] as const;
export type TaskStatus=typeof taskStatuses[number];
// Not needed is a task outcome for optional tasks only; request progress never uses it.
export const taskOutcomes=[...taskStatuses,'NOT_NEEDED'] as const;
export type TaskOutcome=typeof taskOutcomes[number];
export interface ItProfile {assists?:string|null;legalFirstName:string|null;legalLastName:string|null;preferredAmericanFirstName:string|null;preferredAmericanLastName:string|null;proposedDisplayName:string|null;personalPhoneNumber:string|null;workPhoneNumber:string|null;personalEmail:string|null;mcName:string;teamLead:string;jobTitle:string;}
// purpose SUPPORT: a support's or updater's setup (section 32), with only the tasks asked for, who asked and their note.
export interface ItRequest {id:string;applicationId:string|null;purpose?:'DISPATCHER'|'SUPPORT';note?:string|null;requestedByName?:string|null;profile:ItProfile;version:number;status:TaskStatus;assignedRingCentralPhoneNumber:string|null;companyEmail:string|null;ringCentralExtension?:string|null;datEmail?:string|null;truckstopEmail?:string|null;profilePhoto?:boolean;workPhoneVerifiedAt:string|null;completedAt:string|null;cancelledAt?:string|null;updatedAt:string;}
export interface ItTask {id:string;key:string;label:string;description:string;optional:boolean;status:TaskOutcome;notes:string;updatedAt:string;}
export function taskDone(task:Pick<ItTask,'status'>){return task.status==='COMPLETED'||task.status==='NOT_NEEDED';}
export interface ItDetail {request:ItRequest;tasks:ItTask[];activity:{id:string;event:string;createdAt:string;metadata:Record<string,string|boolean|null>}[];}
export interface ItQueue {items:ItRequest[];total:number;page:number;pageCount:number;pageSize:number;}
// A notice is IT_ONBOARDING_COMPLETED (an application) or IT_REMOVAL_COMPLETED (a dispatcher who left); an older API sends only the first, without kind.
export interface Notifications {items:{id:string;kind?:string;requestId:string|null;applicationId:string|null;memberId?:string|null;displayName:string|null;createdAt:string;readAt:string|null}[];unread:number;}
/**
 * What a notice says and where it goes, shared by the bell and the dashboard. A support's or updater's setup (section 32)
 * names no application, so it opens their page and doesn't say they're ready to work: nothing changed about their work.
 */
export function notificationView(item:Notifications['items'][number]){
 const name=item.displayName;
 // Leave (section 35): IT suspended or restored the accounts of someone on leave.
 if(item.kind==='IT_SUSPEND_COMPLETED')return {title:'Access suspended',text:name?`IT suspended ${name}’s accounts while they’re away.`:'IT suspended their accounts while they’re away.',href:item.memberId?`/dispatch/dispatchers/${item.memberId}`:null,link:'View their page'};
 if(item.kind==='IT_RESTORE_COMPLETED')return {title:'Access restored',text:name?`IT restored ${name}’s accounts.`:'IT restored their accounts.',href:item.memberId?`/dispatch/dispatchers/${item.memberId}`:null,link:'View their page'};
 if(item.kind==='IT_REMOVAL_COMPLETED')return {title:'IT access removed',text:`IT removed ${name??'the dispatcher'}’s accounts.`,href:item.memberId?`/dispatch/dispatchers/${item.memberId}`:null,link:'View dispatcher'};
 if(!item.applicationId)return {title:'IT setup completed',text:`IT finished what you asked for ${name??'them'}.`,href:item.memberId?`/dispatch/dispatchers/${item.memberId}`:null,link:'View their page'};
 return {title:'IT setup completed',text:`${name??'Dispatcher'} is ready to work.`,href:`/onboarding/applications/${item.applicationId}`,link:'View application'};
}
export type ItTasks=import('zod').infer<typeof import('@/lib/api-schemas').itTasksSchema>;
export interface RemovalProfile {displayName:string;position?:string;companyEmail:string|null;ringCentralNumber:string|null;mcName:string|null;teamName:string|null;setUpAt:string|null;noSetupRecord?:boolean;suspendedOnLeave?:boolean;ringCentralExtension?:string|null;datEmail?:string|null;truckstopEmail?:string|null;}
export type NumberOutcome='KEPT'|'FORWARDED'|'RELEASED';
export interface RemovalRequest {id:string;memberId:string;version:number;status:TaskStatus;scheduled:boolean;removeNowAt:string|null;cancelledAt:string|null;dueOn:string;emailAfter:'FORWARD'|'SUSPEND';forwardToName:string|null;managerName:string|null;recordedByName?:string|null;leftAt:string|null;numberOutcome:NumberOutcome|null;profile:RemovalProfile;completedAt:string|null;}
/** Leave (section 35): suspending accounts while someone is away (SUSPEND), and restoring them (RESTORE). */
export interface LeaveProfile {displayName:string;position:string;companyEmail:string|null;ringCentralNumber:string|null;mcName:string|null;teamName:string|null;firstDay:string;backOn:string;emailWhileAway:'FORWARD'|'AUTO_REPLY'|null;callsWhileAway:'FORWARD'|'VOICEMAIL'|null;forwardToName:string|null;datEmail:string|null;truckstopEmail:string|null;teamLead?:boolean;}
export interface LeaveRequest {id:string;memberId:string;kind:'SUSPEND'|'RESTORE';version:number;status:TaskStatus;scheduled:boolean;dueOn:string;completedAt:string|null;cancelledAt:string|null;managerName:string|null;profile:LeaveProfile;suspended?:{by:string|null;at:string}|null;signInWaiting?:boolean;leaveEnded?:'RETURNED'|'CANCELLED'|'LEAVING'|null;}
export interface LeaveDetail {request:LeaveRequest;tasks:ItTask[];activity:ItDetail['activity'];sharedSignIns?:{dat:{id:string;name:string}[];truckstop:{id:string;name:string}[]};}
export interface RemovalDetail {request:RemovalRequest;tasks:ItTask[];activity:ItDetail['activity'];sharedSignIns?:{dat:{id:string;name:string}[];truckstop:{id:string;name:string}[]};}

