import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const PROVIDERS = ['DAT', 'TRUCKSTOP'] as const;
export type Provider = typeof PROVIDERS[number];
export const PROVIDER_LABELS: Record<Provider, string> = { DAT: 'DAT', TRUCKSTOP: 'Truckstop' };
export type SeatStatus = 'ACTIVE' | 'SUSPENDED' | 'ENDED';
export type SeatEnd = 'ENDED' | 'MOVED' | 'LEFT';

/**
 * One of the company's DAT or Truckstop accounts (section 33), under one of our MCs (an archived one is fine) or another
 * company name. IT and administrators keep the list; archived, never deleted. "<provider> account not recorded" holds the
 * sign-ins recorded before the list, to be moved to their real account.
 */
@Entity('load_board_accounts')
export class LoadBoardAccount {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('varchar') provider!: Provider;
 @Column('varchar', { length: 100 }) name!: string;
 @Column('varchar', { length: 100 }) nameKey!: string;
 @Column('uuid', { nullable: true }) mcId!: string | null;
 @Column('varchar', { length: 100, nullable: true }) companyName!: string | null;
 @Column('boolean', { default: false }) placeholder!: boolean;
 @Column('timestamptz', { nullable: true }) archivedAt!: Date | null;
 @Column('integer', { default: 1 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

/**
 * Someone's access to a load board account: the sign-in email they use there (any email; never a password). Suspend keeps
 * it, Move ends it and opens one on another account, End closes it; ended seats stay as history. A sign-in may be shared.
 */
@Entity('member_load_board_seats')
export class LoadBoardSeat {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('uuid') accountId!: string;
 @Column('varchar', { length: 254 }) signInEmail!: string;
 @Column('varchar', { default: 'ACTIVE' }) status!: SeatStatus;
 @Column('timestamptz') startedAt!: Date;
 @Column('timestamptz', { nullable: true }) suspendedAt!: Date | null;
 @Column('timestamptz', { nullable: true }) endedAt!: Date | null;
 @Column('varchar', { nullable: true }) endedHow!: SeatEnd | null;
 @Column('uuid', { nullable: true }) createdBy!: string | null;
 @Column('uuid', { nullable: true }) endedBy!: string | null;
 @Column('integer', { default: 1 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
