import { StatusBadge, statusLabel, type StatusTone } from '@/components/ui/status-badge';
export const taskStatuses=['PENDING','IN_PROGRESS','BLOCKED','COMPLETED'] as const;
export type TaskStatus=typeof taskStatuses[number];
export interface ItProfile {legalFirstName:string|null;legalLastName:string|null;preferredAmericanFirstName:string|null;preferredAmericanLastName:string|null;proposedDisplayName:string|null;personalPhoneNumber:string|null;workPhoneNumber:string|null;personalEmail:string|null;mcName:string;teamLead:string;jobTitle:string;}
export interface ItRequest {id:string;applicationId:string;profile:ItProfile;version:number;status:TaskStatus;assignedRingCentralPhoneNumber:string|null;workPhoneVerifiedAt:string|null;completedAt:string|null;updatedAt:string;}
export interface ItTask {id:string;key:string;label:string;description:string;status:TaskStatus;notes:string;updatedAt:string;}
export interface ItDetail {request:ItRequest;tasks:ItTask[];activity:{id:string;event:string;createdAt:string;metadata:Record<string,string|boolean|null>}[];}
export interface ItQueue {items:ItRequest[];total:number;page:number;pageCount:number;pageSize:number;}
export interface Notifications {items:{id:string;requestId:string;applicationId:string;displayName:string|null;createdAt:string;readAt:string|null}[];unread:number;}
const tones: Record<TaskStatus, StatusTone> = { PENDING:'neutral', IN_PROGRESS:'info', BLOCKED:'warning', COMPLETED:'success' };
export function ProgressBadge({status}:{status:TaskStatus}) { return <StatusBadge label={statusLabel(status)} tone={tones[status]} />; }
