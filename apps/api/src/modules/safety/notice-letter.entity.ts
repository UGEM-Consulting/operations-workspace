import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { DocumentField } from '../documents/fields';

/** The two letters before and after a rejection based on a background report (FCRA). Their text is the PDF's. */
export const NOTICE_KINDS = ['PRE_ADVERSE', 'FINAL'] as const;
export type NoticeKind = typeof NOTICE_KINDS[number];
export const NOTICE_LABELS: Record<NoticeKind, string> = { PRE_ADVERSE: 'Pre-adverse notice letter', FINAL: 'Final notice letter' };
/** URL segments for a driver's filled-in letter. */
export const NOTICE_SEGMENTS: Record<string, NoticeKind> = { 'pre-adverse': 'PRE_ADVERSE', final: 'FINAL' };

/** A published letter version. Immutable (a database trigger refuses changes); a new upload is a new version. */
@Entity('driver_notice_letters')
export class DriverNoticeLetter {
 @PrimaryColumn('uuid') id!: string;
 @Column('varchar') kind!: NoticeKind;
 @Column('integer') version!: number;
 @Column('varchar', { length: 200 }) title!: string;
 @Column('char', { length: 64 }) sha256!: string;
 @Column('integer') byteSize!: number;
 @Column('integer') pageCount!: number;
 // Where the driver's name, address and the date go. Set when it is published.
 @Column('jsonb', { default: [] }) fields!: DocumentField[];
 @Column('uuid') uploadedBy!: string;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
