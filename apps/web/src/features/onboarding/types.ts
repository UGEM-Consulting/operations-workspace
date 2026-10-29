export interface Invitation { id: string; email: string | null; expectedEmail: string | null; consumedAt: string | null; mcName: string | null; teamLead: string | null; jobTitle: string | null; telegramRequired: boolean; status: string; expiresAt: string; createdAt: string; }
export interface Fields { firstName?: string; lastName?: string; personalPhoneNumber?: string; workPhoneNumber?: string; preferredAmericanFirstName?: string; preferredAmericanLastName?: string; telegram?: string; mcName?: string; teamLead?: string; jobTitle?: string; }
export interface Application { id: string; invitationId: string; status: ApplicationStatus; fields: Fields; version: number; updatedAt: string; submittedAt: string | null; }
export const applicationStatuses = ['INVITED','DRAFT','SUBMITTED','CHANGES_REQUESTED','RESUBMITTED','APPROVED','REJECTED'] as const;
export type ApplicationStatus = typeof applicationStatuses[number];
export type FieldName = keyof Fields;
export const fieldLabels: Record<FieldName,string> = { firstName:'First name',lastName:'Last name',preferredAmericanFirstName:'American first name',preferredAmericanLastName:'American last name',personalPhoneNumber:'Personal phone number',workPhoneNumber:'Work phone number',telegram:'Telegram username',mcName:'MC name / Independent',teamLead:'Team lead name / Independent',jobTitle:'Job title' };
// Photos and signatures are not answer fields, but managers can request them in a correction.
export type DocumentItem = 'selfiePhoto'|'idPhoto'|'documents';
export type RequestableItem = FieldName | DocumentItem;
export const documentItemLabels: Record<DocumentItem,string> = { selfiePhoto:'Selfie photo', idPhoto:'Selfie holding your ID', documents:'Document signatures' };
export const itemLabels: Record<RequestableItem,string> = { ...fieldLabels, ...documentItemLabels };
export interface ApplicantDocument { kind:'NDA'|'SOP'|'CONTACT_LIST';label:string;requiresSignature:boolean;id:string;title:string;version:number;pageCount:number;statement:string;translatedStatement:string;viewed:boolean;signed:{documentId:string;version:number;signedAt:string}|null; }
export interface ApplicantDocuments { required:boolean;missing:DocumentItem[];photos:{selfie:string|null;idSelfie:string|null};consent:{text:string;translation:string};items:ApplicantDocument[]; }
export interface ApplicantRecord { application: Application; invitation: Invitation; canEdit: boolean; editableFields: RequestableItem[]; correction: { id:string;reason:string;requestedFields:RequestableItem[];createdAt:string } | null; accessUntil: string; documents: ApplicantDocuments; }
export interface SignedRecord { documentId:string;version:number;title:string;typedName:string;signedAt:string; }
export interface StaffDocuments { required:boolean;photos:{selfie:boolean;idSelfie:boolean};
 items:{kind:string;label:string;requiresSignature:boolean;current:{id:string;title:string;version:number};applicant:SignedRecord|null;company:SignedRecord|null}[];
 countersign:{documentId:string;title:string;version:number;statement:string}|null; }
export interface Review { id:string;reviewer:{id:string;firstName:string;lastName:string};decisionType:'APPROVE'|'REQUEST_CHANGES'|'REJECT';reason:string|null;requestedFields:RequestableItem[];previousStatus:ApplicationStatus;newStatus:ApplicationStatus;createdAt:string;employment:{mcName:string;teamLead:string;jobTitle:string}|null;previousEmployment:{mcName?:string;teamLead?:string;jobTitle?:string}|null; }
export interface ReviewDetail { application:Application;invitation:Invitation;reviews:Review[];submissions:{id:string;version:number;fields:Fields;createdAt:string}[];activity:{id:string;event:string;createdAt:string}[];canReview:boolean;canReject?:boolean;readyForIt:boolean;itOnboarding:{id:string;status:string;completedAt:string|null;companyEmail:string|null;workPhoneNumber:string|null}|null;requiredFields:RequestableItem[];documents:StaffDocuments;employmentOptions?:import('./employment-picker').EmploymentOptions|null;itDetails:{legalFirstName:string|null;legalLastName:string|null;preferredAmericanFirstName:string|null;preferredAmericanLastName:string|null;proposedDisplayName:string|null;personalPhoneNumber:string|null;workPhoneNumber:string|null}; }
export interface ApplicationList { items:(Application & {email:string;mcName:string;teamLead:string})[];total:number;page:number;pageSize:number;pageCount:number; }
export interface ReviewSummary { awaitingReview:number;changesRequested:number;resubmitted:number;approved:number;rejected:number; }
export { inputClass } from '@/components/ui/field';
// Kept for existing imports; the shared client maps network, gateway and session failures to safe messages.
export { readApi } from '@/lib/client-api';
