import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import type { StorageLayout } from '../storage/storage.service';
import type { SignatureMethod } from '../documents/documents.entity';
import type { DocumentField } from '../documents/fields';
import type { LicenseRules } from './license-rules';

/**
 * The driver consent forms Safety publishes. The disclosure is acknowledged as read; the others are signed. A kind is
 * required from the drivers it applies to (their license, license-rules.ts) once a version of it is published: the
 * Clearinghouse consent and the DOT testing authorization from CDL drivers, the PSP form (FMCSA's exact wording, on its
 * own) from CDL drivers and anyone who once held a CDL, and the application certification from every driver, signed last.
 * The legal text is the PDF's; the workspace stores only its own short statements. New kinds go at the end: the publishing
 * advisory lock uses each kind's position.
 */
export const CONSENT_KINDS = ['BACKGROUND_DISCLOSURE', 'BACKGROUND_AUTHORIZATION', 'CLEARINGHOUSE_CONSENT', 'PSP_AUTHORIZATION', 'DOT_TESTING_AUTHORIZATION', 'APPLICATION_CERTIFICATION', 'CONTRACTOR_ACKNOWLEDGEMENT'] as const;
export type ConsentKind = typeof CONSENT_KINDS[number];
const everyone = () => true;
// contract: signed per truck by the driver and then the truck owner (section 39, contracts.ts), never in an application or catch-up.
// application: certifies the application itself, so a driver added from a paper file (no application) is never asked for it.
export const CONSENT_RULES: Record<ConsentKind, { label: string; signature: boolean; appliesTo: (rules: LicenseRules) => boolean; contract?: true; application?: true }> = {
 BACKGROUND_DISCLOSURE: { label: 'Background check disclosure', signature: false, appliesTo: everyone },
 BACKGROUND_AUTHORIZATION: { label: 'Background check authorization', signature: true, appliesTo: everyone },
 CLEARINGHOUSE_CONSENT: { label: 'Clearinghouse consent', signature: true, appliesTo: rules => rules.clearinghouse },
 PSP_AUTHORIZATION: { label: 'PSP disclosure and authorization', signature: true, appliesTo: rules => rules.psp },
 DOT_TESTING_AUTHORIZATION: { label: 'DOT drug and alcohol testing authorization', signature: true, appliesTo: rules => rules.dotTesting },
 APPLICATION_CERTIFICATION: { label: 'Application certification', signature: true, appliesTo: everyone, application: true },
 CONTRACTOR_ACKNOWLEDGEMENT: { label: 'Driver and Contractor Acknowledgement', signature: true, appliesTo: () => false, contract: true },
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
 // Where this version's signing fields go. Set when it is published.
 @Column('jsonb', { default: [] }) fields!: DocumentField[];
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
