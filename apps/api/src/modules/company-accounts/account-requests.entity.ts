import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { TaskStatus } from '../it/it.entity';

/**
 * What IT is asked to do with company accounts (section 33): CLOSE one account at another company, or, when someone MOVEs to
 * another MC, create their accounts there and close the old ones (an email that still signs in to a load board seat is kept).
 */
export type AccountRequestKind = 'CLOSE' | 'MOVE';
export const ACCOUNT_TASKS = [
 { key: 'NEW_EMAIL', label: 'New company email', description: 'Create their email at the new MC and record it here.' },
 { key: 'NEW_NUMBER', label: 'New RingCentral number', description: 'Give them a number at the new MC and record it here.' },
 { key: 'CLOSE_EMAIL', label: 'Close the email', description: 'Suspend it and sign it out everywhere.' },
 { key: 'CLOSE_NUMBER', label: 'Close the number', description: 'Remove the RingCentral user, and record what happens to the number in the notes.' },
 { key: 'SHARED_PASSWORDS', label: 'Shared passwords', description: 'Change any shared password sent to this email.' },
] as const;
export type AccountTaskKey = typeof ACCOUNT_TASKS[number]['key'];
/** What IT reads: whose accounts, and what to close, keep and create. Values for IT, never in events. */
export interface AccountRequestProfile {
 displayName: string; fromMc: string | null; toMc: string | null; fromMcId?: string | null; toMcId?: string | null;
 close: { label: string; value: string }[];
 keep: { value: string; reason: string }[];
 create: ('companyEmail' | 'ringCentralNumber')[];
}
@Entity('it_account_requests')
export class ItAccountRequest {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('varchar') kind!: AccountRequestKind;
 @Column('uuid', { nullable: true }) accountId!: string | null;
 // Who asked: they get the portal notice when IT finishes.
 @Column('uuid') managerId!: string;
 @Column('jsonb') profile!: AccountRequestProfile;
 @Column('varchar', { length: 500, nullable: true }) note!: string | null;
 @Column('varchar', { default: 'SUSPEND' }) emailAfter!: 'FORWARD' | 'SUSPEND';
 @Column('uuid', { nullable: true }) forwardTo!: string | null;
 // A move's new accounts, as IT records them.
 @Column('varchar', { length: 254, nullable: true }) newCompanyEmail!: string | null;
 @Column('varchar', { length: 40, nullable: true }) newRingCentralNumber!: string | null;
 @Column('varchar', { length: 6, nullable: true }) newRingCentralExtension!: string | null;
 @Column('integer', { default: 0 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
 @Column('timestamptz', { nullable: true }) completedAt!: Date | null;
 @Column('timestamptz', { nullable: true }) cancelledAt!: Date | null;
}
@Entity('it_account_tasks')
export class ItAccountTask {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') requestId!: string;
 @Column('varchar') key!: AccountTaskKey;
 @Column('varchar') status!: TaskStatus;
 @Column('text', { default: '' }) notes!: string;
 @Column('uuid', { nullable: true }) updatedBy!: string | null;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
@Entity('it_account_activity')
export class ItAccountActivity {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') requestId!: string;
 @Column('uuid', { nullable: true }) actorId!: string | null;
 @Column('varchar') event!: string;
 @Column('jsonb', { default: {} }) metadata!: Record<string, string | boolean | null>;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
