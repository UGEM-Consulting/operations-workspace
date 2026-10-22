import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
@Entity('demo_mailbox')
export class DemoMailboxMessage {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('uuid') challengeId!: string;
  @Column('text', { select: false }) ciphertext!: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
