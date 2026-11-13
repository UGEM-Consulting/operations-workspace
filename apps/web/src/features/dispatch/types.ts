import { statusLabel } from '@/components/ui/status-badge';
export type MemberStatus = 'ONBOARDING' | 'ACTIVE' | 'LEFT';
export interface TeamRow { id: string; name: string; version: number; archived: boolean; mc: { id: string; name: string }; lead: { id: string; name: string } | null; members: number; onboarding?: number; wholeTeam?: number;
  // Everyone assisting its dispatchers or the whole team (from an API with team pages).
  helpers?: number }
/** A person on a team's page: their card shows their photo, name and what they do. */
export interface TeamPerson { id: string; firstName: string; lastName: string; status: MemberStatus; position: 'DISPATCHER' | 'SUPPORT'; supportType?: SupportType; version: number; photo: boolean; lastDay: string | null; onLeaveUntil?: string | null }
/** GET dispatch/teams/:id: the team, its dispatchers and everyone assisting them or the whole team. */
export interface TeamDetail { id: string; name: string; version: number; archived: boolean; leadId: string | null; mc: { id: string; name: string; archived: boolean };
  dispatchers: (TeamPerson & { jobTitle: string | null; drivers: number; companyEmail: string | null; accountStatus: 'ACTIVE' | 'INACTIVE' | null })[];
  helpers: (TeamPerson & { dispatcherId: string | null; teamId: string | null })[] }
export interface TeamList { items: TeamRow[]; counts: { active: number; archived: number } }
export type SupportType = 'SUPPORT' | 'UPDATER';
/** What the API sends as the MC of someone who has none yet (never a list entry). */
export const NO_MC = 'No MC yet';
/** Under a real MC with no team is Independent; someone with no MC yet has no team either. */
export const underMc = (mc: string | null | undefined) => !!mc && mc !== NO_MC;
/** What someone in the support position is called. An older API sends nothing, and they're all Support then. */
export const supportName = (row: { supportType?: string | null }) => row.supportType === 'UPDATER' ? 'Updater' : 'Support';
/** The same in a sentence: "this updater", "as a support". */
export const supportWord = (row: { supportType?: string | null }) => supportName(row).toLowerCase();
export const aSupport = (row: { supportType?: string | null }) => row.supportType === 'UPDATER' ? 'an updater' : 'a support';
export interface MemberRow {
  // The Dispatchers table (from an API that filters on the server): where they work by id, their team lead, open drivers and what a search matched.
  mcId?: string | null; leadId?: string | null; teamLead?: string | null; jobTitleId?: string | null; drivers?: number; matched?: { label: string; value: string } | null;
  addedByHand?: boolean; id: string; firstName: string; lastName: string; position: 'DISPATCHER' | 'SUPPORT'; supportType?: SupportType; status: MemberStatus; version: number; joinedAt: string; leftAt: string | null;
  jobTitle: string | null; since: string | null; mc: string | null; teamId: string | null; team: string | null; lead: boolean; dispatcherId?: string | null; dispatcher?: string | null; wholeTeam?: string | null;
  // On notice (from an API with notice periods): the last day, whether it has passed, who still needs reassigning, IT's removal.
  lastDay?: string | null; lastDayPassed?: boolean | null; driversToReassign?: number | null; supportsToReassign?: number | null; itRemoval?: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | null;
  // Added by hand with details missing (from an API with missing details).
  placed?: boolean; startDateKnown?: boolean; sinceKnown?: boolean;
  // What a team lead signs in with, and whether they have a sign-in (from an API with team lead sign-ins).
  companyEmail?: string | null; accountStatus?: 'ACTIVE' | 'INACTIVE' | null;
  // Leave (section 35): the open leave, upcoming or started, and how far IT's suspend is.
  leave?: { firstDay: string; backOn: string; started: boolean; it: 'NONE' | 'IN_PROGRESS' | 'SUSPENDED' } | null }
/** Someone here who still needs a start date or, for a dispatcher, an MC. */
export const missingDetails = (member: MemberRow) => member.status !== 'LEFT' && (member.startDateKnown === false || (member.position === 'DISPATCHER' && member.placed === false));
/** Who a support or updater assists: "Riley Santos", or a team's name when it's everyone on it. */
export const assists = (row: { dispatcher?: string | null; wholeTeam?: string | null }) => row.wholeTeam ?? row.dispatcher ?? 'a dispatcher';
/** "3 drivers, 1 support", for someone on notice. */
export const toReassign = (drivers: number, supports: number) => [drivers ? `${drivers} driver${drivers === 1 ? '' : 's'}` : '', supports ? (supports === 1 ? '1 support or updater' : `${supports} supports or updaters`) : ''].filter(Boolean).join(drivers && supports ? ', ' : '') || 'Nobody';
export interface MemberList { items: MemberRow[]; counts: { onboarding?: number; active: number; left: number; onLeave?: number; leaving?: number; missing?: number; all?: number; paperwork?: number };
  // A page of the Dispatchers table, with what its filters offer.
  total?: number; page?: number; pageSize?: number; options?: MemberOptions }
