import { StatusBadge, statusLabel, type StatusTone } from '@/components/ui/status-badge';
export const taskStatuses=['PENDING','IN_PROGRESS','BLOCKED','COMPLETED'] as const;
export type TaskStatus=typeof taskStatuses[number];
// Not needed is a task outcome for optional tasks only; request progress never uses it.
export const taskOutcomes=[...taskStatuses,'NOT_NEEDED'] as const;
export type TaskOutcome=typeof taskOutcomes[number];
export interface ItProfile {legalFirstName:string|null;legalLastName:string|null;preferredAmericanFirstName:string|null;preferredAmericanLastName:string|null;proposedDisplayName:string|null;personalPhoneNumber:string|null;workPhoneNumber:string|null;personalEmail:string|null;mcName:string;teamLead:string;jobTitle:string;}
export interface ItRequest {id:string;applicationId:string;profile:ItProfile;version:number;status:TaskStatus;assignedRingCentralPhoneNumber:string|null;companyEmail:string|null;profilePhoto?:boolean;workPhoneVerifiedAt:string|null;completedAt:string|null;updatedAt:string;}
export interface ItTask {id:string;key:string;label:string;description:string;optional:boolean;status:TaskOutcome;notes:string;updatedAt:string;}
export function taskDone(task:Pick<ItTask,'status'>){return task.status==='COMPLETED'||task.status==='NOT_NEEDED';}
export interface ItDetail {request:ItRequest;tasks:ItTask[];activity:{id:string;event:string;createdAt:string;metadata:Record<string,string|boolean|null>}[];}
export interface ItQueue {items:ItRequest[];total:number;page:number;pageCount:number;pageSize:number;}
export interface Notifications {items:{id:string;requestId:string;applicationId:string;displayName:string|null;createdAt:string;readAt:string|null}[];unread:number;}
const tones: Record<TaskOutcome, StatusTone> = { PENDING:'neutral', IN_PROGRESS:'info', BLOCKED:'warning', COMPLETED:'success', NOT_NEEDED:'neutral' };
export function ProgressBadge({status}:{status:TaskOutcome}) { return <StatusBadge label={statusLabel(status)} tone={tones[status]} />; }
