export interface Invitation { id: string; email: string | null; expectedEmail: string | null; consumedAt: string | null; mcName: string | null; teamLead: string | null; jobTitle: string | null; telegramRequired: boolean; status: string; expiresAt: string; createdAt: string; }
export interface Fields { firstName?: string; lastName?: string; personalPhoneNumber?: string; workPhoneNumber?: string; preferredAmericanFirstName?: string; preferredAmericanLastName?: string; telegram?: string; mcName?: string; teamLead?: string; jobTitle?: string; }
export interface Application { id: string; invitationId: string; status: ApplicationStatus; fields: Fields; version: number; updatedAt: string; submittedAt: string | null; }
export const applicationStatuses = ['INVITED','DRAFT','SUBMITTED','CHANGES_REQUESTED','RESUBMITTED','APPROVED','REJECTED'] as const;
export type ApplicationStatus = typeof applicationStatuses[number];
export type FieldName = keyof Fields;
export const fieldLabels: Record<FieldName,string> = { firstName:'First Name',lastName:'Last Name',preferredAmericanFirstName:'American First Name',preferredAmericanLastName:'American Last Name',personalPhoneNumber:'Personal Phone Number',workPhoneNumber:'Work Phone Number',telegram:'Telegram username/tag',mcName:'MC name / Independent',teamLead:'Team lead name / Independent',jobTitle:'Job title' };
export interface ApplicantRecord { application: Application; invitation: Invitation; canEdit: boolean; editableFields: FieldName[]; correction: { id:string;reason:string;requestedFields:FieldName[];createdAt:string } | null; accessUntil: string; }
export interface Review { id:string;reviewer:{id:string;firstName:string;lastName:string};decisionType:'APPROVE'|'REQUEST_CHANGES'|'REJECT';reason:string|null;requestedFields:FieldName[];previousStatus:ApplicationStatus;newStatus:ApplicationStatus;createdAt:string;employment:{mcName:string;teamLead:string;jobTitle:string}|null;previousEmployment:{mcName?:string;teamLead?:string;jobTitle?:string}|null; }
export interface ReviewDetail { application:Application;invitation:Invitation;reviews:Review[];submissions:{id:string;version:number;fields:Fields;createdAt:string}[];activity:{id:string;event:string;createdAt:string}[];canReview:boolean;readyForIt:boolean;itOnboarding:{id:string;status:string;completedAt:string|null}|null;requiredFields:FieldName[];itDetails:{legalFirstName:string|null;legalLastName:string|null;preferredAmericanFirstName:string|null;preferredAmericanLastName:string|null;proposedDisplayName:string|null;personalPhoneNumber:string|null;workPhoneNumber:string|null}; }
export interface ApplicationList { items:(Application & {email:string;mcName:string;teamLead:string})[];total:number;page:number;pageSize:number;pageCount:number; }
export interface ReviewSummary { awaitingReview:number;changesRequested:number;resubmitted:number;approved:number;rejected:number; }
export { inputClass } from '@/components/ui/field';
export async function readApi<T>(path: string): Promise<T> {
 const response = await fetch(`/api/backend/${path}`, { cache: 'no-store' });
 if (!response.ok) throw new Error(response.status === 401 ? 'Please verify your access again.' : 'Unable to load this information. Please try again.');
 return response.json() as Promise<T>;
}
