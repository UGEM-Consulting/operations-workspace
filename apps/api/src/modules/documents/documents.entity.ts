import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
export const DOCUMENT_KINDS = ['NDA','SOP','CONTACT_LIST'] as const;
export type DocumentKind = typeof DOCUMENT_KINDS[number];
// NDA and SOP need a typed name plus a drawn or typed-name signature; the contact list only a read acknowledgement.
// The approving manager countersigns the NDA for the company.
export const DOCUMENT_RULES: Record<DocumentKind,{label:string;signature:boolean;countersign:boolean}> = {
 NDA:{label:'Non-Disclosure Agreement',signature:true,countersign:true},
 SOP:{label:'Dispatcher Standard Operating Procedures',signature:true,countersign:false},
 CONTACT_LIST:{label:'Quick Contact List',signature:false,countersign:false},
};
export const SIGNATURE_METHODS = ['DRAWN','TYPED'] as const;
export type SignatureMethod = typeof SIGNATURE_METHODS[number];
export const PHOTO_KINDS = ['SELFIE','ID_SELFIE'] as const;
export type PhotoKind = typeof PHOTO_KINDS[number];
// Company-wide document versions. Immutable once published; a new upload is a new version.
@Entity('company_documents')
export class CompanyDocument {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('varchar') kind!:DocumentKind;
 @Column('integer') version!:number;
 @Column('varchar',{length:200}) title!:string;
 @Column('char',{length:64}) sha256!:string;
 @Column('integer') byteSize!:number;
 @Column('integer') pageCount!:number;
 @Column('uuid') uploadedBy!:string;
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
}
// The plain selfie is the profile photo; the ID selfie is for manual manager verification only (no face matching).
// The applicant works with the current photo (replacedAt null). Staff see the latest photo created before the last
// submission, so replacements in an unsent correction stay private, like correction drafts.
@Entity('applicant_photos')
export class ApplicantPhoto {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') applicationId!:string;
 @Column('varchar') kind!:PhotoKind;
 @Column('char',{length:64}) sha256!:string;
 @Column('integer') byteSize!:number;
 // Set explicitly from the API clock, the same clock as submittedAt, which decides what staff see.
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
 @Column('timestamptz',{nullable:true}) replacedAt!:Date|null;
}
// Append-only signature evidence (a database trigger refuses UPDATE and DELETE).
@Entity('document_signatures')
export class DocumentSignature {
 @PrimaryGeneratedColumn('uuid') id!:string;
 @Column('uuid') applicationId!:string;
 @Column('uuid') documentId!:string;
 @Column('varchar') signerRole!:'APPLICANT'|'COMPANY';
 @Column('uuid',{nullable:true}) signerUserId!:string|null;
 @Column('varchar',{length:200}) typedName!:string;
 @Column('bytea',{nullable:true,select:false}) signatureImage!:Buffer|null;
 // DRAWN or TYPED (adopted from the typed name); null on rows before the column existed (drawn) and on acknowledgements.
 @Column('varchar',{nullable:true}) signatureMethod!:SignatureMethod|null;
 // A company countersignature applied from the signer's saved signature (the image is still copied into this row).
 @Column('boolean',{default:false}) fromSavedSignature!:boolean;
 @Column('text',{nullable:true}) consent!:string|null;
 @Column('text') statement!:string;
 @Column('text',{nullable:true}) translatedStatement!:string|null;
 @Column('char',{length:64}) documentSha256!:string;
 @Column('varchar',{length:64,nullable:true}) ipAddress!:string|null;
 @Column('varchar',{length:500,nullable:true}) userAgent!:string|null;
 @CreateDateColumn({type:'timestamptz'}) signedAt!:Date;
}
// Server-side evidence that the applicant opened the full document from the signing page before signing.
@Entity('document_views')
export class DocumentView {
 @PrimaryColumn('uuid') applicationId!:string;
 @PrimaryColumn('uuid') documentId!:string;
 @CreateDateColumn({type:'timestamptz'}) firstViewedAt!:Date;
}
// A manager's or administrator's own signature, saved for NDA countersigning. Shown only to its owner; applying it
// to a document copies the image into that document's signature row.
@Entity('staff_saved_signatures')
export class StaffSavedSignature {
 @PrimaryColumn('uuid') userId!:string;
 @Column('varchar',{length:100}) typedName!:string;
 @Column('bytea',{select:false}) signatureImage!:Buffer;
 @Column('varchar') signatureMethod!:SignatureMethod;
 @CreateDateColumn({type:'timestamptz'}) createdAt!:Date;
 @UpdateDateColumn({type:'timestamptz'}) updatedAt!:Date;
}
