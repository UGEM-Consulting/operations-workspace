export type MemberStatus = 'ONBOARDING' | 'ACTIVE' | 'LEFT';
export interface TeamRow { id: string; name: string; version: number; archived: boolean; mc: { id: string; name: string }; lead: { id: string; name: string } | null; members: number; onboarding?: number }
export interface TeamList { items: TeamRow[]; counts: { active: number; archived: number } }
export interface MemberRow { id: string; firstName: string; lastName: string; position: 'DISPATCHER' | 'SUPPORT'; status: MemberStatus; version: number; joinedAt: string; leftAt: string | null;
  jobTitle: string | null; since: string | null; mc: string | null; teamId: string | null; team: string | null; lead: boolean; dispatcherId?: string | null; dispatcher?: string | null }
export interface MemberList { items: MemberRow[]; counts: { onboarding?: number; active: number; left: number } }
export interface Assignment { id: string; startedAt: string; endedAt: string | null; reason: string | null; mcId: string | null; mc: string | null; mcNumber: string | null; teamId: string | null; team: string | null; movedBy: string | null }
export interface MemberDetails { legalFirstName: string | null; legalLastName: string | null; preferredAmericanFirstName: string | null; preferredAmericanLastName: string | null;
  personalEmail: string | null; personalPhoneNumber: string | null; telegram: string | null; mcName: string | null; teamLead: string | null; jobTitle: string | null; submittedAt: string | null }
export interface MemberContact { id: string; kind: 'EMAIL' | 'PHONE'; value: string; label: string | null; createdAt: string; addedBy: string | null }
export interface MemberProfile { id: string; firstName: string; lastName: string; position: 'DISPATCHER' | 'SUPPORT'; status: MemberStatus; version: number; joinedAt: string; leftAt: string | null;
  applicationId: string | null; jobTitle: { id: string; name: string } | null; current: Assignment | null; history: Assignment[]; leadOf: { id: string; name: string } | null;
  accounts: { companyEmail: string | null; workPhone: string | null; completedAt: string | null; done?: number; total?: number } | null;
  // From an API with full dispatcher details; absent on an older one.
  canOpenApplication?: boolean; details?: MemberDetails | null; documents?: { id: string; kind: string; title: string; version: number; signedAt: string }[]; photo?: boolean; idPhoto?: boolean; contacts?: MemberContact[]; activity?: { id: string; event: string; createdAt: string }[];
  // A support's dispatcher now and before (with that dispatcher's MC and team); a dispatcher's supports now.
  supportOf?: SupportLink | null; supportHistory?: SupportLink[]; supports?: { id: string; name: string; status: MemberStatus; since: string }[] }
export interface SupportLink { id: string; startedAt: string; endedAt: string | null; reason: string | null; dispatcherId: string; dispatcher: string; dispatcherStatus: MemberStatus; mc: string | null; team: string | null; changedBy: string | null }
export const statusBadge: Record<MemberStatus, { label: string; tone: 'info' | 'success' | 'neutral' }> = {
  ONBOARDING: { label: 'Onboarding', tone: 'info' }, ACTIVE: { label: 'Active', tone: 'success' }, LEFT: { label: 'Left', tone: 'neutral' } };
export interface Choice { id: string; name: string; archived: boolean }
export const fullName = (member: { firstName: string; lastName: string }) => `${member.firstName} ${member.lastName}`.trim();