export interface MemberOptions { mcs: { id: string; name: string; archived: boolean }[]; teams: { id: string; name: string; mcId: string; archived: boolean }[]; leads: { id: string; name: string }[]; jobTitles: { id: string; name: string; archived: boolean }[] }
export interface Assignment { id: string; startedAt: string; endedAt: string | null; reason: string | null; mcId: string | null; mc: string | null; mcNumber: string | null; teamId: string | null; team: string | null; movedBy: string | null }
export interface MemberDetails { legalFirstName: string | null; legalLastName: string | null; preferredAmericanFirstName: string | null; preferredAmericanLastName: string | null;
  personalEmail: string | null; personalPhoneNumber: string | null; telegram: string | null; mcName: string | null; teamLead: string | null; jobTitle: string | null; submittedAt: string | null }
export interface MemberContact { id: string; kind: 'EMAIL' | 'PHONE'; value: string; label: string | null; createdAt: string; addedBy: string | null }
export interface PaperworkRow { id: string; firstName: string; lastName: string; position: 'DISPATCHER' | 'SUPPORT'; supportType?: SupportType; mc: string | null; team: string | null; wholeTeam?: string | null; dispatcher: string | null; personalEmail: string | null;
  state: 'FINISHED' | 'NO_EMAIL' | 'TO_CREATE' | 'SENT' | 'OPENED' | 'IN_PROGRESS' | 'CHANGES_REQUESTED' | 'WAITING' | 'TIME_ENDED'; timeEndedAt?: string | null; returnEmail?: string | null; linkExpired: boolean; linkExpiresAt: string | null;
  nda: { state: 'PAPER' | 'SIGNED' | 'TO_SIGN'; signedOn: string | null }; sop: { state: 'PAPER' | 'SIGNED' | 'TO_SIGN'; signedOn: string | null }; applicationId: string | null; canReview: boolean }
export interface PaperworkList { items: PaperworkRow[]; counts: { toCreate: number; sent: number; waiting: number; finished: number } }
/** Someone recorded by hand: what a manager recorded, and how far their paperwork has come. */
export interface ExistingRecord { sourceName: string | null; companyEmail: string | null; ringCentralNumber: string | null; ringCentralExtension?: string | null; datEmail?: string | null; truckstopEmail?: string | null; telegram?: string | null; personalEmail: string | null; personalPhone: string | null; createdAt: string; acceptedAt: string | null; addedBy: string;
  startDateKnown?: boolean; periodDateKnown?: boolean; undatedPeriodId?: string | null;
  // People who left and other names (section 33): added as Left from a file, whether their last day is known, and their legal name.
  addedAsLeft?: boolean; leftDateKnown?: boolean; legalFirstName?: string | null; legalLastName?: string | null; startDateChanges?: { id: string; startedOn: string; previousOn: string | null; reason: string | null; createdAt: string; changedBy: string }[];
  paper: PaperCopy[]; published: string[]; paperScans?: boolean;
  catchUp: { expiresAt: string; opened: boolean; started: boolean; status: string; signed: { kind: string; signedAt: string }[]; applicationId: string | null; reference: string | null; canReview: boolean; timeEndedAt?: string | null; returnEmail?: string | null } | null }
