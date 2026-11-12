import { statusLabel, type StatusTone } from '@/components/ui/status-badge';
import type { DriverHistory } from '@/features/drivers/history-rules';
import type { PaperFile } from './paper-file';
import type { ContractRow, RoadReady } from './road-ready';

export type DriverStatus = 'LEAD' | 'APPLYING' | 'SCREENING' | 'AWAITING_DECISION' | 'PRE_ADVERSE' | 'APPROVED' | 'CLEARED' | 'REJECTED' | 'WITHDRAWN' | 'LEFT';
export type DriverType = 'COMPANY' | 'OWNER_OPERATOR';
export type LicenseType = 'CDL_A' | 'CDL_B' | 'CDL_C' | 'DL';
export interface SafetyPerson { id: string; name: string; active: boolean }
export interface DriverRow { id: string; firstName: string; lastName: string; phone: string; email: string | null; driverType: DriverType; licenseType: LicenseType | null; licenseState: string | null;
  status: DriverStatus; version: number; createdAt: string; closedAt: string | null; safetyLead: SafetyPerson | null; owner: SafetyPerson | null;
  // Added from a paper file (section 34): what the record still needs. Absent from an older API.
  existing?: ExistingSummary | null;
  // Ready for the road (section 39): steps done and the next one, for a cleared driver who has it.
  readySummary?: { done: number; total: number; next: string | null; unit: string | null } }
export interface ExistingSummary { addedAt: string; paperDone: number; paperOpen: number; paperTotal: number; paperOnly: number; toCheck: number; reviewed: boolean; linkSentAt: string | null; catchUpSentAt: string | null }
/** What an existing driver's record still needs, with the one next step (ExistingDriversMissingScreen). Null when nothing is missing. */
export function existingMissing(summary: ExistingSummary) {
  const paper = summary.paperDone < summary.paperTotal ? `Paper file ${summary.paperDone} of ${summary.paperTotal}` : '';
  if (summary.toCheck) return { text: [paper, 'scans sent, waiting for a check'].filter(Boolean).join(' · '), next: 'Check scans' };
  const parts = [paper, summary.paperOnly && !summary.catchUpSentAt ? 'no scans' : '', summary.reviewed ? '' : 'last yearly review not recorded'].filter(Boolean);
  if (!parts.length) return null;
  const text = parts.join(' · ');
  return { text: text.charAt(0).toUpperCase() + text.slice(1),
    next: summary.paperOnly && !summary.linkSentAt && !summary.catchUpSentAt ? 'Send catch-up link' : !summary.reviewed && !paper ? 'Record review' : 'Open' };
}
export interface DriverOwnerRow { id: string; startedAt: string; endedAt: string | null; reason: string | null; owner: SafetyPerson | null; assignedBy: string | null }
export interface DriverEventRow { id: string; event: string; metadata: { fields?: string[]; from?: string; first?: boolean; resent?: boolean; emailChanged?: boolean; kind?: string; reopened?: boolean;
  check?: string; result?: string | null; replaced?: boolean; concerns?: number; conditional?: boolean; authorization?: string; item?: string; status?: string; hidden?: boolean; action?: string; truck?: boolean;
  reason?: string; outcome?: string; withMvr?: boolean; renewal?: boolean; reminder?: boolean; channel?: string }; createdAt: string; actor: string | null }
