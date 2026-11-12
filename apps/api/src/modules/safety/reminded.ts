import type { EntityManager } from 'typeorm';

export type Channel = 'EMAIL' | 'TELEGRAM';

/**
 * The SQL condition for a renewal scan, in driver_documents aliased n: the current scan of that kind that the driver sent
 * through a renewal link and nobody has checked (not one from their application, not one Safety uploaded). Safety's pages
 * show it as waiting for a check (or not readable), and reminders aren't sent while one waits.
 */
export const renewalScanWhere = (driverId: string, kind: string) => `n."driverId" = ${driverId} AND n.kind = ${kind} AND n."replacedAt" IS NULL AND n."verifiedAt" IS NULL AND n."uploadedBy" IS NULL
  AND n."createdAt" > coalesce((SELECT a."submittedAt" FROM driver_applications a WHERE a."driverId" = ${driverId}), '-infinity') AND ${sentScan('n')}`;
/**
 * A catch-up scan counts once the driver sent it (section 34): until then it isn't Safety's to check and doesn't stop
 * reminders, and the paper date it will replace keeps counting. Scans of other links are always sent with them.
 */
export const sentScan = (alias: string) => `NOT EXISTS(SELECT 1 FROM driver_links k WHERE k."driverId" = ${alias}."driverId" AND k.purpose = 'CATCH_UP' AND k."completedAt" IS NULL AND k."createdAt" <= ${alias}."createdAt")`;
/** A renewal scan waiting for its check (not marked as not readable). */
export const renewalScanWaiting = (driverId: string, kind: string) => `EXISTS(SELECT 1 FROM driver_documents n WHERE ${renewalScanWhere(driverId, kind)} AND n."unreadableAt" IS NULL)`;

/** The latest reminder each document's driver got (or that was tried), for Expiring documents' Driver reminded column. */
export async function driverReminded(em: EntityManager, subjectIds: string[]): Promise<Map<string, { channel: Channel; status: string; failureCode: string | null; at: string }>> {
 if (!subjectIds.length) return new Map();
 const rows: { subjectId: string; channel: Channel; status: string; failureCode: string | null; at: string }[] = await em.query(`SELECT DISTINCT ON (r."subjectId") r."subjectId", d.channel, d.status,
   d."failureCode", coalesce(d."sentAt", d."createdAt") AS at FROM safety_reminders r JOIN safety_reminder_deliveries d ON d."reminderId" = r.id
  WHERE r.audience = 'DRIVER' AND r."subjectId" = ANY($1::uuid[]) ORDER BY r."subjectId", r."createdAt" DESC`, [subjectIds]);
 return new Map(rows.map(row => [row.subjectId, { channel: row.channel, status: row.status, failureCode: row.failureCode, at: row.at }]));
}
