import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
export const UPDATE_CHANNELS = ['EMAIL', 'TELEGRAM'] as const;
export type UpdateChannel = typeof UPDATE_CHANNELS[number];
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

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
/** Outbox of status messages: written in the decision transaction, sent after it commits. Holds no message text. */
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
}
/** The last Telegram update already read, so each Start message is handled once. */
@Entity('telegram_poll_state')
export class TelegramPollState {
 @PrimaryColumn('smallint') id!: number;
 @Column('bigint') updateOffset!: string;
}
