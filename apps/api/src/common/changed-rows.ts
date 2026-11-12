import type { EntityManager } from 'typeorm';

/**
 * How many rows an UPDATE or DELETE changed. TypeORM's PostgreSQL driver answers those (with or without RETURNING) with
 * [rows, affected], not the rows themselves, so counting the result's length always gives 2. Use this, or a repository's
 * update(...).affected, instead of reading the raw result.
 */
export async function changedRows(em: EntityManager, sql: string, parameters: unknown[]): Promise<number> {
 const [, affected] = await em.query(sql, parameters) as [unknown[], number];
 return affected;
}
