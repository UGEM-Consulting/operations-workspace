import type { HereMatch, HerePerson } from './already-here';
// applicationReference: from an API with it, once the applicant verified their email (never their answers).
export interface Invitation { id: string; email: string | null; expectedEmail: string | null; consumedAt: string | null; applicationReference?: string | null; alreadyHere?: HerePerson | null; mcName: string | null; teamLead: string | null; jobTitle: string | null; telegramRequired: boolean; status: string; expiresAt: string; createdAt: string; catchUpMemberId?: string | null; catchUp?: { mc: string | null; team: string | null; jobTitle: string | null; dispatcher: string | null; paper: { kind: string; signedOn: string }[] } | null;
  // From an API with supports; absent (a dispatcher) on an older one.
  position?: 'DISPATCHER' | 'SUPPORT'; supportType?: 'SUPPORT' | 'UPDATER'; supportsMemberId?: string | null; supports?: { id: string; name: string } | null; supportsTeamId?: string | null; supportsTeam?: { id: string; name: string } | null; member?: { position: string; supportType?: string } | null; }
export interface DispatcherOption { id: string; name: string; status: string; mc: string | null; team: string | null; leaving?: boolean }
export interface TeamOption { id: string; name: string; mc: string | null; archived?: boolean }
// teamOptions comes from an API with whole team supports; without it, only a dispatcher can be chosen.
// itSetupItems: what IT can be asked to set up at approval; an older API sends none and the choice isn't offered.
export interface SupportChoice { supportsMemberId: string | null; supportsTeamId?: string | null; supportType?: 'SUPPORT' | 'UPDATER'; options: DispatcherOption[]; teamOptions?: TeamOption[]; itSetupItems?: string[] }
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
export interface ApplicantDocument { kind:'NDA'|'SOP'|'CONTACT_LIST';label:string;requiresSignature:boolean;id:string;title:string;version:number;pageCount:number;statement:string;translatedStatement:string;fields?:import('@/features/documents/fields').DocumentField[];viewed:boolean;signed:{documentId:string;version:number;signedAt:string}|null; }
export interface ApplicantDocuments { required:boolean;missing:DocumentItem[];photos:{selfie:string|null;idSelfie:string|null};consent:{text:string;translation:string};items:ApplicantDocument[]; }
export interface ApplicantRecord { application: Application; invitation: Invitation; canEdit: boolean; editableFields: RequestableItem[]; correction: { id:string;reason:string;requestedFields:RequestableItem[];createdAt:string } | null; accessUntil: string; documents: ApplicantDocuments; employmentOptions?: ApplicantEmploymentOptions | null; }
export interface ApplicantEmploymentOptions { mcs: string[]; teams: { name: string; mc: string; value: string; led: boolean }[]; jobTitles: string[] }
export interface SignedRecord { documentId:string;version:number;title:string;publishedAt?:string;typedName:string;signedAt:string;signatureMethod?:string|null;signerTitle?:string|null;ipAddress?:string|null;userAgent?:string|null;documentSha256?:string|null; }
export interface StaffDocuments { required:boolean;photos:{selfie:boolean;idSelfie:boolean};
 items:{kind:string;label:string;requiresSignature:boolean;current:{id:string;title:string;version:number};applicant:SignedRecord|null;company:SignedRecord|null}[];
 countersign:{documentId:string;title:string;version:number;statement:string;fields?:import('@/features/documents/fields').DocumentField[];lastTitle?:string|null;signerName?:string;signerRole?:string}|null; }
export interface Review { id:string;reviewer:{id:string;firstName:string;lastName:string};decisionType:'APPROVE'|'REQUEST_CHANGES'|'REJECT';reason:string|null;requestedFields:RequestableItem[];previousStatus:ApplicationStatus;newStatus:ApplicationStatus;createdAt:string;employment:{mcName:string;teamLead:string;jobTitle:string}|null;previousEmployment:{mcName?:string;teamLead?:string;jobTitle?:string}|null; }
export interface ReviewDetail { catchUp?:boolean; application:Application;invitation:Invitation;member?:{position:string;supportType?:string}|null;reviews:Review[];submissions:{id:string;version:number;fields:Fields;createdAt:string}[];activity:{id:string;event:string;createdAt:string}[];canReview:boolean;canReject?:boolean;readyForIt:boolean;itOnboarding:{id:string;status:string;completedAt:string|null;cancelledAt?:string|null;companyEmail:string|null;workPhoneNumber:string|null}|null;requiredFields:RequestableItem[];documents:StaffDocuments;employmentOptions?:import('./employment-picker').EmploymentOptions|null;supports?:SupportChoice|null;itDetails:{legalFirstName:string|null;legalLastName:string|null;preferredAmericanFirstName:string|null;preferredAmericanLastName:string|null;proposedDisplayName:string|null;personalPhoneNumber:string|null;workPhoneNumber:string|null};
 // From an API with manager hand-over: who is responsible, earlier changes with their notes, and whom it can go to.
 responsibleManager?:{id:string;firstName:string;lastName:string}|null;
 // Already here (section 37): people and open applications sharing their email or phone, while nothing is decided.
 alreadyHere?:HereMatch[]|null;
 managerChanges?:{id:string;reason:'CHANGED'|'HANDED_OVER';note:string|null;createdAt:string;from:string;to:string;by:string}[];
 managerOptions?:import('./change-manager').ManagerOption[]; }
export interface ApplicationList { items:(Application & {email:string;mcName:string;teamLead:string})[];total:number;page:number;pageSize:number;pageCount:number; }
export interface ReviewSummary { awaitingReview:number;changesRequested:number;resubmitted:number;approved:number;rejected:number; }
export { inputClass } from '@/components/ui/field';
// Kept for existing imports; the shared client maps network, gateway and session failures to safe messages.
export { readApi } from '@/lib/client-api';