export interface DriverProfile extends DriverRow { experienceYears: number | null; source: string | null; notes: string | null; statusReason: string | null; updatedAt: string;
  addedBy: SafetyPerson | null; owners: DriverOwnerRow[]; activity: DriverEventRow[];
  // From an API with driver applications; absent on an older one.
  link?: { email: string; createdAt: string; expiresAt: string; openedAt: string | null; expired: boolean } | null;
  application?: { status: 'DRAFT' | 'SUBMITTED'; fields: Record<string, string>; ssnLast4: string | null; version: number; submittedAt: string | null; updatedAt: string;
    correctionNote?: string | null; correctionRequestedAt?: string | null; history?: DriverHistory | null } | null;
  documents?: DriverDocumentRow[];
  // Added from a paper file (section 34): who added them, the paper file and the catch-up link. Null for everyone else; absent from an older API.
  paperFile?: PaperFile | null;
  // Ready for the road and the acknowledgements (section 39). Null before clearing; absent from an older API.
  roadReady?: RoadReady | null; contracts?: ContractRow[];
  // From an API with renewals: where renewing the license and medical card stands (the latest checked one, an open link, a scan to check).
  renewals?: RenewalRow[];
  // From an API with screening and decisions; absent on an older one.
  screening?: Screening;
  // From an API with consent forms.
  consents?: { signatures: ConsentSignature[]; missing: string[]; authorizationSigned: boolean };
  // From an API with clearance and dispatch assignments.
  clearedAt?: string | null; clearedBy?: SafetyPerson | null;
  clearance?: { items: ClearanceItemRow[]; employers: EmployerRow[]; missing: string[]; roadTest?: ReportRow | null }; assignments?: DriverAssignmentRow[];
  // From an API with rules by license (section 39): what the driver's license calls for.
  license?: LicenseRules;
  // From an API with yearly reviews.
  annualReviews?: AnnualReviews;
  // From an API with ongoing drug and alcohol testing.
  // hidden: the results aren't shown to this viewer, so items are absent.
  testing?: { items?: TestRow[]; hidden?: boolean };
  // On hold for Dispatch: a failed or refused test (null when this person may not see results, and then onHold leaves it out), a Not qualified yearly review or an expired document.
  hold?: { onHold: boolean; test: boolean | null; review: boolean; documents?: boolean };
  // From an API with accidents, violations and inspections.
  incidents?: { items: IncidentRow[] };
  // From an API with owner-operator trucks.
  trucks?: { items: TruckRow[] };
  // From an API with notice letters: the current version of each, so the decision dialogs offer Download letter.
  noticeLetters?: { PRE_ADVERSE: NoticeLetterVersion | null; FINAL: NoticeLetterVersion | null };
  // From an API with expiration reminders: how the driver gets them, and what was sent (newest first).
  reminders?: DriverReminders }
export interface DriverReminderRow { kind: string; step: number; dueOn: string; createdAt: string; channel: 'EMAIL' | 'TELEGRAM'; status: string; failureCode: string | null; sentAt: string | null }
export interface DriverReminders { telegramAvailable: boolean; emailAvailable: boolean; telegramConnected: boolean; telegramLinkedAt: string | null; items: DriverReminderRow[] }
export interface NoticeLetterVersion { version: number; pageCount: number }
export interface TruckRow { id: string; unit: string; vin: string; year: number; make: string; plate: string | null; plateState: string | null; archivedAt: string | null; documents: { id: string; kind: 'LEASE' | 'INSURANCE' | 'REGISTRATION'; expiresOn: string | null; pageCount: number }[] }
export const ownerDocumentLabels = { LEASE: 'Lease', INSURANCE: 'Insurance', REGISTRATION: 'Registration' } as const;
export interface IncidentRow { id: string; kind: 'ACCIDENT' | 'VIOLATION' | 'INSPECTION'; occurredOn: string; state: string | null; summary: string; note: string | null; preventable: 'YES' | 'NO' | 'UNDETERMINED' | null; injuries: boolean | null; fatalities: boolean | null; towAway: boolean | null; disposition: 'PENDING' | 'CONVICTED' | 'DISMISSED' | null; outOfService: boolean | null; violationCount: number | null; recordedBy: string | null; voidedAt: string | null; voidReason: string | null }
export interface TestRow { id: string; kind: 'DRUG' | 'ALCOHOL'; reason: string; testedOn: string; result: 'NEGATIVE' | 'NOT_NEGATIVE' | 'CANCELLED' | 'REFUSED'; note: string | null; recordedBy: string | null; voidedAt: string | null; voidReason: string | null }
export interface AnnualReviewRow { id: string; reviewedOn: string; outcome: 'QUALIFIED' | 'NOT_QUALIFIED'; note: string | null; reviewer: string | null; mvr: { id: string; pulledOn: string; pageCount: number } | null; fromPaper?: boolean }
export interface AnnualReviews { items: AnnualReviewRow[]; dueOn: string | null; notQualified: boolean; storageEnabled?: boolean }
export type ClearanceKey = 'DRUG_TEST' | 'CLEARINGHOUSE' | 'PREVIOUS_EMPLOYERS' | 'MEDICAL_REGISTRY' | 'ROAD_TEST' | 'E_VERIFY';
export interface ClearanceItemRow { key: ClearanceKey; status: string; result: string | null; doneOn: string | null; note: string | null; updatedAt: string; updatedBy: string | null;
  // The drug test and Clearinghouse query for someone who may not see results: only the key comes, with hidden (49 CFR 40.321).
  hidden?: boolean }
