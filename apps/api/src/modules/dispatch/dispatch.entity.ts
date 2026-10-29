import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const POSITIONS = ['DISPATCHER', 'SUPPORT'] as const;
export type Position = typeof POSITIONS[number];
export const DISPATCH_EVENTS = ['MEMBER_MOVED', 'MEMBER_LEFT', 'MEMBER_UPDATED', 'TEAM_CREATED', 'TEAM_UPDATED', 'TEAM_ARCHIVED', 'TEAM_RESTORED'] as const;
export type DispatchEventType = typeof DISPATCH_EVENTS[number];

/** A dispatcher or support working for UGEM. A record only: dispatch members never sign in to the workspace. */
@Entity('dispatch_members')
export class DispatchMember {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid', { nullable: true }) applicationId!: string | null;
 @Column('varchar', { length: 100 }) firstName!: string;
 @Column('varchar', { length: 100 }) lastName!: string;
 @Column('varchar', { default: 'DISPATCHER' }) position!: Position;
 @Column('varchar', { default: 'ACTIVE' }) status!: 'ACTIVE' | 'LEFT';
 @Column('uuid', { nullable: true }) jobTitleId!: string | null;
 @Column('timestamptz') joinedAt!: Date;
 @Column('timestamptz', { nullable: true }) leftAt!: Date | null;
 @Column('integer', { default: 1 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

/** A team works for one MC and may have a lead, who is one of its members. */
@Entity('teams')
export class Team {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('varchar', { length: 100 }) name!: string;
 @Column('varchar', { length: 100 }) nameKey!: string;
 @Column('uuid') mcId!: string;
 @Column('uuid', { nullable: true }) leadMemberId!: string | null;
 @Column('timestamptz', { nullable: true }) archivedAt!: Date | null;
 @Column('integer', { default: 1 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

/** Where a member works (MC and team) from a date; the open row (no endedAt) is now. Moves add rows, never overwrite. */
@Entity('member_assignments')
export class MemberAssignment {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('uuid', { nullable: true }) mcId!: string | null;
 @Column('uuid', { nullable: true }) teamId!: string | null;
 @Column('timestamptz') startedAt!: Date;
 @Column('timestamptz', { nullable: true }) endedAt!: Date | null;
 @Column('varchar', { length: 500, nullable: true }) reason!: string | null;
 @Column('uuid', { nullable: true }) actorId!: string | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}

/** Who changed a member or team and which fields; never the values. */
@Entity('dispatch_events')
export class DispatchEvent {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid', { nullable: true }) memberId!: string | null;
 @Column('uuid', { nullable: true }) teamId!: string | null;
 @Column('varchar') event!: DispatchEventType;
 @Column('uuid', { nullable: true }) actorId!: string | null;
 @Column('jsonb', { default: {} }) metadata!: Record<string, unknown>;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
