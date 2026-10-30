import { BeforeApplicationShutdown, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SignedCopyArchive } from '../storage/signed-copies';
import { signedCopyKey, StorageService } from '../storage/storage.service';
import { ConsentService } from './consent.service';

/** Saves drivers' signed consent forms (the driver is the only signer) into drivers/<driver>/signed/. */
@Injectable()
export class DriverSignedCopies implements OnApplicationBootstrap, BeforeApplicationShutdown {
 readonly archive: SignedCopyArchive;
 constructor(db: DataSource, storage: StorageService, consents: ConsentService) {
  this.archive = new SignedCopyArchive('DriverSignedCopies', db, storage, 42002035, async waiting => {
   const rows: { driverId: string; documentId: string; kind: string; version: number }[] = await db.query(`SELECT s."driverId", s."documentId", d.kind, d.version
    FROM driver_consent_signatures s JOIN driver_consent_documents d ON d.id = s."documentId"
    WHERE NOT EXISTS (SELECT 1 FROM signed_copies c WHERE c."driverId" = s."driverId" AND c."consentDocumentId" = s."documentId")
     AND s."driverId"::text || ':' || s."documentId"::text <> ALL($1::text[])
    ORDER BY s."signedAt" LIMIT 25`, [waiting]);
   return rows.map(row => ({ key: signedCopyKey({ driverId: row.driverId }, row), owner: { driverId: row.driverId, consentDocumentId: row.documentId } }));
  }, async copy => {
   if (!('driverId' in copy.owner)) throw new Error('Not a driver copy');
   return (await consents.signedCopy(copy.owner.driverId, copy.owner.consentDocumentId)).body;
  });
 }
 onApplicationBootstrap() { this.archive.start(); }
 beforeApplicationShutdown() { this.archive.stop(); }
}