export interface EmployerRow { id: string; name: string; fromMonth: string; toMonth: string; requestedOn: string | null; answeredOn: string | null; goodFaithOn?: string | null; goodFaithNote?: string | null;
  // From an API with address and work history: where the employer came from, and how to reach them.
  source?: 'SAFETY' | 'APPLICATION'; location?: string | null; phone?: string | null }
export interface DriverAssignmentRow { id: string; startedAt: string; endedAt: string | null; truck: string | null; mc: string; team: string | null; dispatcher: string }
export interface ConsentSignature { documentId: string; kind: string; title: string; version: number; typedName: string; signedAt: string; hasSignature?: boolean }
export const consentLabels: Record<string, string> = { CONTRACTOR_ACKNOWLEDGEMENT: 'Driver and Contractor Acknowledgement', BACKGROUND_DISCLOSURE: 'Background check disclosure', BACKGROUND_AUTHORIZATION: 'Background check authorization', CLEARINGHOUSE_CONSENT: 'Clearinghouse consent',
  PSP_AUTHORIZATION: 'PSP disclosure and authorization', DOT_TESTING_AUTHORIZATION: 'DOT drug and alcohol testing authorization', APPLICATION_CERTIFICATION: 'Application certification' };
export type ScreeningCheckKey = 'IDENTITY' | 'PHONE_SCREEN' | 'EXPERIENCE' | 'HISTORY' | 'MVR';
export interface ScreeningCheck { key: ScreeningCheckKey; result: 'PASS' | 'CONCERN'; note: string | null; checkedAt: string; checkedBy: string | null }
export interface DriverReviewRow { id: string; action: string; note: string | null; conditions: string | null; noticeSentOn: string | null; previousStatus: string; newStatus: string;
  createdAt: string; actor: string | null }
export interface ReportRow { id: string; pulledOn: string; pageCount: number; createdAt: string; uploadedBy: string | null; authorization?: 'SIGNED' | 'PAPER' | null }
export interface LicenseRules { cdl: boolean; clearinghouse: boolean; psp: boolean; dotTesting: boolean; roadTestAccepted: boolean }
export interface Screening { checks: ScreeningCheck[]; mvr: ReportRow | null;
  // From an API with rules by license: the current PSP report.
  psp?: ReportRow | null;
  reviews: DriverReviewRow[]; missing: string[]; finalRejectionFrom: string | null }
export type DocumentKind = 'LICENSE' | 'MEDICAL_CARD' | 'WORK_AUTHORIZATION' | 'RETURN_TO_DUTY';
export interface DriverDocumentRow { id: string; kind: DocumentKind; subtype: string | null; pageCount: number; createdAt: string; fromPaper?: boolean;
  // An unchecked catch-up scan: the paper file's date, which still counts until the scan is checked.
  paperDate?: { expiresOn: string | null } | null;
  verifiedAt: string | null; number: string | null; expiresOn: string | null; verifiedBy: string | null; version: number;
  // From an API with renewals: a renewal Safety uploaded, and a renewal scan nobody could read.
  uploadedBySafety?: boolean; unreadableAt?: string | null }
export type RenewalKind = 'LICENSE' | 'MEDICAL_CARD';
export const RENEWAL_KINDS: RenewalKind[] = ['LICENSE', 'MEDICAL_CARD'];
// fromReminder: an expiration reminder made it (from an API with reminders), rather than someone in Safety.
export interface RenewalLink { createdAt: string; expiresAt: string; openedAt: string | null; expired: boolean; fromReminder?: boolean }
export interface RenewalScan { id: string; version: number; pageCount: number; createdAt: string; unreadable: boolean }
export interface RenewalRow { kind: RenewalKind; checked: { id: string; expiresOn: string | null; current: boolean; fromPaper?: boolean } | null; link: RenewalLink | null; scan: RenewalScan | null }
export interface SafetyPeople { leads: { id: string; name: string; role: string }[]; staff: { id: string; name: string; role: string }[] }

