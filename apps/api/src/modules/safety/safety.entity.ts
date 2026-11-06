import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { StorageLayout } from '../storage/storage.service';
import type { DriverHistory } from './history-rules';

export const DRIVER_TYPES = ['COMPANY', 'OWNER_OPERATOR'] as const;
export type DriverType = typeof DRIVER_TYPES[number];
export const LICENSE_TYPES = ['CDL_A', 'CDL_B', 'CDL_C', 'DL'] as const;
export type LicenseType = typeof LICENSE_TYPES[number];
// LEAD → APPLYING → SCREENING → AWAITING_DECISION → APPROVED → CLEARED; REJECTED, WITHDRAWN and LEFT close the record.
// A rejection always passes through PRE_ADVERSE (the pre-adverse notice and its waiting period), also from APPROVED when
// clearance turns something up. A driver who stops driving for the company is marked LEFT (approved or cleared only).
export const DRIVER_STATUSES = ['LEAD', 'APPLYING', 'SCREENING', 'AWAITING_DECISION', 'PRE_ADVERSE', 'APPROVED', 'CLEARED', 'REJECTED', 'WITHDRAWN', 'LEFT'] as const;
export type DriverStatus = typeof DRIVER_STATUSES[number];
export const CLOSED_STATUSES: readonly DriverStatus[] = ['REJECTED', 'WITHDRAWN', 'LEFT'];
/** Statuses a driver can be withdrawn from: anything before the Safety manager's approval. */
/** Drivers who work for the company and can be marked as Left. */
export const LEAVABLE: readonly DriverStatus[] = ['APPROVED', 'CLEARED'];
export const WITHDRAWABLE: readonly DriverStatus[] = ['LEAD', 'APPLYING', 'SCREENING', 'AWAITING_DECISION', 'PRE_ADVERSE'];
/** A safety staff owner is assigned once the Safety manager has approved the driver. */
export const OWNABLE: readonly DriverStatus[] = ['APPROVED', 'CLEARED'];
export const DRIVER_EVENTS = ['CREATED', 'UPDATED', 'WITHDRAWN', 'REOPENED', 'SAFETY_LEAD_CHANGED', 'OWNER_ASSIGNED',
 'LINK_SENT', 'LINK_CANCELLED', 'APPLICATION_VERIFIED', 'APPLICATION_SUBMITTED', 'SSN_REVEALED', 'DOCUMENT_UPLOADED', 'DOCUMENT_VERIFIED', 'DOCUMENT_VIEWED',
 'SCREENING_CHECKED', 'MVR_UPLOADED', 'MVR_VIEWED', 'CORRECTIONS_REQUESTED', 'SENT_FOR_DECISION', 'APPROVED', 'MORE_INFO_REQUESTED', 'PRE_ADVERSE_RECORDED', 'REJECTED', 'CONSENT_SIGNED',
 'CLEARANCE_RECORDED', 'EMPLOYER_RECORDED', 'CLEARED', 'DISPATCH_ASSIGNED', 'LEFT', 'ANNUAL_REVIEW_RECORDED', 'TEST_RECORDED', 'TEST_VOIDED', 'INCIDENT_RECORDED', 'INCIDENT_UPDATED', 'INCIDENT_VOIDED', 'TRUCK_SAVED', 'OWNER_DOCUMENT_UPLOADED', 'OWNER_DOCUMENT_VIEWED',
 'RENEWAL_LINK_SENT', 'RENEWAL_LINK_CANCELLED', 'RENEWAL_OPENED', 'DOCUMENT_RENEWED', 'DOCUMENT_UNREADABLE'] as const;
export type DriverEventType = typeof DRIVER_EVENTS[number];
export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'] as const;

