import { EntityManager } from 'typeorm';
import { type DriverApplicationFields, requiredDriverDocuments, SCREENING_CHECKS } from './safety.entity';

/**
 * What still stands between a driver in screening and the Safety manager's decision, as codes the web turns into words:
 * `application` (not submitted), `check:<KEY>` (a screening check not done), and, when private storage is configured,
 * `mvr` (no MVR uploaded) and `document:<KIND>` (a required scan Safety hasn't verified). Empty means ready.
 */
export async function screeningGaps(em: EntityManager, driverId: string, storageEnabled: boolean): Promise<string[]> {
 // One after another: inside a transaction they share one connection, which can't run queries in parallel.
 const [application] = await em.query(`SELECT status, fields FROM driver_applications WHERE "driverId" = $1`, [driverId]) as { status: string; fields: DriverApplicationFields }[];
 const checks = await em.query(`SELECT key FROM driver_screening_checks WHERE "driverId" = $1`, [driverId]) as { key: string }[];
 const [mvr] = await em.query(`SELECT 1 FROM driver_reports WHERE "driverId" = $1 AND kind = 'MVR' AND "replacedAt" IS NULL`, [driverId]) as unknown[];
 const verified = await em.query(`SELECT kind FROM driver_documents WHERE "driverId" = $1 AND "replacedAt" IS NULL AND "verifiedAt" IS NOT NULL`, [driverId]) as { kind: string }[];
 return missingForDecision({ application, checkKeys: checks.map(row => row.key), hasMvr: !!mvr, verifiedKinds: verified.map(row => row.kind) }, storageEnabled);
}

/** The same gaps from rows already loaded (the driver profile reads them all anyway). */
export function missingForDecision(screening: { application?: { status: string; fields: DriverApplicationFields } | null; checkKeys: string[]; hasMvr: boolean; verifiedKinds: string[] },
 storageEnabled: boolean): string[] {
 const { application, checkKeys, hasMvr, verifiedKinds } = screening;
 const gaps: string[] = [];
 if (application?.status !== 'SUBMITTED') gaps.push('application');
 gaps.push(...SCREENING_CHECKS.filter(key => !checkKeys.includes(key)).map(key => `check:${key}`));
 if (storageEnabled) {
  if (!hasMvr) gaps.push('mvr');
  gaps.push(...requiredDriverDocuments(application?.fields ?? {}).filter(kind => !verifiedKinds.includes(kind)).map(kind => `document:${kind}`));
 }
 return gaps;
}

/**
 * A calendar date (YYYY-MM-DD) as people in the mainland US see it. Dates people enter are compared with the `latest` one
 * (Eastern: no US date is past it, so nothing entered is refused as future when it isn't), and a waiting period ends
 * only once it has ended at the `earliest` one (Pacific), so a driver's response window is never cut short.
 */
const US_EDGE = { latest: 'America/New_York', earliest: 'America/Los_Angeles' } as const;
export const usDay = (edge: keyof typeof US_EDGE, at: Date | number = Date.now()) =>
 new Intl.DateTimeFormat('en-CA', { timeZone: US_EDGE[edge], year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
/** The date some days away from a YYYY-MM-DD date. */
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
