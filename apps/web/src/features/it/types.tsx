export const taskStatuses=['PENDING','IN_PROGRESS','BLOCKED','COMPLETED'] as const;
export type TaskStatus=typeof taskStatuses[number];
// Not needed is a task outcome for optional tasks only; request progress never uses it.
export const taskOutcomes=[...taskStatuses,'NOT_NEEDED'] as const;
export type TaskOutcome=typeof taskOutcomes[number];
export interface ItProfile {legalFirstName:string|null;legalLastName:string|null;preferredAmericanFirstName:string|null;preferredAmericanLastName:string|null;proposedDisplayName:string|null;personalPhoneNumber:string|null;workPhoneNumber:string|null;personalEmail:string|null;mcName:string;teamLead:string;jobTitle:string;}
export interface ItRequest {id:string;applicationId:string;profile:ItProfile;version:number;status:TaskStatus;assignedRingCentralPhoneNumber:string|null;companyEmail:string|null;profilePhoto?:boolean;workPhoneVerifiedAt:string|null;completedAt:string|null;cancelledAt?:string|null;updatedAt:string;}
export interface ItTask {id:string;key:string;label:string;description:string;optional:boolean;status:TaskOutcome;notes:string;updatedAt:string;}
export function taskDone(task:Pick<ItTask,'status'>){return task.status==='COMPLETED'||task.status==='NOT_NEEDED';}
export interface ItDetail {request:ItRequest;tasks:ItTask[];activity:{id:string;event:string;createdAt:string;metadata:Record<string,string|boolean|null>}[];}
export interface ItQueue {items:ItRequest[];total:number;page:number;pageCount:number;pageSize:number;}
// A notice is IT_ONBOARDING_COMPLETED (an application) or IT_REMOVAL_COMPLETED (a dispatcher who left); an older API sends only the first, without kind.
export interface Notifications {items:{id:string;kind?:string;requestId:string|null;applicationId:string|null;memberId?:string|null;displayName:string|null;createdAt:string;readAt:string|null}[];unread:number;}
export type ItTasks=import('zod').infer<typeof import('@/lib/api-schemas').itTasksSchema>;
export interface RemovalProfile {displayName:string;companyEmail:string|null;ringCentralNumber:string|null;mcName:string|null;teamName:string|null;setUpAt:string|null;}
export type NumberOutcome='KEPT'|'FORWARDED'|'RELEASED';
export interface RemovalRequest {id:string;memberId:string;version:number;status:TaskStatus;scheduled:boolean;removeNowAt:string|null;cancelledAt:string|null;dueOn:string;emailAfter:'FORWARD'|'SUSPEND';forwardToName:string|null;managerName:string|null;recordedByName?:string|null;leftAt:string|null;numberOutcome:NumberOutcome|null;profile:RemovalProfile;completedAt:string|null;}
export interface RemovalDetail {request:RemovalRequest;tasks:ItTask[];activity:ItDetail['activity'];}

