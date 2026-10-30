import { statusLabel, type StatusTone } from '@/components/ui/status-badge';

export type DriverStatus = 'LEAD' | 'APPLYING' | 'SCREENING' | 'AWAITING_DECISION' | 'PRE_ADVERSE' | 'APPROVED' | 'CLEARED' | 'REJECTED' | 'WITHDRAWN' | 'LEFT';
export type DriverType = 'COMPANY' | 'OWNER_OPERATOR';
export type LicenseType = 'CDL_A' | 'CDL_B' | 'CDL_C' | 'DL';
export interface SafetyPerson { id: string; name: string; active: boolean }
export interface DriverRow { id: string; firstName: string; lastName: string; phone: string; email: string | null; driverType: DriverType; licenseType: LicenseType | null; licenseState: string | null;
  status: DriverStatus; version: number; createdAt: string; closedAt: string | null; safetyLead: SafetyPerson | null; owner: SafetyPerson | null }
export interface DriverOwnerRow { id: string; startedAt: string; endedAt: string | null; reason: string | null; owner: SafetyPerson | null; assignedBy: string | null }
export interface DriverEventRow { id: string; event: string; metadata: { fields?: string[]; from?: string; first?: boolean; resent?: boolean; emailChanged?: boolean; kind?: string; reopened?: boolean;
  check?: string; result?: string | null; replaced?: boolean; concerns?: number; conditional?: boolean }; createdAt: string; actor: string | null }
export interface DriverProfile extends DriverRow { experienceYears: number | null; source: string | null; notes: string | null; statusReason: string | null; updatedAt: string;
  addedBy: SafetyPerson | null; owners: DriverOwnerRow[]; activity: DriverEventRow[];
  // From an API with driver applications; absent on an older one.
  link?: { email: string; createdAt: string; expiresAt: string; openedAt: string | null; expired: boolean } | null;
  application?: { status: 'DRAFT' | 'SUBMITTED'; fields: Record<string, string>; ssnLast4: string | null; version: number; submittedAt: string | null; updatedAt: string;
    correctionNote?: string | null; correctionRequestedAt?: string | null } | null;
  documents?: DriverDocumentRow[];
  // From an API with screening and decisions; absent on an older one.
  screening?: Screening }
export type ScreeningCheckKey = 'IDENTITY' | 'PHONE_SCREEN' | 'EXPERIENCE' | 'MVR';
export interface ScreeningCheck { key: ScreeningCheckKey; result: 'PASS' | 'CONCERN'; note: string | null; checkedAt: string; checkedBy: string | null }
export interface DriverReviewRow { id: string; action: string; note: string | null; conditions: string | null; noticeSentOn: string | null; previousStatus: string; newStatus: string;
  createdAt: string; actor: string | null }
export interface Screening { checks: ScreeningCheck[]; mvr: { id: string; pulledOn: string; pageCount: number; createdAt: string; uploadedBy: string | null } | null;
  reviews: DriverReviewRow[]; missing: string[]; finalRejectionFrom: string | null }
export type DocumentKind = 'LICENSE' | 'MEDICAL_CARD' | 'WORK_AUTHORIZATION';
export interface DriverDocumentRow { id: string; kind: DocumentKind; subtype: string | null; pageCount: number; createdAt: string;
  verifiedAt: string | null; number: string | null; expiresOn: string | null; verifiedBy: string | null; version: number }
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
export const documentLabels: Record<DocumentKind, string> = { LICENSE: 'Driver’s license', MEDICAL_CARD: 'Medical card', WORK_AUTHORIZATION: 'Work authorization' };
export const workAuthorizationTypes: Record<string, string> = { US_PASSPORT: 'US passport', GREEN_CARD: 'Permanent resident card (green card)', WORK_PERMIT: 'Work permit (EAD)', OTHER: 'Another document' };
/**
 * The scans a driver needs before submitting, for the license class chosen on the page: a regular license (DL) needs no
 * medical card. Guidance only; the API's requiredDriverDocuments decides at submission.
 */
export const requiredDocuments = (licenseClass: string | undefined): DocumentKind[] =>
  ['LICENSE', ...(licenseClass && licenseClass !== 'DL' ? ['MEDICAL_CARD' as const] : []), 'WORK_AUTHORIZATION'];
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
  { key: 'MVR', label: 'MVR reviewed', hint: 'Violations, accidents and suspensions on the motor vehicle record.', todo: 'Review the MVR' },
];
/** What still stands before the hand-off (codes from the API), in words. */
export function gapLabel(code: string): string {
  if (code === 'application') return 'The driver hasn’t sent their application';
  if (code === 'mvr') return 'Upload the MVR';
  if (code.startsWith('check:')) return screeningChecks.find(check => check.key === code.slice(6))?.todo ?? code;
  if (code.startsWith('document:')) return `Verify the ${documentLabels[code.slice(9) as DocumentKind]?.toLowerCase() ?? code.slice(9)}`;
  return code;
}
