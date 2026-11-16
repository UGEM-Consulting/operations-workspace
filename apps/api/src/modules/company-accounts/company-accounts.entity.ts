import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const ACCOUNT_STATUSES = ['ACTIVE', 'KEPT_FOR_LOAD_BOARDS', 'CLOSED'] as const;
export type AccountStatus = typeof ACCOUNT_STATUSES[number];

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
 @Column('varchar', { length: 254, nullable: true }) companyEmail!: string | null;
 @Column('varchar', { length: 40, nullable: true }) ringCentralNumber!: string | null;
 @Column('varchar', { length: 6, nullable: true }) ringCentralExtension!: string | null;
 @Column('varchar', { default: 'ACTIVE' }) status!: AccountStatus;
 @Column('timestamptz', { nullable: true }) closedAt!: Date | null;
 @Column('uuid', { nullable: true }) closedBy!: string | null;
 @Column('varchar', { length: 200, nullable: true }) sourceName!: string | null;
 @Column('uuid', { nullable: true }) createdBy!: string | null;
 @Column('integer', { default: 1 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
