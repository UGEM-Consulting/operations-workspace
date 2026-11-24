import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const ACCOUNT_STATUSES = ['ACTIVE', 'KEPT_FOR_LOAD_BOARDS', 'CLOSED'] as const;
export type AccountStatus = typeof ACCOUNT_STATUSES[number];
// What they were at that company (section 40): empty when nobody knows, as for accounts recorded before.
export const ACCOUNT_POSITIONS = ['DISPATCHER', 'SUPPORT', 'UPDATER'] as const;
export type AccountPosition = typeof ACCOUNT_POSITIONS[number];

/**
 * An account someone has, or had, at another of our companies (section 33): the MC (or another company's name), the
 * American name used there, and its email, RingCentral number and extension. Kept for load boards is an email left open
 * because it signs in to a load board seat; Closed keeps the row as history. Their main accounts stay where IT setup and the
 * manager's record keep them.
 */
@Entity('member_company_accounts')
export class CompanyAccount {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('uuid', { nullable: true }) mcId!: string | null;
 @Column('varchar', { length: 100, nullable: true }) companyName!: string | null;
 @Column('varchar', { length: 100, nullable: true }) nameUsed!: string | null;
 @Column('varchar', { length: 10, nullable: true }) position!: AccountPosition | null;
 @Column('varchar', { length: 254, nullable: true }) companyEmail!: string | null;
 @Column('varchar', { length: 40, nullable: true }) ringCentralNumber!: string | null;
 @Column('varchar', { length: 6, nullable: true }) ringCentralExtension!: string | null;
 @Column('varchar', { default: 'ACTIVE' }) status!: AccountStatus;
 @Column('timestamptz', { nullable: true }) closedAt!: Date | null;
 @Column('uuid', { nullable: true }) closedBy!: string | null;
 @Column('varchar', { length: 200, nullable: true }) sourceName!: string | null;
 // What staff should know about the account (section 36), with who wrote it and when. Never passwords.
 @Column('varchar', { length: 500, nullable: true }) note!: string | null;
 @Column('uuid', { nullable: true }) noteBy!: string | null;
 @Column('timestamptz', { nullable: true }) noteAt!: Date | null;
 @Column('uuid', { nullable: true }) createdBy!: string | null;
 @Column('integer', { default: 1 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
