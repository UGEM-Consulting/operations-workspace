import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const DRIVER_TYPES = ['COMPANY', 'OWNER_OPERATOR'] as const;
export type DriverType = typeof DRIVER_TYPES[number];
export const LICENSE_TYPES = ['CDL_A', 'CDL_B', 'CDL_C', 'DL'] as const;
export type LicenseType = typeof LICENSE_TYPES[number];
// LEAD → APPLYING → SCREENING → AWAITING_DECISION → APPROVED → CLEARED; REJECTED, WITHDRAWN and LEFT close the record.
// Statuses after LEAD are reached by later slices (application link, screening, decision, clearance).
export const DRIVER_STATUSES = ['LEAD', 'APPLYING', 'SCREENING', 'AWAITING_DECISION', 'APPROVED', 'CLEARED', 'REJECTED', 'WITHDRAWN', 'LEFT'] as const;
export type DriverStatus = typeof DRIVER_STATUSES[number];
export const CLOSED_STATUSES: readonly DriverStatus[] = ['REJECTED', 'WITHDRAWN', 'LEFT'];
/** Statuses a driver can be withdrawn from: anything before the Safety manager's approval. */
export const WITHDRAWABLE: readonly DriverStatus[] = ['LEAD', 'APPLYING', 'SCREENING', 'AWAITING_DECISION'];
/** A safety staff owner is assigned once the Safety manager has approved the driver. */
export const OWNABLE: readonly DriverStatus[] = ['APPROVED', 'CLEARED'];
export const DRIVER_EVENTS = ['CREATED', 'UPDATED', 'WITHDRAWN', 'REOPENED', 'SAFETY_LEAD_CHANGED', 'OWNER_ASSIGNED',
 'LINK_SENT', 'LINK_CANCELLED', 'APPLICATION_VERIFIED', 'APPLICATION_SUBMITTED', 'SSN_REVEALED', 'DOCUMENT_UPLOADED', 'DOCUMENT_VERIFIED', 'DOCUMENT_VIEWED'] as const;
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
 @Column('text', { nullable: true, select: false }) ssnCiphertext!: string | null;
 @Column('varchar', { length: 4, nullable: true }) ssnLast4!: string | null;
 @Column('integer', { default: 1 }) version!: number;
 @Column('timestamptz', { nullable: true }) submittedAt!: Date | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

export const DRIVER_DOCUMENT_KINDS = ['LICENSE', 'MEDICAL_CARD', 'WORK_AUTHORIZATION'] as const;
export type DriverDocumentKind = typeof DRIVER_DOCUMENT_KINDS[number];
/** The driver chooses which work-authorization document to provide; Safety never demands a specific one. */
export const WORK_AUTHORIZATION_TYPES = ['US_PASSPORT', 'GREEN_CARD', 'WORK_PERMIT', 'OTHER'] as const;
export type WorkAuthorizationType = typeof WORK_AUTHORIZATION_TYPES[number];
/** URL segments for document kinds (driver/documents/<segment>). */
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
 @Column('timestamptz', { nullable: true }) verifiedAt!: Date | null;
 @Column('uuid', { nullable: true }) verifiedBy!: string | null;
 @Column('varchar', { length: 40, nullable: true }) number!: string | null;
 @Column('date', { nullable: true }) expiresOn!: string | null;
 // Bumped by each verification, so two people recording the same document can't silently overwrite each other.
 @Column('integer', { default: 1 }) version!: number;
}