/** Digits only, without a leading US country code, so "+1 (555) 010-2000" and "555-010-2000" are the same number. */
export function phoneKey(phone: string) {
 const digits = phone.replace(/\D/g, '');
 return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** A driver Safety is onboarding or has onboarded. Not a login. */
@Entity('drivers')
export class Driver {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('varchar', { length: 100 }) firstName!: string;
 @Column('varchar', { length: 100 }) lastName!: string;
 @Column('varchar', { length: 40 }) phone!: string;
 @Column('varchar', { length: 15 }) phoneKey!: string;
 @Column('varchar', { length: 254, nullable: true }) email!: string | null;
 @Column('varchar') driverType!: DriverType;
 @Column('varchar', { nullable: true }) licenseType!: LicenseType | null;
 @Column('varchar', { length: 2, nullable: true }) licenseState!: string | null;
 @Column('smallint', { nullable: true }) experienceYears!: number | null;
 @Column('varchar', { length: 100, nullable: true }) source!: string | null;
 @Column('varchar', { length: 2000, nullable: true }) notes!: string | null;
 @Column('varchar', { default: 'LEAD' }) status!: DriverStatus;
 @Column('varchar', { length: 500, nullable: true }) statusReason!: string | null;
 @Column('timestamptz', { nullable: true }) closedAt!: Date | null;
 @Column('uuid', { nullable: true }) safetyLeadId!: string | null;
 @Column('uuid', { nullable: true }) createdBy!: string | null;
 @Column('timestamptz', { nullable: true }) clearedAt!: Date | null;
 @Column('uuid', { nullable: true }) clearedBy!: string | null;
 @Column('integer', { default: 1 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

/** Which safety staff member owns a driver, over time: the open row (endedAt null) is now. */
@Entity('driver_owners')
export class DriverOwner {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') driverId!: string;
 @Column('uuid', { nullable: true }) ownerId!: string | null;
 @Column('timestamptz', { default: () => 'now()' }) startedAt!: Date;
 @Column('timestamptz', { nullable: true }) endedAt!: Date | null;
 @Column('varchar', { length: 500, nullable: true }) reason!: string | null;
 @Column('uuid', { nullable: true }) actorId!: string | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}

/** Who did what to a driver record and which fields changed; never the values. */
@Entity('driver_events')
export class DriverEvent {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') driverId!: string;
 @Column('uuid', { nullable: true }) actorId!: string | null;
 @Column('varchar') event!: DriverEventType;
 @Column('jsonb', { default: {} }) metadata!: Record<string, unknown>;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}

/** The driver's own answers (never the SSN, which is encrypted separately). Drafts may be incomplete. */
export interface DriverApplicationFields {
 legalFirstName?: string; legalMiddleName?: string; legalLastName?: string; dateOfBirth?: string; phone?: string;
 addressLine1?: string; addressLine2?: string; city?: string; state?: string; zip?: string;
 emergencyName?: string; emergencyRelationship?: string; emergencyPhone?: string;
 licenseNumber?: string; licenseState?: string; licenseClass?: LicenseType; licenseExpiresOn?: string;
}
export const REQUIRED_DRIVER_FIELDS = ['legalFirstName', 'legalLastName', 'dateOfBirth', 'phone', 'addressLine1', 'city', 'state', 'zip',
 'emergencyName', 'emergencyRelationship', 'emergencyPhone', 'licenseNumber', 'licenseState', 'licenseClass', 'licenseExpiresOn'] as const;

/** An application link. Only the token's hash is stored; the link is bound to one email and closes on submission. */
@Entity('driver_links')
export class DriverLink {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') driverId!: string;
 @Column('varchar', { length: 64, select: false }) tokenHash!: string;
 @Column('varchar', { length: 254 }) email!: string;
 @Column('uuid', { nullable: true }) createdBy!: string | null;
 @Column('timestamptz') expiresAt!: Date;
 @Column('timestamptz', { nullable: true }) openedAt!: Date | null;
 @Column('timestamptz', { nullable: true }) revokedAt!: Date | null;
 @Column('timestamptz', { nullable: true }) completedAt!: Date | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 // An application link, or a link to scan one renewed document (completedAt is when the driver sent it).
 @Column('varchar', { default: 'APPLICATION' }) purpose!: 'APPLICATION' | 'RENEWAL';
 @Column('varchar', { nullable: true }) documentKind!: RenewalKind | null;
}

/** One emailed code request. Unmatched requests are stored too (no link, no code) so every request writes the same. */
@Entity('driver_challenges')
export class DriverChallenge {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid', { nullable: true }) linkId!: string | null;
 @Column('varchar', { length: 254, nullable: true }) email!: string | null;
 @Column('varchar', { length: 64, nullable: true, select: false }) codeHash!: string | null;
 @Column('timestamptz') expiresAt!: Date;
 @Column('timestamptz', { nullable: true }) consumedAt!: Date | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}

@Entity('driver_applications')
export class DriverApplication {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') driverId!: string;
 @Column('varchar', { default: 'DRAFT' }) status!: 'DRAFT' | 'SUBMITTED';
 @Column('jsonb', { default: {} }) fields!: DriverApplicationFields;
 // Address and work history (history-rules.ts); null until the driver adds any.
 @Column('jsonb', { nullable: true }) history!: DriverHistory | null;
 @Column('text', { nullable: true, select: false }) ssnCiphertext!: string | null;
 @Column('varchar', { length: 4, nullable: true }) ssnLast4!: string | null;
 @Column('integer', { default: 1 }) version!: number;
 @Column('timestamptz', { nullable: true }) submittedAt!: Date | null;
 // What Safety asked the driver to correct (shown to the driver); cleared when they send the application again.
 @Column('varchar', { length: 1000, nullable: true }) correctionNote!: string | null;
 @Column('timestamptz', { nullable: true }) correctionRequestedAt!: Date | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

export const DRIVER_DOCUMENT_KINDS = ['LICENSE', 'MEDICAL_CARD', 'WORK_AUTHORIZATION'] as const;
export type DriverDocumentKind = typeof DRIVER_DOCUMENT_KINDS[number];
/** The driver chooses which work-authorization document to provide; Safety never demands a specific one. */
export const WORK_AUTHORIZATION_TYPES = ['US_PASSPORT', 'GREEN_CARD', 'WORK_PERMIT', 'OTHER'] as const;
export type WorkAuthorizationType = typeof WORK_AUTHORIZATION_TYPES[number];
/** URL segments for document kinds (driver/documents/<segment>). */
/** Documents renewed once the driver is approved or cleared (an expired one puts a cleared driver on hold). */
export const RENEWAL_KINDS = ['LICENSE', 'MEDICAL_CARD'] as const;
export type RenewalKind = typeof RENEWAL_KINDS[number];
export const DOCUMENT_SEGMENTS: Record<string, DriverDocumentKind> = { license: 'LICENSE', 'medical-card': 'MEDICAL_CARD', 'work-authorization': 'WORK_AUTHORIZATION' };
/** Documents needed before submitting: the license and work authorization, and a medical card for CDL drivers. */
export function requiredDriverDocuments(fields: DriverApplicationFields): DriverDocumentKind[] {
 return ['LICENSE', ...(fields.licenseClass && fields.licenseClass !== 'DL' ? ['MEDICAL_CARD' as const] : []), 'WORK_AUTHORIZATION'];
}

/** A scanned document: the driver's photographed pages as one PDF in private storage. */
@Entity('driver_documents')
export class DriverDocument {
 @PrimaryColumn('uuid') id!: string;
 @Column('uuid') driverId!: string;
 @Column('varchar') kind!: DriverDocumentKind;
 @Column('varchar', { nullable: true }) subtype!: WorkAuthorizationType | null;
 @Column('smallint') pageCount!: number;
 @Column('varchar', { length: 64 }) sha256!: string;
 @Column('integer') byteSize!: number;
 @Column('timestamptz') createdAt!: Date;
 @Column('timestamptz', { nullable: true }) replacedAt!: Date | null;
 @Column('smallint', { default: 1 }) storageLayout!: StorageLayout;
 @Column('timestamptz', { nullable: true }) verifiedAt!: Date | null;
 @Column('uuid', { nullable: true }) verifiedBy!: string | null;
 @Column('varchar', { length: 40, nullable: true }) number!: string | null;
 @Column('date', { nullable: true }) expiresOn!: string | null;
 // Bumped by each verification, so two people recording the same document can't silently overwrite each other.
 @Column('integer', { default: 1 }) version!: number;
 // Who uploaded a renewal (null: the driver scanned it), and a renewal scan Safety couldn't read (it is never checked).
 @Column('uuid', { nullable: true }) uploadedBy!: string | null;
 @Column('timestamptz', { nullable: true }) unreadableAt!: Date | null;
 @Column('uuid', { nullable: true }) unreadableBy!: string | null;
}

/**
 * The Safety lead's screening checklist. Each check is passed, or noted as a concern for the Safety manager (a concern
 * needs a note). Notes never hold SSNs, medical or drug test details.
 */
export const SCREENING_CHECKS = ['IDENTITY', 'PHONE_SCREEN', 'EXPERIENCE', 'HISTORY', 'MVR'] as const;
export type ScreeningCheckKey = typeof SCREENING_CHECKS[number];
export const SCREENING_RESULTS = ['PASS', 'CONCERN'] as const;
export type ScreeningResult = typeof SCREENING_RESULTS[number];
@Entity('driver_screening_checks')
export class DriverScreeningCheck {
 @PrimaryColumn('uuid') driverId!: string;
 @PrimaryColumn('varchar') key!: ScreeningCheckKey;
 @Column('varchar') result!: ScreeningResult;
 @Column('varchar', { length: 1000, nullable: true }) note!: string | null;
 @Column('uuid', { nullable: true }) checkedBy!: string | null;
 @Column('timestamptz') checkedAt!: Date;
}

/** A report Safety pulled about the driver (the MVR), uploaded as a PDF. Replaced reports are kept with replacedAt. */
@Entity('driver_reports')
export class DriverReport {
 @PrimaryColumn('uuid') id!: string;
 @Column('uuid') driverId!: string;
 @Column('varchar') kind!: 'MVR' | 'ANNUAL_MVR';
 @Column('date') pulledOn!: string;
 @Column('smallint') pageCount!: number;
 @Column('varchar', { length: 64 }) sha256!: string;
 @Column('integer') byteSize!: number;
 @Column('uuid', { nullable: true }) uploadedBy!: string | null;
 @Column('timestamptz') createdAt!: Date;
 @Column('timestamptz', { nullable: true }) replacedAt!: Date | null;
 @Column('smallint', { default: 1 }) storageLayout!: StorageLayout;
 // How the driver's authorization was on file: signed in the workspace, or on paper (confirmed by the uploader).
 @Column('varchar', { nullable: true }) authorization!: 'SIGNED' | 'PAPER' | null;
}

/**
 * Screening hand-offs and the Safety manager's decisions, append-only (a database trigger refuses changes). A rejection is
 * two rows: PRE_ADVERSE (the notice Safety sent with a copy of the report) and, after the waiting period, REJECTED.
 */
export const REVIEW_ACTIONS = ['SENT_FOR_DECISION', 'APPROVED', 'MORE_INFO', 'PRE_ADVERSE', 'REJECTED'] as const;
export type DriverReviewAction = typeof REVIEW_ACTIONS[number];
@Entity('driver_reviews')
export class DriverReview {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') driverId!: string;
 @Column('varchar') action!: DriverReviewAction;
 @Column('varchar', { length: 2000, nullable: true }) note!: string | null;
 @Column('varchar', { length: 1000, nullable: true }) conditions!: string | null;
 @Column('date', { nullable: true }) noticeSentOn!: string | null;
 @Column('varchar') previousStatus!: DriverStatus;
 @Column('varchar') newStatus!: DriverStatus;
 @Column('uuid', { nullable: true }) actorId!: string | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}

/** Business days the driver has to respond to a pre-adverse notice before the rejection can be final. */
export const ADVERSE_WAIT_BUSINESS_DAYS = 5;
/** The first date (YYYY-MM-DD) a rejection can be final: the notice date plus the waiting period, skipping weekends. */
export function earliestFinalRejection(noticeSentOn: string): string {
 const date = new Date(`${noticeSentOn}T12:00:00Z`);
 for (let added = 0; added < ADVERSE_WAIT_BUSINESS_DAYS;) {
  date.setUTCDate(date.getUTCDate() + 1);
  if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) added++;
 }
 return date.toISOString().slice(0, 10);
}

/**
 * What has to be on file before an approved driver can run loads. The owner records results only: drug test and medical
 * details stay out of the workspace. The drug test and the Clearinghouse query take a result, which sets the status; the
 * others take a status. No row means not started.
 */
export const CLEARANCE_ITEMS = ['DRUG_TEST', 'CLEARINGHOUSE', 'PREVIOUS_EMPLOYERS', 'MEDICAL_REGISTRY', 'ROAD_TEST'] as const;
export type ClearanceKey = typeof CLEARANCE_ITEMS[number];
export const CLEARANCE_STATUSES = ['IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'NOT_NEEDED'] as const;
export type ClearanceStatus = typeof CLEARANCE_STATUSES[number];
/** Items that may be not needed (with a note): no earlier DOT employer, or no road test for the license. */
export const CLEARANCE_OPTIONAL: readonly ClearanceKey[] = ['PREVIOUS_EMPLOYERS', 'ROAD_TEST'];
/** The result each result-based item takes, and the status each result means. */
export const CLEARANCE_RESULTS: Partial<Record<ClearanceKey, Record<string, ClearanceStatus>>> = {
 DRUG_TEST: { NEGATIVE: 'COMPLETED', NOT_NEGATIVE: 'BLOCKED', CANCELLED: 'IN_PROGRESS' },
 CLEARINGHOUSE: { NO_VIOLATIONS: 'COMPLETED', VIOLATIONS: 'BLOCKED' },
};
@Entity('driver_clearance_items')
export class DriverClearanceItem {
 @PrimaryColumn('uuid') driverId!: string;
 @PrimaryColumn('varchar') key!: ClearanceKey;
 @Column('varchar') status!: ClearanceStatus;
 @Column('varchar', { nullable: true }) result!: string | null;
 @Column('date', { nullable: true }) doneOn!: string | null;
 @Column('varchar', { length: 1000, nullable: true }) note!: string | null;
 @Column('uuid', { nullable: true }) updatedBy!: string | null;
 @Column('timestamptz') updatedAt!: Date;
}

/** An employer Safety asks about the driver's safety record (months as YYYY-MM). Removable until Safety asks them. */
@Entity('driver_previous_employers')
export class DriverPreviousEmployer {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') driverId!: string;
 @Column('varchar', { length: 200 }) name!: string;
 @Column('char', { length: 7 }) fromMonth!: string;
 @Column('char', { length: 7 }) toMonth!: string;
 // APPLICATION: copied at approval from the driver's DOT-regulated jobs; SAFETY: added by Safety.
 @Column('varchar', { default: 'SAFETY' }) source!: 'SAFETY' | 'APPLICATION';
 @Column('varchar', { length: 120, nullable: true }) location!: string | null;
 @Column('varchar', { length: 40, nullable: true }) phone!: string | null;
 @Column('date', { nullable: true }) requestedOn!: string | null;
 @Column('date', { nullable: true }) answeredOn!: string | null;
 // For an employer who never answers: when Safety last tried and what they did.
 @Column('date', { nullable: true }) goodFaithOn!: string | null;
 @Column('varchar', { length: 500, nullable: true }) goodFaithNote!: string | null;
 @Column('uuid', { nullable: true }) createdBy!: string | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}

/** Which MC and dispatcher a cleared driver works with, from a date; the open row (no endedAt) is now. Changes add rows. */
@Entity('driver_assignments')
export class DriverAssignment {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') driverId!: string;
 @Column('uuid') mcId!: string;
 @Column('uuid') memberId!: string;
 @Column('varchar', { length: 40, nullable: true }) truck!: string | null;
 @Column('timestamptz') startedAt!: Date;
 @Column('timestamptz', { nullable: true }) endedAt!: Date | null;
 @Column('varchar', { length: 500, nullable: true }) reason!: string | null;
 @Column('uuid', { nullable: true }) actorId!: string | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
