export interface EmploymentAssignments { mcName: string; teamLead: string; jobTitle: string; }
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
export const APPLICATION_STATUSES = ['INVITED', 'DRAFT', 'SUBMITTED', 'CHANGES_REQUESTED', 'RESUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type ApplicationStatus = typeof APPLICATION_STATUSES[number];
export const CORRECTION_FIELDS = ['firstName', 'lastName', 'personalPhoneNumber', 'workPhoneNumber', 'preferredAmericanFirstName', 'preferredAmericanLastName', 'telegram', 'mcName', 'teamLead', 'jobTitle'] as const;
export type CorrectionField = typeof CORRECTION_FIELDS[number];
export type DecisionType = 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT';
export interface ApplicationFields { firstName?: string; lastName?: string; personalPhoneNumber?: string; workPhoneNumber?: string; preferredAmericanFirstName?: string; preferredAmericanLastName?: string; telegram?: string; mcName?: string; teamLead?: string; jobTitle?: string; }
@Entity('invitations')
export class Invitation {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') managerId!: string;
 @Column('varchar', { nullable: true }) email!: string | null;
 @Column('varchar', { nullable: true }) expectedEmail!: string | null;
 @Column({ select: false }) tokenHash!: string;
 @Column('varchar', { nullable: true }) mcName!: string | null;
 @Column('varchar', { nullable: true }) teamLead!: string | null;
 @Column('varchar', { nullable: true }) jobTitle!: string | null;
 @Column() telegramRequired!: boolean;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @Column('timestamptz') expiresAt!: Date;
 @Column('timestamptz', { nullable: true }) openedAt!: Date | null;
 @Column('timestamptz', { nullable: true }) consumedAt!: Date | null;
 @Column('timestamptz', { nullable: true }) revokedAt!: Date | null;
 @Column('timestamptz', { nullable: true }) completedAt!: Date | null;
}
@Entity('dispatcher_applications')
export class DispatcherApplication {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') invitationId!: string;
 @Column('uuid') assignedManagerId!: string;
 @Column('varchar') status!: ApplicationStatus;
 @Column('jsonb', { default: {} }) fields!: ApplicationFields;
 @Column({ default: 0 }) version!: number;
 @Column('timestamptz') applicantAccessUntil!: Date;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
 @Column('timestamptz', { nullable: true }) submittedAt!: Date | null;
}
@Entity('applicant_challenges')
export class ApplicantChallenge {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid', { nullable: true }) invitationId!: string | null;
 @Column() resume!: boolean;
 @Column('varchar', { nullable: true }) email!: string | null;
 @Column('varchar', { nullable: true, select: false }) codeHash!: string | null;
 @Column('timestamptz') expiresAt!: Date;
 @Column('timestamptz', { nullable: true }) consumedAt!: Date | null;
}
@Entity('application_activity')
export class ApplicationActivity {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') invitationId!: string;
 @Column('uuid', { nullable: true }) actorId!: string | null;
 @Column() event!: string;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}

@Entity('application_reviews')
export class ApplicationReview {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') applicationId!: string;
 @Column('uuid') reviewerId!: string;
 @Column('varchar') decisionType!: DecisionType;
 @Column('text', { nullable: true }) reason!: string | null;
 @Column('jsonb') requestedFields!: CorrectionField[];
 @Column('varchar') previousStatus!: ApplicationStatus;
 @Column('varchar') newStatus!: ApplicationStatus;
 @Column('integer') applicationVersion!: number;
 @Column('jsonb', { nullable: true }) employment!: EmploymentAssignments | null;
 @Column('jsonb', { nullable: true }) previousEmployment!: Partial<EmploymentAssignments> | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
// Submission data belongs in a restricted revision table, never in event/audit payloads.
@Entity('application_submissions')
export class ApplicationSubmission {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') applicationId!: string;
 @Column('integer') version!: number;
 @Column('jsonb') fields!: ApplicationFields;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
