import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Shown wherever an MC goes for someone who has none yet; never the same as Independent, which means they work with no MC. */
export const NO_MC = 'No MC yet';
export const POSITIONS = ['DISPATCHER', 'SUPPORT'] as const;
export type Position = typeof POSITIONS[number];
/** Two names for one position: a support or an updater assists one dispatcher or one whole team, and is treated alike. Only what they're called differs. */
export const SUPPORT_TYPES = ['SUPPORT', 'UPDATER'] as const;
export type SupportType = typeof SUPPORT_TYPES[number];
/** What someone is called, for what IT reads. */
export const positionLabel = (member: { position: Position; supportType: SupportType }) => member.position === 'DISPATCHER' ? 'Dispatcher' : member.supportType === 'UPDATER' ? 'Updater' : 'Support';
export const DISPATCH_EVENTS = ['MEMBER_MOVED', 'MEMBER_LEFT', 'MEMBER_UPDATED', 'TEAM_CREATED', 'TEAM_UPDATED', 'TEAM_ARCHIVED', 'TEAM_RESTORED', 'CONTACT_ADDED', 'CONTACT_REMOVED', 'SUPPORT_REASSIGNED',
 'PROMOTION_REQUESTED', 'PROMOTION_APPROVED', 'PROMOTION_DECLINED', 'PROMOTION_CANCELLED', 'NOTICE_RECORDED', 'NOTICE_CHANGED', 'NOTICE_CANCELLED', 'ACCESS_REMOVAL_REQUESTED', 'EXISTING_ADDED', 'EXISTING_UPDATED', 'CATCH_UP_LINK_CREATED', 'PAPERWORK_ACCEPTED', 'MEMBER_PLACED', 'START_DATE_RECORDED', 'SUPPORT_TYPE_CHANGED', 'DETAILS_CORRECTED', 'LEAVE_RECORDED', 'LEAVE_CHANGED', 'LEAVE_ENDED', 'PAPER_SCAN_ADDED', 'PAPER_SCAN_VIEWED', 'MEMBERS_EXPORTED'] as const;
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
 @Column('varchar', { default: 'SUPPORT' }) supportType!: SupportType;
 @Column('varchar', { default: 'ACTIVE' }) status!: MemberStatus;
 @Column('uuid', { nullable: true }) jobTitleId!: string | null;
 // The team lead's sign-in account, when this dispatcher has one (at most one record per account).
 @Column('uuid', { nullable: true }) accountUserId!: string | null;
 @Column('timestamptz') joinedAt!: Date;
 @Column('timestamptz', { nullable: true }) leftAt!: Date | null;
 // Why they left, as given when they were marked as left (staff text; never health or other private details).
 @Column('text', { nullable: true }) leftReason!: string | null;
 @Column('integer', { default: 1 }) version!: number;
 // Someone who left and came back (section 37): the record they left, kept as history. At most one later record each.
 @Column('uuid', { nullable: true }) previousMemberId!: string | null;
 // An administrator's corrections of what their application says (section 36). The application itself never changes.
 @Column('jsonb', { default: {} }) correctedDetails!: CorrectedDetails;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
export const CORRECTABLE_DETAILS = ['legalFirstName', 'legalLastName', 'preferredAmericanFirstName', 'preferredAmericanLastName', 'personalEmail', 'personalPhoneNumber', 'telegram'] as const;
export type CorrectableDetail = typeof CORRECTABLE_DETAILS[number];
export type CorrectedDetails = Partial<Record<CorrectableDetail, string | null>>;

