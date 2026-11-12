/** Units (section 34): trucks and trailers with their owner and dates, as the API's UnitsService returns them. */
export type UnitKind = 'SEMI' | 'PICKUP' | 'TRAILER';
export type PermitKind = 'NY_HUT' | 'KYU' | 'NM' | 'OR' | 'IFTA';
export interface UnitPermit { kind: PermitKind; expiresOn: string }
export interface UnitRow { id: string; number: string; kind: UnitKind; trailerType: string | null; year: number; make: string; vin: string; plate: string | null; plateState: string | null; version: number;
  ownerKind: 'OWNER' | 'DRIVER' | 'COMPANY'; ownerId: string | null; driverId: string | null; owner: string | null; registrationExpiresOn: string | null; inspectedOn: string | null;
  outOfServiceAt: string | null; archivedAt: string | null; responsibleId: string | null; responsible: string | null; permits: UnitPermit[]; driverNow: string | null }
export interface Choice { id: string; name: string }
export interface UnitList { today: string; items: UnitRow[]; next: { truck: string; trailer: string }; permitsFor: Record<UnitKind, PermitKind[]>; choices: { owners: Choice[]; operators: Choice[]; staff: Choice[] } }
export interface UnitEvent { id: string; event: string; metadata: Record<string, unknown>; createdAt: string; actor: string | null }
export interface UnitFile { id: string; kind: string; pageCount: number; createdAt: string; uploadedBy: string | null }
export interface UnitDetail extends Omit<UnitRow, 'permits' | 'driverNow'> { company: boolean; createdAt: string; today: string; permitsNeeded: PermitKind[]; permits: UnitPermit[]; files: UnitFile[];
  drivers: { id: string; driverId: string; driver: string; startedAt: string; endedAt: string | null; dispatcher: string; mc: string }[]; trailerNow: { id: string; number: string; trailerType: string | null }[];
  events: UnitEvent[]; ownerDocuments: { id: string; kind: string; expiresOn: string | null; pageCount: number; createdAt: string }[]; storageEnabled: boolean }
export interface OwnerRow { id: string; name: string; kind: 'OWNER' | 'DRIVER'; signerName?: string | null; email?: string | null; phone?: string | null; archivedAt?: string | null; version?: number; trucks: number; drivers: number }
export interface OwnerDetail { id: string; name: string; signerName: string | null; signerTitle: string | null; email: string | null; phone: string | null; archivedAt: string | null; version: number; createdAt: string;
  trucks: { id: string; number: string; kind: UnitKind; year: number; make: string; archivedAt: string | null; driverNow: string | null; acknowledgement?: 'SIGNED' | 'OWNER_TO_SIGN' | 'DRIVER_TO_SIGN' | null }[]; events: UnitEvent[];
  // From an API with contracts (section 39).
  contracts?: { id: string; kind: string; title: string | null; signedOn: string; pageCount: number; createdAt: string; unit: string | null; uploadedBy: string | null }[]; storageEnabled?: boolean }
export interface PermitsYear { today: string; yearEnd: string; permitsFor: Record<UnitKind, PermitKind[]>; items: { id: string; number: string; kind: UnitKind; owner: string | null; responsibleId: string | null; permits: UnitPermit[] }[] }

export const unitKinds: Record<UnitKind, string> = { SEMI: 'Semi truck', PICKUP: 'Pickup', TRAILER: 'Trailer' };
export const permitLabels: Record<PermitKind, string> = { NY_HUT: 'NY HUT', KYU: 'KYU', NM: 'New Mexico weight distance', OR: 'Oregon weight-mile', IFTA: 'IFTA decals' };
export const permitShort: Record<PermitKind, string> = { NY_HUT: 'NY HUT', KYU: 'KYU', NM: 'New Mexico', OR: 'Oregon', IFTA: 'IFTA decals' };
export const unitFileLabels: Record<string, string> = { REGISTRATION: 'Registration', INSPECTION: 'Yearly inspection', PERMITS: 'Permits', OTHER: 'Other paper' };
export const unitEventWords: Record<string, string> = { ADDED: 'Added', UPDATED: 'Details changed', DATES_RECORDED: 'Dates recorded', PERMITS_RENEWED: 'Permits renewed', FILE_ADDED: 'File added',
  FILE_VIEWED: 'File opened', OUT_OF_SERVICE: 'Marked out of service', IN_SERVICE: 'Back in service', ARCHIVED: 'Archived', RESPONSIBLE_CHANGED: 'Responsible changed',
  OWNER_ADDED: 'Owner added', OWNER_UPDATED: 'Details changed', OWNER_ARCHIVED: 'Archived', CONTRACT_ADDED: 'Signed contract uploaded', CONTRACT_VIEWED: 'Contract opened' };
/** The yearly inspection falls due a year after the last one. */
export const inspectionDue = (inspectedOn: string | null) => inspectedOn ? `${Number(inspectedOn.slice(0, 4)) + 1}${inspectedOn.slice(4)}` : null;
export const unitStatus = (unit: { outOfServiceAt: string | null; archivedAt: string | null }) => unit.archivedAt ? { label: 'Archived', tone: 'neutral' as const }
  : unit.outOfServiceAt ? { label: 'Out of service', tone: 'warning' as const } : { label: 'In service', tone: 'success' as const };
/** Days from today to a date (YYYY-MM-DD), negative once passed. */
export const daysLeft = (day: string, today: string) => Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400_000);
