import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
export const UPDATE_CHANNELS = ['EMAIL', 'TELEGRAM'] as const;
export type UpdateChannel = typeof UPDATE_CHANNELS[number];
// SENDING: claimed by one sender at claimedAt; the sweeper reclaims stale claims.
export type DeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

/** How an applicant wants to hear about decisions. No row means the default: email only. */
@Entity('applicant_update_settings')
export class ApplicantUpdateSettings {
 @PrimaryColumn('uuid') applicationId!: string;
 @Column('boolean') email!: boolean;
 @Column('boolean') telegram!: boolean;
 // The private chat the applicant connected by pressing Start on the company bot.
 @Column('varchar', { length: 32, nullable: true }) telegramChatId!: string | null;
 @Column('varchar', { length: 32, nullable: true }) telegramUsername!: string | null;
 @Column('timestamptz', { nullable: true }) telegramLinkedAt!: Date | null;
 @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
/** One-time Telegram connect links. Only the SHA-256 of the token is stored. */
@Entity('telegram_link_tokens')
export class TelegramLinkToken {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') applicationId!: string;
 @Column('char', { length: 64 }) tokenHash!: string;
 @Column('timestamptz') expiresAt!: Date;
 @Column('timestamptz', { nullable: true }) consumedAt!: Date | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
/** Outbox of status messages: written in the decision transaction, sent after it commits, redelivered by a sweeper. Holds no message text. */
@Entity('applicant_update_deliveries')
export class ApplicantUpdateDelivery {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') applicationId!: string;
 @Column('uuid') reviewId!: string;
 @Column('varchar') channel!: UpdateChannel;
 @Column('varchar') status!: DeliveryStatus;
 @Column('varchar', { length: 32, nullable: true }) failureCode!: string | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @Column('timestamptz', { nullable: true }) sentAt!: Date | null;
 @Column('integer', { default: 0 }) attempts!: number;
 @Column('timestamptz', { nullable: true }) claimedAt!: Date | null;
}
/** The last Telegram update already read, so each Start message is handled once. */
@Entity('telegram_poll_state')
export class TelegramPollState {
 @PrimaryColumn('smallint') id!: number;
 @Column('bigint') updateOffset!: string;
}
/** A staff member's private chat with the company bot, for workspace alerts. One chat belongs to one person. */
@Entity('staff_telegram_links')
export class StaffTelegramLink {
 @PrimaryColumn('uuid') userId!: string;
 @Column('varchar', { length: 32 }) chatId!: string;
 @Column('varchar', { length: 32, nullable: true }) username!: string | null;
 @Column('timestamptz') linkedAt!: Date;
}
/** One-time staff connect links (Account security). Only the SHA-256 of the token is stored. */
@Entity('staff_telegram_link_tokens')
export class StaffTelegramLinkToken {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') userId!: string;
 @Column('char', { length: 64 }) tokenHash!: string;
 @Column('timestamptz') expiresAt!: Date;
 @Column('timestamptz', { nullable: true }) consumedAt!: Date | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
export const NOTIFICATION_KINDS = ['SETUP_COMPLETE', 'REVIEW_WAITING', 'IT_SETUP_WAITING'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
/**
 * Outbox for notifications other than applicant decisions: written in the transaction that causes them, sent after it
 * commits and redelivered by a sweeper. The recipient is an applicant (applicationId) or a staff user (recipientId);
 * referenceId is the record the message points to. Holds no message text or addresses.
 */
@Entity('notification_deliveries')
export class NotificationDelivery {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('varchar', { length: 20 }) kind!: NotificationKind;
 @Column('uuid', { nullable: true }) applicationId!: string | null;
 @Column('uuid', { nullable: true }) recipientId!: string | null;
 @Column('uuid') referenceId!: string;
 @Column('varchar', { length: 10 }) channel!: UpdateChannel;
 @Column('varchar', { length: 10 }) status!: DeliveryStatus;
 @Column('varchar', { length: 32, nullable: true }) failureCode!: string | null;
 @Column('integer', { default: 0 }) attempts!: number;
 @Column('timestamptz', { nullable: true }) claimedAt!: Date | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @Column('timestamptz', { nullable: true }) sentAt!: Date | null;
}