/** Someone already working here when they were recorded: who added them and what a manager knows. acceptedAt is when their paperwork finished. */
@Entity('existing_member_records')
export class ExistingMemberRecord {
 @PrimaryColumn('uuid') memberId!: string;
 @Column('uuid') addedBy!: string;
 @Column('varchar', { length: 200, nullable: true }) sourceName!: string | null;
 @Column('varchar', { length: 254, nullable: true }) companyEmail!: string | null;
 @Column('varchar', { length: 40, nullable: true }) ringCentralNumber!: string | null;
 @Column('varchar', { length: 254, nullable: true }) personalEmail!: string | null;
 @Column('varchar', { length: 40, nullable: true }) personalPhone!: string | null;
 // A Telegram username (a record only: nothing is sent to it), a RingCentral extension, and load board sign-in emails, never passwords.
 @Column('varchar', { length: 32, nullable: true }) telegram!: string | null;
 @Column('varchar', { length: 6, nullable: true }) ringCentralExtension!: string | null;
 @Column('varchar', { length: 254, nullable: true }) datEmail!: string | null;
 @Column('varchar', { length: 254, nullable: true }) truckstopEmail!: string | null;
 @Column('timestamptz', { nullable: true }) acceptedAt!: Date | null;
 @Column('uuid', { nullable: true }) acceptedBy!: string | null;
 // False while joinedAt is only the day they were added, and while their first MC and team (or dispatcher) period has no date of its own.
 @Column('boolean', { default: true }) startDateKnown!: boolean;
 @Column('boolean', { default: true }) periodDateKnown!: boolean;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

/** A start date a manager added or corrected later, with the reason for a correction. */
@Entity('member_start_date_changes')
export class MemberStartDateChange {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('date') startedOn!: string;
 @Column('date', { nullable: true }) previousOn!: string | null;
 @Column('varchar', { length: 500, nullable: true }) reason!: string | null;
 @Column('uuid') actorId!: string;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}

/** An NDA or SOP signed on paper: the copy stays with the company; this records that it exists and who confirmed it. */
@Entity('member_paper_documents')
export class MemberPaperDocument {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('varchar') kind!: 'NDA' | 'SOP';
 @Column('date') signedOn!: string;
 @Column('uuid') recordedBy!: string;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
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

/** Which dispatcher, or which whole team, a support assists from a date (exactly one of them); the open row (no endedAt) is now. Changes add rows, never overwrite. */
@Entity('member_support_links')
export class MemberSupportLink {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') supportId!: string;
 @Column('uuid', { nullable: true }) dispatcherId!: string | null;
 @Column('uuid', { nullable: true }) teamId!: string | null;
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

/**
 * Time away with a return date (section 35): the person keeps their job and place, and their record stays ACTIVE. They're on
 * leave from the first day away (startedAt marks when the workspace acted on it) until the leave ends. One open per member.
 */
export type LeaveEnd = 'RETURNED' | 'CANCELLED' | 'LEAVING';
export interface LeaveChange { kind: 'BACK_ON' | 'REASON'; from: string | null; to: string | null; reason: string | null; by: string; byName: string; at: string }
@Entity('member_leaves')
export class MemberLeave {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('date') firstDay!: string;
 @Column('date') backOn!: string;
 // Staff text; never health, family or other private details.
 @Column('text') reason!: string;
 @Column('varchar', { nullable: true }) emailWhileAway!: 'FORWARD' | 'AUTO_REPLY' | null;
 @Column('varchar', { nullable: true }) callsWhileAway!: 'FORWARD' | 'VOICEMAIL' | null;
 @Column('uuid', { nullable: true }) forwardTo!: string | null;
 @Column('uuid') recordedBy!: string;
 @Column('jsonb', { default: [] }) changes!: LeaveChange[];
 @Column('timestamptz', { nullable: true }) startedAt!: Date | null;
 @Column('timestamptz', { nullable: true }) endedAt!: Date | null;
 @Column('varchar', { nullable: true }) endedHow!: LeaveEnd | null;
 @Column('uuid', { nullable: true }) endedBy!: string | null;
 @Column('integer', { default: 1 }) version!: number;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

/** An administrator's correction of a dispatcher's details (section 36): each field's earlier and new value, why, who and when. Staff only. */
@Entity('member_detail_corrections')
export class MemberDetailCorrection {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('jsonb') changes!: { field: string; from: string | null; to: string | null }[];
 @Column('varchar', { length: 500 }) reason!: string;
 @Column('uuid') actorId!: string;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
