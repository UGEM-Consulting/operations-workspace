import { EntityManager, IsNull, LessThanOrEqual } from 'typeorm';
import type { DocumentItem } from '../onboarding/entities';
import { ApplicantPhoto, CompanyDocument, DOCUMENT_KINDS, DOCUMENT_RULES, DocumentView, type PhotoKind } from './documents.entity';
import { applicantStatement, ESIGN_CONSENT, ESIGN_CONSENT_RU } from './statements';
export interface SignedRecord {documentId:string;version:number;title:string;typedName:string;signedAt:Date;}
/** The latest published version of each company document kind. */
export function currentDocuments(em: EntityManager): Promise<CompanyDocument[]> {
 return em.getRepository(CompanyDocument).createQueryBuilder('d').distinctOn(['d.kind']).orderBy('d.kind').addOrderBy('d.version','DESC').getMany()
  .then(rows => rows.sort((a,b) => DOCUMENT_KINDS.indexOf(a.kind)-DOCUMENT_KINDS.indexOf(b.kind)));
}
/** The applicant's current photo, or the one staff may see: the latest created at or before the last submission. */
export function photoFor(em: EntityManager, applicationId: string, kind: PhotoKind, submittedAt?: Date | null) {
 if (submittedAt === null) return Promise.resolve(null);
 return em.getRepository(ApplicantPhoto).findOne({ where: { applicationId, kind, ...(submittedAt ? { createdAt: LessThanOrEqual(submittedAt) } : { replacedAt: IsNull() }) }, order: { createdAt: 'DESC' } });
}
async function signatures(em: EntityManager, applicationId: string) {
 const rows: (SignedRecord & {kind:string;signerRole:'APPLICANT'|'COMPANY'})[] = await em.query(`SELECT s."documentId", s."signerRole", s."typedName", s."signedAt", d.kind, d.version, d.title
  FROM document_signatures s JOIN company_documents d ON d.id = s."documentId" WHERE s."applicationId" = $1 ORDER BY d.version DESC, s."signedAt" DESC`, [applicationId]);
 return rows;
}
/**
 * Photos and signatures required before submission and approval. They are collected only when private storage is
 * configured (always in production); a document kind is required once a version of it has been published.
 */
export async function documentStatus(em: EntityManager, applicationId: string, enabled: boolean, submittedAt?: Date | null) {
 if (!enabled) return { required: false, photos: { SELFIE: null, ID_SELFIE: null }, documents: [], missing: [] as DocumentItem[] };
 // Sequential: the manager may be a single transaction connection.
 const selfie = await photoFor(em,applicationId,'SELFIE',submittedAt), idSelfie = await photoFor(em,applicationId,'ID_SELFIE',submittedAt);
 const current = await currentDocuments(em), signed = await signatures(em,applicationId);
 const documents = current.map(doc => {
  const applicant = signed.find(row => row.kind === doc.kind && row.signerRole === 'APPLICANT') ?? null;
  const company = applicant && signed.find(row => row.documentId === applicant.documentId && row.signerRole === 'COMPANY') || null;
  return { kind: doc.kind, label: DOCUMENT_RULES[doc.kind].label, requiresSignature: DOCUMENT_RULES[doc.kind].signature, countersign: DOCUMENT_RULES[doc.kind].countersign,
   current: { id: doc.id, title: doc.title, version: doc.version, pageCount: doc.pageCount }, applicant, company };
 });
 const missing: DocumentItem[] = [];
 if (!selfie) missing.push('selfiePhoto');
 if (!idSelfie) missing.push('idPhoto');
 if (documents.some(doc => !doc.applicant)) missing.push('documents');
 return { required: true, photos: { SELFIE: selfie?.createdAt ?? null, ID_SELFIE: idSelfie?.createdAt ?? null }, documents, missing };
}
/** The applicant projection: what to upload and sign, with the exact statements that will be recorded. */
export async function applicantDocuments(em: EntityManager, applicationId: string, enabled: boolean) {
 const status = await documentStatus(em, applicationId, enabled);
 const views = status.documents.length ? await em.getRepository(DocumentView).findBy({ applicationId }) : [];
 return { required: status.required, missing: status.missing, photos: { selfie: status.photos.SELFIE, idSelfie: status.photos.ID_SELFIE },
  consent: { text: ESIGN_CONSENT, translation: ESIGN_CONSENT_RU },
  items: status.documents.map(doc => ({ kind: doc.kind, label: doc.label, requiresSignature: doc.requiresSignature, ...doc.current,
   ...applicantStatement({ kind: doc.kind, title: doc.current.title, version: doc.current.version }),
   viewed: views.some(view => view.documentId === doc.current.id),
   signed: doc.applicant ? { documentId: doc.applicant.documentId, version: doc.applicant.version, signedAt: doc.applicant.signedAt } : null })) };
}