export interface SharedSignIns { dat: { id: string; name: string }[]; truckstop: { id: string; name: string }[] }
/** A support's or updater's IT setup (section 32): the request IT is working on and how many finished. Absent from an older API. */
export interface SupportItSetup { open: { id: string; items: string[]; done: number; total: number; createdAt: string; requestedBy: string | null } | null; finished: number }
/** An NDA or SOP signed on paper, with its current scan and the ones it replaced (section 38; an older API sends neither). */
export interface PaperScan { id: string; pageCount: number; createdAt: string; uploadedBy: string }
export interface PaperCopy { kind: 'NDA' | 'SOP'; signedOn: string; createdAt: string; recordedBy: string; scan?: PaperScan | null; earlierScans?: (PaperScan & { replacedAt: string })[] }
export interface OtherName { id: string; name: string; mcId: string | null; mc: string | null }
export interface MemberProfile { otherNames?: OtherName[]; itSetup?: SupportItSetup | null; sharedSignIns?: SharedSignIns; existing?: ExistingRecord | null; id: string; firstName: string; lastName: string; position: 'DISPATCHER' | 'SUPPORT'; supportType?: SupportType; supportTypeChanges?: { id: string; to: string; createdAt: string; changedBy: string | null }[]; status: MemberStatus; version: number; joinedAt: string; leftAt: string | null;
  applicationId: string | null; jobTitle: { id: string; name: string } | null; current: Assignment | null; history: Assignment[]; leadOf: { id: string; name: string } | null;
  accounts: { companyEmail: string | null; workPhone: string | null; ringCentralExtension?: string | null; datEmail?: string | null; truckstopEmail?: string | null; completedAt: string | null; cancelledAt?: string | null; done?: number; total?: number } | null;
  // After they left (from an API with offboarding): why, who marked them, and IT's removal progress (never IT notes).
  leftReason?: string | null; leftBy?: string | null; signInOff?: boolean;
  // Their workspace sign-in as a team lead: waiting for IT (to create, turn on or turn off), on or off; null with none.
  signIn?: { status: 'WAITING' | 'ACTIVE' | 'OFF'; request: 'CREATE' | 'TURN_ON' | 'TURN_OFF' | null } | null;
  removal?: { id: string; dueOn: string; scheduled?: boolean; removeNowAt?: string | null; removeNowReason?: string | null; completedAt: string | null; emailAfter: 'FORWARD' | 'SUSPEND'; forwardTo: string | null; numberOutcome: string | null; done: number; total: number; tasks: { key: string; status: string }[] } | null;
  // A notice period in progress, who still needs reassigning, and earlier notices that were cancelled or moved.
  notice?: { id: string; lastDay: string; reason: string; createdAt: string; recordedBy: string | null; passed: boolean } | null;
  driversToReassign?: { id: string; name: string; truck: string | null }[];
  noticeHistory?: { id: string; lastDay: string; reason: string; recordedBy: string | null; createdAt: string; cancelledAt: string | null; cancelledBy: string | null; cancelReason: string | null; changes: { from: string; to: string; reason: string; at: string }[] }[];
  // From an API with full dispatcher details; absent on an older one.
  canOpenApplication?: boolean; details?: MemberDetails | null; documents?: { id: string; kind: string; title: string; version: number; signedAt: string }[]; photo?: boolean; idPhoto?: boolean; contacts?: MemberContact[]; activity?: { id: string; event: string; createdAt: string }[];
  // A support's dispatcher now and before (with that dispatcher's MC and team); a dispatcher's supports now.
  supportOf?: SupportLink | null; supportHistory?: SupportLink[]; supports?: { id: string; name: string; supportType?: SupportType; status: MemberStatus; since: string; sinceKnown?: boolean; onLeaveUntil?: string | null }[];
  // Leave (section 35): the open leave with IT's suspend checklist, the latest restore once back, and earlier leaves.
  leave?: MemberLeave | null; restore?: LeaveIt | null; leaveHistory?: MemberLeave[];
  // Corrections (section 36) and the record they left before coming back, or came back as (section 37).
  corrections?: MemberCorrection[]; correctedFields?: Record<string, { by: string; at: string }>; previousRecord?: { id: string; name: string; leftAt: string | null } | null; laterRecord?: { id: string; name: string; joinedAt: string; status: MemberStatus } | null }
/** Leave (section 35): IT's suspend or restore checklist, progress only (never IT notes). */
export interface LeaveIt { id: string; kind: 'SUSPEND' | 'RESTORE'; dueOn: string; completedAt: string | null; cancelledAt: string | null; done: number; total: number; tasks: { key: string; status: string }[] }
export interface MemberLeave { id: string; firstDay: string; backOn: string; reason: string; emailWhileAway: 'FORWARD' | 'AUTO_REPLY' | null; callsWhileAway: 'FORWARD' | 'VOICEMAIL' | null;
  changes: { kind: 'BACK_ON' | 'REASON'; from: string | null; to: string | null; reason: string | null; byName: string; at: string }[]; startedAt: string | null; endedAt: string | null; endedHow: 'RETURNED' | 'CANCELLED' | 'LEAVING' | null;
  createdAt: string; recordedBy: string; forwardTo: string | null; started?: boolean; suspend?: LeaveIt | null }
/** An administrator's correction (section 36): each field's earlier and new value, why, who and when. */
export interface MemberCorrection { id: string; changes: { field: string; from: string | null; to: string | null }[]; reason: string; createdAt: string; correctedBy: string }
export interface SupportLink { id: string; startedAt: string; endedAt: string | null; reason: string | null; dispatcherId: string | null; dispatcher: string | null; dispatcherStatus: MemberStatus | null; wholeTeam?: string | null; mc: string | null; team: string | null; changedBy: string | null }
export const statusBadge: Record<MemberStatus, { label: string; tone: 'info' | 'success' | 'neutral' }> = {
  ONBOARDING: { label: 'Onboarding', tone: 'info' }, ACTIVE: { label: 'Active', tone: 'success' }, LEFT: { label: 'Left', tone: 'neutral' } };
/** The badge for a member status; a status from a newer API shows as a neutral badge instead of failing. */
export const memberBadge = (status: string) => statusBadge[status as MemberStatus] ?? { label: statusLabel(status), tone: 'neutral' as const };
export interface Choice { id: string; name: string; archived: boolean }
export const fullName = (member: { firstName: string; lastName: string }) => `${member.firstName} ${member.lastName}`.trim();
