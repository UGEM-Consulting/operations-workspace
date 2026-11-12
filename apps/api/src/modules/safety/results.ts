import type { EntityManager } from 'typeorm';
import type { User } from '../users/user.entity';
import { CLEARERS } from './clearance.service';
import { ownsDriver } from './driver-records';

/**
 * Drug and alcohol results are seen only by those who act on them (49 CFR 40.321, 382.723): the Safety Director,
 * administrators and the driver's current Safety Manager. Everything that would tell someone else how a test came out is
 * left out where it is read, in the query, so a new list or count can't leak it by forgetting a filter afterwards:
 * - the clearance items and paper-file items that hold results (RESULT_ITEMS), their history entries and their counts;
 * - the return-to-duty papers (RESULT_DOCUMENT), which exist only after a positive or refused DOT test, and their history;
 * - the DOT pre-employment answers in the application (DOT_ANSWERS).
 * Readers ask seesResults once and pass the answer to their queries as a boolean parameter, or, for a list of drivers,
 * use seesResultsSql per row.
 */
export const RESULT_ITEMS = ['DRUG_TEST', 'CLEARINGHOUSE'];
export const RESULT_DOCUMENT = 'RETURN_TO_DUTY';
export const DOT_ANSWERS = ['dotPositive', 'dotFollowUp'];

/** Whether this person sees this driver's results. */
export async function seesResults(em: EntityManager, user: User, driverId: string) {
 return CLEARERS.includes(user.role) || await ownsDriver(em, user, driverId);
}
/** The same rule for rows of many drivers: query parameters for the viewer, and the SQL that uses them per driver. */
export const resultViewer = (user: User): [boolean, string] => [CLEARERS.includes(user.role), user.id];
export const seesResultsSql = (driverId: string, all: string, userId: string) =>
 `(${all}::boolean OR EXISTS(SELECT 1 FROM driver_owners rv WHERE rv."driverId" = ${driverId} AND rv."ownerId" = ${userId}::uuid AND rv."endedAt" IS NULL))`;

const list = (values: string[]) => values.map(value => `'${value}'`).join(',');
/** A restricted clearance or paper-file key ($sees false leaves it out). */
export const resultKeySql = (key: string, sees: string) => `(${sees}::boolean OR ${key} NOT IN (${list(RESULT_ITEMS)}))`;
/** A driver document the viewer may see. */
export const documentSql = (kind: string, sees: string) => `(${sees}::boolean OR ${kind} <> '${RESULT_DOCUMENT}')`;
/** The application's answers without the DOT ones for someone who doesn't see results. */
export const fieldsSql = (fields: string, sees: string) => `CASE WHEN ${sees}::boolean THEN ${fields} ELSE ${fields} ${DOT_ANSWERS.map(key => `- '${key}'`).join(' ')} END`;
/**
 * A history entry as the viewer may see it: return-to-duty entries are left out (eventSql, in WHERE), and a result item's
 * entry keeps only which item it was (eventMetadataSql, in SELECT), so neither says how it came out.
 */
export const eventSql = (alias: string, sees: string) => `(${sees}::boolean OR ${alias}.metadata->>'kind' IS DISTINCT FROM '${RESULT_DOCUMENT}')`;
export const eventMetadataSql = (alias: string, sees: string) => `CASE
  WHEN NOT ${sees}::boolean AND ${alias}.event = 'CLEARANCE_RECORDED' AND ${alias}.metadata->>'item' IN (${list(RESULT_ITEMS)}) THEN jsonb_build_object('item', ${alias}.metadata->'item', 'hidden', true)
  WHEN NOT ${sees}::boolean AND ${alias}.event = 'PAPER_ITEM_RECORDED' AND ${alias}.metadata->>'key' IN (${list(RESULT_ITEMS)}) THEN jsonb_build_object('key', ${alias}.metadata->'key', 'hidden', true)
  ELSE ${alias}.metadata END`;
/** In place of a restricted item that was left out: it exists on the checklist, nothing more. */
export const hiddenItems = (keys: readonly string[]) => RESULT_ITEMS.filter(key => keys.includes(key)).map(key => ({ key, hidden: true as const }));
/** Gaps that would say whether a result item is done. */
export const withoutResultGaps = (missing: string[]) => missing.filter(code => !RESULT_ITEMS.some(key => code.endsWith(`:${key}`)));
