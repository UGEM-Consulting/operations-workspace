import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const LISTS = ['MC', 'JOB_TITLE'] as const;
export type ListKind = typeof LISTS[number];
export const LIST_EVENTS = ['CREATED', 'UPDATED', 'ARCHIVED', 'RESTORED'] as const;
export type ListEventType = typeof LIST_EVENTS[number];
/** Load board accounts (section 33) keep their events here too. */
export type ListEventList = ListKind | 'LOAD_BOARD_ACCOUNT';

/** Names compare ignoring case and repeated spaces, so "Northwind  freight" and "Northwind Freight" are one entry. */
export function listName(value: string) { return value.trim().replace(/\s+/g, ' '); }
export function listNameKey(value: string) { return listName(value).toLowerCase(); }
/** "Independent" is never an MC: it's a team choice under an MC (section 31). An older page may still send it as one. */
export const isIndependent = (value: string | undefined) => listNameKey(value ?? '') === 'independent';
export const INDEPENDENT_NOT_MC = { staff: 'Independent isn’t an MC. Choose the MC they dispatch for; Independent is chosen as their team.',
 applicant: 'Independent isn’t an MC. Choose the MC you dispatch for, then Independent (no team) as your team.' };

@Entity('mcs')
export class Mc {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('varchar', { length: 100 }) name!: string;
 @Column('varchar', { length: 100 }) nameKey!: string;
 @Column('varchar', { length: 8, nullable: true }) mcNumber!: string | null;
 @Column('varchar', { length: 8, nullable: true }) dotNumber!: string | null;
 @Column('timestamptz', { nullable: true }) archivedAt!: Date | null;
 @Column('integer', { default: 1 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

@Entity('job_titles')
export class JobTitle {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('varchar', { length: 100 }) name!: string;
 @Column('varchar', { length: 100 }) nameKey!: string;
 @Column('timestamptz', { nullable: true }) archivedAt!: Date | null;
 @Column('integer', { default: 1 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

/** Who changed which list item and which fields; never the values. */
@Entity('list_events')
export class ListEvent {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('varchar') list!: ListEventList;
 @Column('uuid') itemId!: string;
 @Column('uuid', { nullable: true }) actorId!: string | null;
 @Column('varchar') event!: ListEventType;
 @Column('jsonb', { default: {} }) metadata!: Record<string, unknown>;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
