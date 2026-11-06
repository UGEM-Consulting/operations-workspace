import type { EntityManager } from 'typeorm';

// The latest standing drug or alcohol test (not voided or cancelled) of each kind is not negative or a refusal.
const failedTest = (d: string) => `EXISTS(SELECT 1 FROM (VALUES ('DRUG'), ('ALCOHOL')) k(kind) JOIN LATERAL (SELECT t.result FROM driver_tests t
   WHERE t."driverId" = ${d}.id AND t.kind = k.kind AND t."voidedAt" IS NULL AND t.result <> 'CANCELLED' ORDER BY t."testedOn" DESC, t."createdAt" DESC LIMIT 1) l
   ON l.result IN ('NOT_NEGATIVE', 'REFUSED'))`;
// The latest yearly review found them not qualified.
const notQualified = (d: string) => `coalesce((SELECT r.outcome FROM driver_annual_reviews r WHERE r."driverId" = ${d}.id ORDER BY r."reviewedOn" DESC, r."createdAt" DESC LIMIT 1) = 'NOT_QUALIFIED', false)`;
// Their latest checked license or medical card expired before today's US Eastern date (designed as ExpiringDocumentsScreen).
// Only checked documents count: a renewal the driver scanned lifts nothing until a person checks it (RenewCheckScreen).
const expired = (d: string) => `EXISTS(SELECT 1 FROM (VALUES ('LICENSE'), ('MEDICAL_CARD')) k(kind) JOIN LATERAL (SELECT x."expiresOn" FROM driver_documents x
   WHERE x."driverId" = ${d}.id AND x.kind = k.kind AND x."verifiedAt" IS NOT NULL ORDER BY x."createdAt" DESC LIMIT 1) l
   ON l."expiresOn" < (now() AT TIME ZONE 'America/New_York')::date)`;

/**
 * Whether Safety has a cleared driver on hold, for the driver row aliased `d`: a failed or refused test, a Not qualified
 * yearly review, or an expired license or medical card. A driver on hold must not drive (49 CFR 382.501, 391.11, 391.41),
 * so Dispatch can't assign them; Dispatch is told only that they're on hold, never why. A later negative test of that
 * kind, a later Qualified review or a newer checked document lifts it.
 */
export const onHoldSql = (d = 'd') => `(${failedTest(d)} OR ${notQualified(d)} OR ${expired(d)})`;

/** Why a driver is on hold, for Safety: which reasons apply. */
export async function holdReasons(em: EntityManager, driverId: string) {
 const [row] = await em.query(`SELECT ${failedTest('d')} AS test, ${notQualified('d')} AS review, ${expired('d')} AS documents FROM drivers d WHERE d.id = $1`, [driverId]) as { test: boolean; review: boolean; documents: boolean }[];
 return { test: !!row?.test, review: !!row?.review, documents: !!row?.documents };
}
