import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const LISTS = ['MC', 'JOB_TITLE'] as const;
export type ListKind = typeof LISTS[number];
export const LIST_EVENTS = ['CREATED', 'UPDATED', 'ARCHIVED', 'RESTORED'] as const;
export type ListEventType = typeof LIST_EVENTS[number];

/** Names compare ignoring case and repeated spaces, so "Northwind  freight" and "Northwind Freight" are one entry. */
export function listName(value: string) { return value.trim().replace(/\s+/g, ' '); }
export function listNameKey(value: string) { return listName(value).toLowerCase(); }

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
 @Column('varchar') list!: ListKind;
 @Column('uuid') itemId!: string;
 @Column('uuid', { nullable: true }) actorId!: string | null;
 @Column('varchar') event!: ListEventType;
 @Column('jsonb', { default: {} }) metadata!: Record<string, unknown>;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