export const SCREENER_ROLES = ['SYSTEM_ADMIN', 'SAFETY_MANAGER', 'SAFETY_LEAD'];
/** Who decides on a screened driver: the Safety manager and administrators. */
export const DECIDER_ROLES = ['SYSTEM_ADMIN', 'SAFETY_MANAGER'];
export const CLOSED: DriverStatus[] = ['REJECTED', 'WITHDRAWN', 'LEFT'];
export const WITHDRAWABLE: DriverStatus[] = ['LEAD', 'APPLYING', 'SCREENING', 'AWAITING_DECISION', 'PRE_ADVERSE'];
/** Waiting for the Safety manager: a decision, or the end of a pre-adverse notice's waiting period. */
export const DECIDING: DriverStatus[] = ['AWAITING_DECISION', 'PRE_ADVERSE'];
export const OWNABLE: DriverStatus[] = ['APPROVED', 'CLEARED'];
export const driverStatus: Record<DriverStatus, { label: string; tone: StatusTone }> = {
  LEAD: { label: 'Lead', tone: 'neutral' }, APPLYING: { label: 'Applying', tone: 'info' }, SCREENING: { label: 'Screening', tone: 'info' },
  AWAITING_DECISION: { label: 'Awaiting decision', tone: 'warning' }, PRE_ADVERSE: { label: 'Pre-adverse notice', tone: 'warning' }, APPROVED: { label: 'Approved', tone: 'success' }, CLEARED: { label: 'Cleared', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'danger' }, WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' }, LEFT: { label: 'Left', tone: 'neutral' } };
/** The badge for a driver status; a status from a newer API shows as a neutral badge instead of failing. */
export const driverBadge = (status: string): { label: string; tone: StatusTone } => driverStatus[status as DriverStatus] ?? { label: statusLabel(status), tone: 'neutral' };
export const driverTypes: Record<DriverType, string> = { COMPANY: 'Company driver', OWNER_OPERATOR: 'Owner-operator' };
export const licenseTypes: Record<LicenseType, string> = { CDL_A: 'CDL Class A', CDL_B: 'CDL Class B', CDL_C: 'CDL Class C', DL: 'Regular license (DL)' };
export const DOCUMENT_KINDS: DocumentKind[] = ['LICENSE', 'MEDICAL_CARD', 'WORK_AUTHORIZATION'];
export const documentLabels: Record<DocumentKind, string> = { LICENSE: 'Driver’s license', MEDICAL_CARD: 'Medical card', WORK_AUTHORIZATION: 'Work authorization', RETURN_TO_DUTY: 'Return-to-duty papers' };
/** Work authorization not re-checked when it expires (Form I-9 rules), as the API decides: no date, never expiring. */
export const NOT_RECHECKED = ['US_PASSPORT', 'GREEN_CARD'];
export const workAuthorizationTypes: Record<string, string> = { US_PASSPORT: 'US passport', GREEN_CARD: 'Permanent resident card (green card)', WORK_PERMIT: 'Work permit (EAD)', OTHER: 'Another document' };
/**
 * The scans a driver needs before submitting: the license, the medical card (a 26,000 lb pickup and trailer is a commercial
 * vehicle too) and work authorization, and a CDL driver's return-to-duty papers after a Yes to a DOT question. Guidance
 * only; the API's requiredDriverDocuments decides at submission.
 */
export const requiredDocuments = (fields: { licenseClass?: string; dotPositive?: string; dotFollowUp?: string }): DocumentKind[] =>
  ['LICENSE', 'MEDICAL_CARD', 'WORK_AUTHORIZATION', ...(fields.licenseClass && fields.licenseClass !== 'DL' && (fields.dotPositive === 'YES' || fields.dotFollowUp === 'YES') ? ['RETURN_TO_DUTY' as const] : [])];
export const fieldLabels: Record<string, string> = { firstName: 'first name', lastName: 'last name', phone: 'phone', email: 'email', driverType: 'driver type', licenseType: 'license',
  licenseState: 'license state', experienceYears: 'experience', source: 'source', notes: 'notes' };
export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
export const license = (driver: { licenseType: LicenseType | null; licenseState: string | null }) =>
  driver.licenseType ? `${licenseTypes[driver.licenseType]}${driver.licenseState ? ` · ${driver.licenseState}` : ''}` : driver.licenseState ?? null;
/** The screening checklist, in the order the Safety lead works through it. */
export const screeningChecks: { key: ScreeningCheckKey; label: string; hint: string; todo: string }[] = [
  { key: 'IDENTITY', label: 'Identity and answers', hint: 'Legal name, date of birth and address match the license and the other scans.', todo: 'Check the identity and answers' },
  { key: 'PHONE_SCREEN', label: 'Phone screen', hint: 'You spoke with the driver about the job, home time and pay.', todo: 'Do the phone screen' },
  { key: 'EXPERIENCE', label: 'Driving experience', hint: 'Years and type of driving match what the driver told you.', todo: 'Confirm the driving experience' },
  { key: 'HISTORY', label: 'Address and work history', hint: 'Addresses and jobs cover their years, gaps are explained, and accidents and tickets match the MVR.', todo: 'Review the address and work history' },
  { key: 'MVR', label: 'MVR reviewed', hint: 'Violations, accidents and suspensions on the motor vehicle record.', todo: 'Review the MVR' },
];
/**
 * The clearance checklist in the order the owner works through it. Result-based items (the drug test and the Clearinghouse
 * query) take a result that sets the status; `optional` explains when an item can be not needed.
 */
// companyOnly: only company drivers (UGEM employees) need it; for an owner-operator it shows as not needed.
// cdl and dl: the label and hint for each kind of license, where they differ (section 39).
export const CLEARANCE_ITEMS: { key: ClearanceKey; label: string; hint: string; dialog: string; todo: string; optional?: string; companyOnly?: boolean; results?: Record<string, { label: string; description?: string }>;
  cdl?: { label: string; hint: string }; dl?: { label: string; hint: string } }[] = [
  { key: 'DRUG_TEST', label: 'Pre-employment drug test', hint: 'Result and date from the lab’s report. Only a negative result clears.', todo: 'Record the drug test result',
    cdl: { label: 'Pre-employment drug test (DOT)', hint: 'A DOT test under Part 382, because they drive with a CDL. Only a verified negative clears.' },
    dl: { label: 'Pre-employment drug test (non-DOT)', hint: 'The company’s own test at the med stop, because they drive without a CDL. Only a negative result clears.' },
    dialog: 'Record the result from the lab’s report. Keep the report itself in the drug testing program’s records, not here.',
    results: { NEGATIVE: { label: 'Negative' }, NOT_NEGATIVE: { label: 'Not negative', description: 'The driver can’t be cleared. The Safety Director decides what happens next.' }, CANCELLED: { label: 'Cancelled', description: 'The test needs to be taken again.' } } },
  { key: 'CLEARINGHOUSE', label: 'Clearinghouse full query', hint: 'The driver consents in the Clearinghouse; you run the full query there and record the result.', todo: 'Record the Clearinghouse query',
    dialog: 'Record what the full query returned and when. Keep the query record in the Clearinghouse.',
    results: { NO_VIOLATIONS: { label: 'No violations' }, VIOLATIONS: { label: 'Violations found', description: 'The driver can’t be cleared until the return-to-duty process is complete. The Safety Director decides what happens next.' } } },
  { key: 'PREVIOUS_EMPLOYERS', label: 'Previous employers (3 years)', hint: 'Safety performance history from each DOT-regulated employer, requested within 30 days of hire.', todo: 'Finish the previous employers',
    dialog: 'Complete this once every employer below has answered or has your good-faith effort recorded.', optional: 'The driver had no DOT-regulated employer in the last 3 years, and none are listed below.' },
  { key: 'MEDICAL_REGISTRY', label: 'Medical examiner registry check', hint: 'The examiner on the medical card is on the National Registry.', todo: 'Check the medical examiner registry',
    dialog: 'Check that the examiner who signed the medical card is listed on the National Registry of Certified Medical Examiners.' },
  { key: 'ROAD_TEST', label: 'Road test or equivalent', hint: 'A road test certificate, or a CDL accepted in its place.', todo: 'Record the road test',
    dialog: 'Record the road test, or a CDL you accept in its place.', optional: 'No road test is needed for this driver’s license.',
    cdl: { label: 'Road test or equivalent', hint: 'A valid CDL is accepted in place of a road test (391.33).' },
    dl: { label: 'Road test', hint: 'A regular license can’t stand in for a road test. Upload the signed certificate.' } },
  { key: 'E_VERIFY', label: 'E-Verify', hint: 'Within 3 business days of the first day of work, after Form I-9 is complete. Record the result from E-Verify.', todo: 'Finish E-Verify', companyOnly: true,
    dialog: 'Record what E-Verify shows. The case number stays in E-Verify and on the Form I-9, not here.',
    results: { EMPLOYMENT_AUTHORIZED: { label: 'Employment authorized', description: 'Completes this item.' },
      TENTATIVE_NONCONFIRMATION: { label: 'Tentative nonconfirmation', description: 'Stays in progress while the driver takes action. Don’t stop them working or delay their start.' },
      FINAL_NONCONFIRMATION: { label: 'Final nonconfirmation', description: 'Blocks clearance. The Safety Director decides what happens next.' },
      CASE_CLOSED: { label: 'Case closed another way', description: 'Created in error or a duplicate. Add a note and run a new case.' } } },
];
/** Whether this clearance item applies to the driver: E-Verify only to company drivers. */
export const clearanceApplies = (item: { companyOnly?: boolean }, driver: { driverType: DriverType }) => !item.companyOnly || driver.driverType === 'COMPANY';
/**
 * An item the license decides on its own (section 39): the Clearinghouse query isn't needed without a CDL, and a CDL is
 * accepted in place of the road test. Null when the item is recorded as usual. An older API sends no rules.
 */
export function licenseDecides(key: ClearanceKey, rules: LicenseRules | undefined): { status: 'NOT_NEEDED' | 'COMPLETED'; meta: string } | null {
  if (!rules) return null;
  if (key === 'CLEARINGHOUSE' && !rules.clearinghouse) return { status: 'NOT_NEEDED', meta: 'Not needed: no CDL' };
  if (key === 'ROAD_TEST' && rules.roadTestAccepted) return { status: 'COMPLETED', meta: 'CDL accepted · set by the workspace from the license' };
  return null;
}
/** The label and hint for this driver's license. */
export const itemText = (item: (typeof CLEARANCE_ITEMS)[number], rules: LicenseRules | undefined) => (rules ? (rules.cdl ? item.cdl : item.dl) : undefined) ?? { label: item.label, hint: item.hint };
export const clearanceResults: Record<string, string> = { NEGATIVE: 'Negative', NOT_NEGATIVE: 'Not negative', CANCELLED: 'Cancelled', NO_VIOLATIONS: 'No violations', VIOLATIONS: 'Violations found',
  EMPLOYMENT_AUTHORIZED: 'Employment authorized', TENTATIVE_NONCONFIRMATION: 'Tentative nonconfirmation', FINAL_NONCONFIRMATION: 'Final nonconfirmation', CASE_CLOSED: 'Case closed' };
/** What still stands before Cleared (codes from the API), in words. */
export function clearanceGapLabel(code: string): string {
  if (code === 'owner') return 'Assign an active Safety Manager';
  if (code === 'employers') return 'Get an answer or record a good-faith effort for every previous employer';
  if (code === 'clearance:PSP') return 'Upload the PSP report';
  if (code.startsWith('clearance:')) return CLEARANCE_ITEMS.find(item => item.key === code.slice(10))?.todo ?? code;
  if (code.startsWith('expired:')) return `Redo: ${CLEARANCE_ITEMS.find(item => item.key === code.slice(8))?.label ?? code} (more than a year old)`;
  return code;
}
/** What still stands before the hand-off (codes from the API), in words. */
export function gapLabel(code: string): string {
  if (code === 'application') return 'The driver hasn’t sent their application';
  if (code === 'mvr') return 'Upload the MVR';
  if (code.startsWith('check:')) return screeningChecks.find(check => check.key === code.slice(6))?.todo ?? code;
  if (code.startsWith('document:')) return `Verify the ${documentLabels[code.slice(9) as DocumentKind]?.toLowerCase() ?? code.slice(9)}`;
  return code;
}

export const testReasons: Record<string, string> = { RANDOM: 'Random', POST_ACCIDENT: 'Post-accident', REASONABLE_SUSPICION: 'Reasonable suspicion', RETURN_TO_DUTY: 'Return to duty', FOLLOW_UP: 'Follow-up' };
export const testResults: Record<string, { label: string; tone: 'success' | 'danger' | 'neutral' }> = { NEGATIVE: { label: 'Negative', tone: 'success' }, NOT_NEGATIVE: { label: 'Not negative', tone: 'danger' }, REFUSED: { label: 'Refused', tone: 'danger' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' } };
