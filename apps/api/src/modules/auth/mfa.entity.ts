import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
/** TOTP: an authenticator app. EMAIL: single-use codes sent to the account email (never for administrators). */
export enum MfaMethod { TOTP = 'TOTP', EMAIL = 'EMAIL' }
// Staff two-step verification. TOTP secrets are AES-256-GCM ciphertext; recovery codes are Argon2id hashes.
@Entity('staff_mfa')
export class StaffMfa {
  @PrimaryColumn('uuid') userId!: string;
  @Column({ type: 'varchar', length: 10, default: MfaMethod.TOTP }) method!: MfaMethod;
  // NULL for email codes.
  @Column({ type: 'text', nullable: true, select: false }) secretCiphertext!: string | null;
  // NULL while enrolment awaits its first confirming code.
  @Column({ type: 'timestamptz', nullable: true }) confirmedAt!: Date | null;
  // Highest accepted TOTP time step; codes for this or earlier steps are replays.
  @Column({ type: 'bigint', nullable: true, select: false }) lastUsedStep!: string | null;
  // A new authenticator being set up while this one stays in use (NewAuthenticator1793120000000), until its first code is confirmed.
  @Column({ type: 'text', nullable: true, select: false }) pendingSecretCiphertext!: string | null;
  @Column({ type: 'timestamptz', nullable: true, select: false }) pendingCreatedAt!: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
@Entity('staff_mfa_recovery_codes')
export class StaffRecoveryCode {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('uuid') userId!: string;
  @Column({ type: 'text', select: false }) codeHash!: string;
  @Column({ type: 'timestamptz', nullable: true }) usedAt!: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
export enum SecurityEventType {
  MFA_ENROLLED = 'MFA_ENROLLED', MFA_DISABLED = 'MFA_DISABLED', MFA_RESET_BY_ADMIN = 'MFA_RESET_BY_ADMIN',
  MFA_RECOVERY_CODE_USED = 'MFA_RECOVERY_CODE_USED', MFA_RECOVERY_CODES_REGENERATED = 'MFA_RECOVERY_CODES_REGENERATED',
  MFA_LOCKED_OUT = 'MFA_LOCKED_OUT', MFA_POLICY_CHANGED = 'MFA_POLICY_CHANGED', MFA_AUTHENTICATOR_REPLACED = 'MFA_AUTHENTICATOR_REPLACED',
  // Account administration (actor = administrator) and self-service password changes. Field names only, never values.
  USER_CREATED = 'USER_CREATED', USER_ROLE_CHANGED = 'USER_ROLE_CHANGED', USER_STATUS_CHANGED = 'USER_STATUS_CHANGED',
  USER_EMAIL_CHANGED = 'USER_EMAIL_CHANGED', USER_NAME_CHANGED = 'USER_NAME_CHANGED', USER_PASSWORD_SET = 'USER_PASSWORD_SET',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  // Saved countersigning signature: saved or replaced, deleted by its owner, or cleared by an account change.
  STAFF_SIGNATURE_SAVED = 'STAFF_SIGNATURE_SAVED', STAFF_SIGNATURE_DELETED = 'STAFF_SIGNATURE_DELETED', STAFF_SIGNATURE_CLEARED = 'STAFF_SIGNATURE_CLEARED',
  // Devices that skip the sign-in code for 30 days: one trusted, or one or all forgotten (count only; replacedOther when this
  // browser's earlier cookie belonged to someone else).
  TRUSTED_DEVICE_ADDED = 'TRUSTED_DEVICE_ADDED', TRUSTED_DEVICE_FORGOTTEN = 'TRUSTED_DEVICE_FORGOTTEN',
  // A sign-in that skipped the code on a trusted device. Kept after the device is forgotten, for looking back after an incident.
  TRUSTED_DEVICE_USED = 'TRUSTED_DEVICE_USED',
}
// Metadata only: never codes, secrets, session identifiers or addresses.
@Entity('staff_security_events')
export class StaffSecurityEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('uuid') userId!: string;
  @Column({ type: 'uuid', nullable: true }) actorId!: string | null;
  @Column({ type: 'varchar', length: 40 }) type!: SecurityEventType;
  @Column({ type: 'jsonb', default: {} }) metadata!: Record<string, string | number | boolean | null | string[]>;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
export enum MfaPolicy { ADMINS = 'ADMINS', ALL_STAFF = 'ALL_STAFF' }
@Entity('staff_security_settings')
export class StaffSecuritySettings {
  @PrimaryColumn({ type: 'smallint', default: 1 }) id!: number;
  @Column({ type: 'varchar', length: 20, default: MfaPolicy.ADMINS }) mfaRequiredFor!: MfaPolicy;
  @Column({ type: 'uuid', nullable: true }) updatedById!: string | null;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
