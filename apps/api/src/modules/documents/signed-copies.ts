import { BeforeApplicationShutdown, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SignedCopyArchive } from '../storage/signed-copies';
import { signedCopyKey, StorageService } from '../storage/storage.service';
import { DOCUMENT_KINDS, DOCUMENT_RULES } from './documents.entity';
import { DocumentsService } from './documents.service';

// A countersigned document (the NDA) is complete once the manager countersigns at approval; an application that ended
// without that (rejected, or approved before countersigning existed) keeps the applicant-signed copy as its final one.
const COUNTERSIGNED = DOCUMENT_KINDS.filter(kind => DOCUMENT_RULES[kind].countersign);
/** Saves applicants' completed signed copies into applicants/<application>/signed/. */
@Injectable()
export class ApplicantSignedCopies implements OnApplicationBootstrap, BeforeApplicationShutdown {
 readonly archive: SignedCopyArchive;
 constructor(db: DataSource, storage: StorageService, documents: DocumentsService) {
  this.archive = new SignedCopyArchive('ApplicantSignedCopies', db, storage, 42002034, async waiting => {
   const rows: { applicationId: string; documentId: string; kind: string; version: number }[] = await db.query(`SELECT s."applicationId", s."documentId", d.kind, d.version
    FROM document_signatures s JOIN company_documents d ON d.id = s."documentId" JOIN dispatcher_applications a ON a.id = s."applicationId"
    WHERE s."signerRole" = 'APPLICANT' AND (d.kind <> ALL($1::varchar[]) OR a.status IN ('APPROVED', 'REJECTED'))
     AND NOT EXISTS (SELECT 1 FROM signed_copies c WHERE c."applicationId" = s."applicationId" AND c."companyDocumentId" = s."documentId")
     AND s."applicationId"::text || ':' || s."documentId"::text <> ALL($2::text[])
    ORDER BY s."signedAt" LIMIT 25`, [COUNTERSIGNED, waiting]);
   return rows.map(row => ({ key: signedCopyKey({ applicationId: row.applicationId }, row), owner: { applicationId: row.applicationId, companyDocumentId: row.documentId } }));
  }, async copy => {
   if (!('applicationId' in copy.owner)) throw new Error('Not an applicant copy');
   return (await documents.signedCopy(db.manager, copy.owner.applicationId, copy.owner.companyDocumentId, 'staff')).body;
  });
 }
 onApplicationBootstrap() { this.archive.start(); }
 beforeApplicationShutdown() { this.archive.stop(); }
}
