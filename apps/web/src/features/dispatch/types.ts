export interface TeamRow { id: string; name: string; version: number; archived: boolean; mc: { id: string; name: string }; lead: { id: string; name: string } | null; members: number }
export interface TeamList { items: TeamRow[]; counts: { active: number; archived: number } }
export interface MemberRow { id: string; firstName: string; lastName: string; position: 'DISPATCHER' | 'SUPPORT'; status: 'ACTIVE' | 'LEFT'; version: number; joinedAt: string; leftAt: string | null;
  jobTitle: string | null; since: string | null; mc: string | null; teamId: string | null; team: string | null; lead: boolean }
export interface MemberList { items: MemberRow[]; counts: { active: number; left: number } }
export interface Assignment { id: string; startedAt: string; endedAt: string | null; reason: string | null; mcId: string | null; mc: string | null; mcNumber: string | null; teamId: string | null; team: string | null; movedBy: string | null }
export interface MemberProfile { id: string; firstName: string; lastName: string; position: 'DISPATCHER' | 'SUPPORT'; status: 'ACTIVE' | 'LEFT'; version: number; joinedAt: string; leftAt: string | null;
  applicationId: string | null; jobTitle: { id: string; name: string } | null; current: Assignment | null; history: Assignment[]; leadOf: { id: string; name: string } | null;
  accounts: { companyEmail: string | null; workPhone: string | null; completedAt: string | null } | null }
export interface Choice { id: string; name: string; archived: boolean }
export const fullName = (member: { firstName: string; lastName: string }) => `${member.firstName} ${member.lastName}`.trim();
