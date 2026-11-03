import { statusLabel } from '@/components/ui/status-badge';
export type MemberStatus = 'ONBOARDING' | 'ACTIVE' | 'LEFT';
export interface TeamRow { id: string; name: string; version: number; archived: boolean; mc: { id: string; name: string }; lead: { id: string; name: string } | null; members: number; onboarding?: number }
export interface TeamList { items: TeamRow[]; counts: { active: number; archived: number } }
export interface MemberRow { addedByHand?: boolean; id: string; firstName: string; lastName: string; position: 'DISPATCHER' | 'SUPPORT'; status: MemberStatus; version: number; joinedAt: string; leftAt: string | null;
  jobTitle: string | null; since: string | null; mc: string | null; teamId: string | null; team: string | null; lead: boolean; dispatcherId?: string | null; dispatcher?: string | null;
  // On notice (from an API with notice periods): the last day, whether it has passed, who still needs reassigning, IT's removal.
  lastDay?: string | null; lastDayPassed?: boolean | null; driversToReassign?: number | null; supportsToReassign?: number | null; itRemoval?: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | null }
/** "3 drivers, 1 support", for someone on notice. */
export const toReassign = (drivers: number, supports: number) => [drivers ? `${drivers} driver${drivers === 1 ? '' : 's'}` : '', supports ? `${supports} support${supports === 1 ? '' : 's'}` : ''].filter(Boolean).join(drivers && supports ? ', ' : '') || 'Nobody';
export interface MemberList { items: MemberRow[]; counts: { onboarding?: number; active: number; left: number } }
export interface Assignment { id: string; startedAt: string; endedAt: string | null; reason: string | null; mcId: string | null; mc: string | null; mcNumber: string | null; teamId: string | null; team: string | null; movedBy: string | null }
export interface MemberDetails { legalFirstName: string | null; legalLastName: string | null; preferredAmericanFirstName: string | null; preferredAmericanLastName: string | null;
  personalEmail: string | null; personalPhoneNumber: string | null; telegram: string | null; mcName: string | null; teamLead: string | null; jobTitle: string | null; submittedAt: string | null }
export interface MemberContact { id: string; kind: 'EMAIL' | 'PHONE'; value: string; label: string | null; createdAt: string; addedBy: string | null }
export interface PaperworkRow { id: string; firstName: string; lastName: string; position: 'DISPATCHER' | 'SUPPORT'; mc: string | null; team: string | null; dispatcher: string | null; personalEmail: string | null;
  state: 'FINISHED' | 'NO_EMAIL' | 'TO_CREATE' | 'SENT' | 'OPENED' | 'IN_PROGRESS' | 'CHANGES_REQUESTED' | 'WAITING' | 'TIME_ENDED'; timeEndedAt?: string | null; returnEmail?: string | null; linkExpired: boolean; linkExpiresAt: string | null;
  nda: { state: 'PAPER' | 'SIGNED' | 'TO_SIGN'; signedOn: string | null }; sop: { state: 'PAPER' | 'SIGNED' | 'TO_SIGN'; signedOn: string | null }; applicationId: string | null; canReview: boolean }
export interface PaperworkList { items: PaperworkRow[]; counts: { toCreate: number; sent: number; waiting: number; finished: number } }
/** Someone recorded by hand: what a manager recorded, and how far their paperwork has come. */
export interface ExistingRecord { sourceName: string | null; companyEmail: string | null; ringCentralNumber: string | null; personalEmail: string | null; personalPhone: string | null; createdAt: string; acceptedAt: string | null; addedBy: string;
  paper: { kind: string; signedOn: string; createdAt: string; recordedBy: string }[]; published: string[];
  catchUp: { expiresAt: string; opened: boolean; started: boolean; status: string; signed: { kind: string; signedAt: string }[]; applicationId: string | null; reference: string | null; canReview: boolean; timeEndedAt?: string | null; returnEmail?: string | null } | null }
export interface MemberProfile { existing?: ExistingRecord | null; id: string; firstName: string; lastName: string; position: 'DISPATCHER' | 'SUPPORT'; status: MemberStatus; version: number; joinedAt: string; leftAt: string | null;
  applicationId: string | null; jobTitle: { id: string; name: string } | null; current: Assignment | null; history: Assignment[]; leadOf: { id: string; name: string } | null;
  accounts: { companyEmail: string | null; workPhone: string | null; completedAt: string | null; cancelledAt?: string | null; done?: number; total?: number } | null;
  // After they left (from an API with offboarding): why, who marked them, and IT's removal progress (never IT notes).
  leftReason?: string | null; leftBy?: string | null; signInOff?: boolean;
  removal?: { id: string; dueOn: string; scheduled?: boolean; removeNowAt?: string | null; removeNowReason?: string | null; completedAt: string | null; emailAfter: 'FORWARD' | 'SUSPEND'; forwardTo: string | null; numberOutcome: string | null; done: number; total: number; tasks: { key: string; status: string }[] } | null;
  // A notice period in progress, who still needs reassigning, and earlier notices that were cancelled or moved.
  notice?: { id: string; lastDay: string; reason: string; createdAt: string; recordedBy: string | null; passed: boolean } | null;
  driversToReassign?: { id: string; name: string; truck: string | null }[];
  noticeHistory?: { id: string; lastDay: string; reason: string; recordedBy: string | null; createdAt: string; cancelledAt: string | null; cancelledBy: string | null; cancelReason: string | null; changes: { from: string; to: string; reason: string; at: string }[] }[];
  // From an API with full dispatcher details; absent on an older one.
  canOpenApplication?: boolean; details?: MemberDetails | null; documents?: { id: string; kind: string; title: string; version: number; signedAt: string }[]; photo?: boolean; idPhoto?: boolean; contacts?: MemberContact[]; activity?: { id: string; event: string; createdAt: string }[];
  // A support's dispatcher now and before (with that dispatcher's MC and team); a dispatcher's supports now.
  supportOf?: SupportLink | null; supportHistory?: SupportLink[]; supports?: { id: string; name: string; status: MemberStatus; since: string }[] }
export interface SupportLink { id: string; startedAt: string; endedAt: string | null; reason: string | null; dispatcherId: string; dispatcher: string; dispatcherStatus: MemberStatus; mc: string | null; team: string | null; changedBy: string | null }
export const statusBadge: Record<MemberStatus, { label: string; tone: 'info' | 'success' | 'neutral' }> = {
  ONBOARDING: { label: 'Onboarding', tone: 'info' }, ACTIVE: { label: 'Active', tone: 'success' }, LEFT: { label: 'Left', tone: 'neutral' } };
/** The badge for a member status; a status from a newer API shows as a neutral badge instead of failing. */
export const memberBadge = (status: string) => statusBadge[status as MemberStatus] ?? { label: statusLabel(status), tone: 'neutral' as const };
export interface Choice { id: string; name: string; archived: boolean }
export const fullName = (member: { firstName: string; lastName: string }) => `${member.firstName} ${member.lastName}`.trim();
