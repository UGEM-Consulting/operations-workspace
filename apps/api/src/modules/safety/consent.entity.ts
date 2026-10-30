import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import type { StorageLayout } from '../storage/storage.service';
import type { SignatureMethod } from '../documents/documents.entity';

/**
 * The driver consent forms Safety publishes. The disclosure is acknowledged as read; the authorization and the
 * Clearinghouse consent are signed. A kind is required from drivers once a version of it is published. The legal text
 * is the PDF's; the workspace stores only its own short statements.
 */
export const CONSENT_KINDS = ['BACKGROUND_DISCLOSURE', 'BACKGROUND_AUTHORIZATION', 'CLEARINGHOUSE_CONSENT'] as const;
export type ConsentKind = typeof CONSENT_KINDS[number];
export const CONSENT_RULES: Record<ConsentKind, { label: string; signature: boolean }> = {
 BACKGROUND_DISCLOSURE: { label: 'Background check disclosure', signature: false },
 BACKGROUND_AUTHORIZATION: { label: 'Background check authorization', signature: true },
 CLEARINGHOUSE_CONSENT: { label: 'Clearinghouse consent', signature: true },
};

/** A published consent form version. Immutable (a database trigger refuses changes); a new upload is a new version. */
@Entity('driver_consent_documents')
export class DriverConsentDocument {
 @PrimaryColumn('uuid') id!: string;
 @Column('varchar') kind!: ConsentKind;
 @Column('integer') version!: number;
 @Column('varchar', { length: 200 }) title!: string;
 @Column('char', { length: 64 }) sha256!: string;
 @Column('integer') byteSize!: number;
 @Column('integer') pageCount!: number;
 @Column('uuid') uploadedBy!: string;
 @Column('smallint', { default: 1 }) storageLayout!: StorageLayout;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}

/** Evidence that the driver opened the full form from their application before signing; only the first time is kept. */
@Entity('driver_consent_views')
export class DriverConsentView {
 @PrimaryColumn('uuid') driverId!: string;
 @PrimaryColumn('uuid') documentId!: string;
 @CreateDateColumn({ type: 'timestamptz' }) firstViewedAt!: Date;
}

/** A driver's signature or acknowledgement of one form version. Append-only signing evidence. */
@Entity('driver_consent_signatures')
export class DriverConsentSignature {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') driverId!: string;
 @Column('uuid') documentId!: string;
 @Column('varchar', { length: 200 }) typedName!: string;
 @Column('bytea', { nullable: true, select: false }) signatureImage!: Buffer | null;
 @Column('varchar', { nullable: true }) signatureMethod!: SignatureMethod | null;
 @Column('text') consent!: string;
 @Column('text') statement!: string;
 @Column('char', { length: 64 }) documentSha256!: string;
 @Column('varchar', { length: 64, nullable: true }) ipAddress!: string | null;
 @Column('varchar', { length: 500, nullable: true }) userAgent!: string | null;
 @CreateDateColumn({ type: 'timestamptz' }) signedAt!: Date;
}

// The exact wording is stored with every signature, so changing it here never alters past evidence.
export const DRIVER_ESIGN_CONSENT = 'I agree to receive, review and sign these forms electronically. I understand that my electronic signature has the same legal effect as a handwritten signature, that I may ask UGEM Safety for a paper copy instead, and that I can download a signed copy after signing.';
export function consentStatement(document: Pick<DriverConsentDocument, 'kind' | 'title' | 'version'>): string {
 const name = `${document.title} (version ${document.version})`;
 if (!CONSENT_RULES[document.kind].signature) return `I have opened and read the entire ${name}.`;
 return `I have read the entire ${name} and I agree to it. I intend my typed name and my signature (drawn, or adopted from my typed name) to be my legally binding electronic signature.`;
}
