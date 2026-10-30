import { EntityManager } from 'typeorm';
import { CONSENT_KINDS, CONSENT_RULES, consentStatement, type ConsentKind, DRIVER_ESIGN_CONSENT, DriverConsentDocument } from './consent.entity';

/** The latest published version of each consent form kind, in the order drivers see them. */
export async function currentConsents(em: EntityManager): Promise<DriverConsentDocument[]> {
 const rows = await em.getRepository(DriverConsentDocument).createQueryBuilder('d').distinctOn(['d.kind']).orderBy('d.kind').addOrderBy('d.version', 'DESC').getMany();
 return rows.sort((a, b) => CONSENT_KINDS.indexOf(a.kind) - CONSENT_KINDS.indexOf(b.kind));
}

/**
 * The consent forms a driver must sign before submitting, and what they have signed. Required only with private storage
 * (the forms are stored files) and only for kinds Safety has published. A signature on an earlier version shows as
 * signed but doesn't satisfy the current version. `missing` holds `consent:<KIND>` codes.
 */
export async function consentStatus(em: EntityManager, driverId: string, storageEnabled: boolean) {
 if (!storageEnabled) return { required: false, consent: DRIVER_ESIGN_CONSENT, items: [], missing: [] as string[] };
 // One after another: inside a transaction they share one connection.
 const current = await currentConsents(em);
 const signed: { documentId: string; kind: ConsentKind; version: number; signedAt: Date }[] = await em.query(`SELECT s."documentId", d.kind, d.version, s."signedAt"
  FROM driver_consent_signatures s JOIN driver_consent_documents d ON d.id = s."documentId" WHERE s."driverId" = $1 ORDER BY d.version DESC`, [driverId]);
 const viewed: { documentId: string }[] = await em.query(`SELECT "documentId" FROM driver_consent_views WHERE "driverId" = $1`, [driverId]);
 const items = current.map(document => {
  const latest = signed.find(row => row.kind === document.kind) ?? null;
  return { id: document.id, kind: document.kind, label: CONSENT_RULES[document.kind].label, title: document.title, version: document.version, pageCount: document.pageCount,
   requiresSignature: CONSENT_RULES[document.kind].signature, statement: consentStatement(document), viewed: viewed.some(row => row.documentId === document.id),
   signed: latest ? { documentId: latest.documentId, version: latest.version, signedAt: latest.signedAt } : null, current: latest?.documentId === document.id };
 });
 return { required: items.length > 0, consent: DRIVER_ESIGN_CONSENT, items, missing: missingConsents(current, signed.map(row => row.documentId)) };
}

/** `consent:<KIND>` for each current form the driver hasn't signed, from rows already loaded. */
export function missingConsents(current: DriverConsentDocument[], signedDocumentIds: string[]): string[] {
 return current.filter(document => !signedDocumentIds.includes(document.id)).map(document => `consent:${document.kind}`);
}

/** Whether the driver signed any version of the background check authorization in the workspace. */
export async function authorizationSigned(em: EntityManager, driverId: string): Promise<boolean> {
 const [row] = await em.query(`SELECT 1 FROM driver_consent_signatures s JOIN driver_consent_documents d ON d.id = s."documentId"
  WHERE s."driverId" = $1 AND d.kind = 'BACKGROUND_AUTHORIZATION' LIMIT 1`, [driverId]);
 return !!row;
}
