import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const POSITIONS = ['DISPATCHER', 'SUPPORT'] as const;
export type Position = typeof POSITIONS[number];
export const DISPATCH_EVENTS = ['MEMBER_MOVED', 'MEMBER_LEFT', 'MEMBER_UPDATED', 'TEAM_CREATED', 'TEAM_UPDATED', 'TEAM_ARCHIVED', 'TEAM_RESTORED', 'CONTACT_ADDED', 'CONTACT_REMOVED', 'SUPPORT_REASSIGNED',
 'PROMOTION_REQUESTED', 'PROMOTION_APPROVED', 'PROMOTION_DECLINED', 'PROMOTION_CANCELLED', 'NOTICE_RECORDED', 'NOTICE_CHANGED', 'NOTICE_CANCELLED', 'ACCESS_REMOVAL_REQUESTED'] as const;
/** ONBOARDING from approval until IT completes setup; ACTIVE after that; LEFT is kept for history. */
export type MemberStatus = 'ONBOARDING' | 'ACTIVE' | 'LEFT';
export type DispatchEventType = typeof DISPATCH_EVENTS[number];

/** A dispatcher or support working for UGEM. A record only: dispatch members never sign in to the workspace. */
@Entity('dispatch_members')
export class DispatchMember {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid', { nullable: true }) applicationId!: string | null;
 @Column('varchar', { length: 100 }) firstName!: string;
 @Column('varchar', { length: 100 }) lastName!: string;
 @Column('varchar', { default: 'DISPATCHER' }) position!: Position;
 @Column('varchar', { default: 'ACTIVE' }) status!: MemberStatus;
 @Column('uuid', { nullable: true }) jobTitleId!: string | null;
 // The team lead's sign-in account, when this dispatcher has one (at most one record per account).
 @Column('uuid', { nullable: true }) accountUserId!: string | null;
 @Column('timestamptz') joinedAt!: Date;
 @Column('timestamptz', { nullable: true }) leftAt!: Date | null;
 // Why they left, as given when they were marked as left (staff text; never health or other private details).
 @Column('text', { nullable: true }) leftReason!: string | null;
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

/** Which dispatcher a support assists from a date; the open row (no endedAt) is now. Changes add rows, never overwrite. */
@Entity('member_support_links')
export class MemberSupportLink {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') supportId!: string;
 @Column('uuid') dispatcherId!: string;
 @Column('timestamptz') startedAt!: Date;
 @Column('timestamptz', { nullable: true }) endedAt!: Date | null;
 @Column('varchar', { length: 500, nullable: true }) reason!: string | null;
 @Column('uuid', { nullable: true }) actorId!: string | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}

/** Extra emails and phone numbers staff add to a member. Removing one keeps the row with who and when. */
@Entity('member_contacts')
export class MemberContact {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('varchar') kind!: 'EMAIL' | 'PHONE';
 @Column('varchar', { length: 254 }) value!: string;
 @Column('varchar', { length: 50, nullable: true }) label!: string | null;
 @Column('uuid', { nullable: true }) addedBy!: string | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @Column('timestamptz', { nullable: true }) removedAt!: Date | null;
 @Column('uuid', { nullable: true }) removedBy!: string | null;
}

/** A team lead asks for a support in their team to become a dispatcher; a manager approves or declines. */
@Entity('promotion_requests')
export class PromotionRequest {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') supportId!: string;
 @Column('uuid', { nullable: true }) requestedBy!: string | null;
 @Column('varchar', { length: 1000 }) reason!: string;
 @Column('varchar', { default: 'PENDING' }) status!: 'PENDING' | 'APPROVED' | 'DECLINED' | 'CANCELLED';
 @Column('uuid', { nullable: true }) decidedBy!: string | null;
 @Column('timestamptz', { nullable: true }) decidedAt!: Date | null;
 @Column('varchar', { length: 1000, nullable: true }) note!: string | null;
 @Column('uuid', { nullable: true }) itRequestId!: string | null;
 @Column('integer', { default: 1 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
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

/** A future last day. The dispatcher stays Active until the last day has passed and everyone is reassigned; one open per member. */
@Entity('member_notices')
export class MemberNotice {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('date') lastDay!: string;
 @Column('text') reason!: string;
 @Column('uuid') recordedBy!: string;
 // Each change of the last day: from, to, why, who and when.
 @Column('jsonb', { default: [] }) changes!: { from: string; to: string; reason: string; by: string; at: string }[];
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
 @Column('timestamptz', { nullable: true }) cancelledAt!: Date | null;
 @Column('uuid', { nullable: true }) cancelledBy!: string | null;
 @Column('text', { nullable: true }) cancelReason!: string | null;
 @Column('timestamptz', { nullable: true }) finishedAt!: Date | null;
}
