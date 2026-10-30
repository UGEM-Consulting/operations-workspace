import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

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
export const DRIVER_EVENTS = ['CREATED', 'UPDATED', 'WITHDRAWN', 'REOPENED', 'SAFETY_LEAD_CHANGED', 'OWNER_ASSIGNED'] as const;
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
