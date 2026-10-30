import type { StatusTone } from '@/components/ui/status-badge';

export type DriverStatus = 'LEAD' | 'APPLYING' | 'SCREENING' | 'AWAITING_DECISION' | 'APPROVED' | 'CLEARED' | 'REJECTED' | 'WITHDRAWN' | 'LEFT';
export type DriverType = 'COMPANY' | 'OWNER_OPERATOR';
export type LicenseType = 'CDL_A' | 'CDL_B' | 'CDL_C' | 'DL';
export interface SafetyPerson { id: string; name: string; active: boolean }
export interface DriverRow { id: string; firstName: string; lastName: string; phone: string; email: string | null; driverType: DriverType; licenseType: LicenseType | null; licenseState: string | null;
  status: DriverStatus; version: number; createdAt: string; closedAt: string | null; safetyLead: SafetyPerson | null; owner: SafetyPerson | null }
export interface DriverOwnerRow { id: string; startedAt: string; endedAt: string | null; reason: string | null; owner: SafetyPerson | null; assignedBy: string | null }
export interface DriverEventRow { id: string; event: string; metadata: { fields?: string[]; from?: string; first?: boolean }; createdAt: string; actor: string | null }
export interface DriverProfile extends DriverRow { experienceYears: number | null; source: string | null; notes: string | null; statusReason: string | null; updatedAt: string;
  addedBy: SafetyPerson | null; owners: DriverOwnerRow[]; activity: DriverEventRow[] }
export interface SafetyPeople { leads: { id: string; name: string; role: string }[]; staff: { id: string; name: string; role: string }[] }

export const SCREENER_ROLES = ['SYSTEM_ADMIN', 'SAFETY_MANAGER', 'SAFETY_LEAD'];
export const CLOSED: DriverStatus[] = ['REJECTED', 'WITHDRAWN', 'LEFT'];
export const WITHDRAWABLE: DriverStatus[] = ['LEAD', 'APPLYING', 'SCREENING', 'AWAITING_DECISION'];
export const OWNABLE: DriverStatus[] = ['APPROVED', 'CLEARED'];
export const driverStatus: Record<DriverStatus, { label: string; tone: StatusTone }> = {
  LEAD: { label: 'Lead', tone: 'neutral' }, APPLYING: { label: 'Applying', tone: 'info' }, SCREENING: { label: 'Screening', tone: 'info' },
  AWAITING_DECISION: { label: 'Awaiting decision', tone: 'warning' }, APPROVED: { label: 'Approved', tone: 'success' }, CLEARED: { label: 'Cleared', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'danger' }, WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' }, LEFT: { label: 'Left', tone: 'neutral' } };
export const driverTypes: Record<DriverType, string> = { COMPANY: 'Company driver', OWNER_OPERATOR: 'Owner-operator' };
export const licenseTypes: Record<LicenseType, string> = { CDL_A: 'CDL Class A', CDL_B: 'CDL Class B', CDL_C: 'CDL Class C', DL: 'Regular license (DL)' };
export const fieldLabels: Record<string, string> = { firstName: 'first name', lastName: 'last name', phone: 'phone', email: 'email', driverType: 'driver type', licenseType: 'license',
  licenseState: 'license state', experienceYears: 'experience', source: 'source', notes: 'notes' };
export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
export const license = (driver: { licenseType: LicenseType | null; licenseState: string | null }) =>
  driver.licenseType ? `${licenseTypes[driver.licenseType]}${driver.licenseState ? ` · ${driver.licenseState}` : ''}` : driver.licenseState ?? null;
