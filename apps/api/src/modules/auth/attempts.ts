import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
// Atomic PostgreSQL counters shared by every API instance. Keys are hashed; no emails or identifiers are stored.
export const attemptKey = (scope: string, value: string) => createHash('sha256').update(`${scope}:${value}`).digest('hex');
export async function countAttempt(db: DataSource | EntityManager, key: string, seconds: number): Promise<number> {
  const rows: { attempts: number }[] = await db.query(`INSERT INTO login_attempts (key, attempts, "expiresAt") VALUES ($1, 1, now() + $2 * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET attempts = CASE WHEN login_attempts."expiresAt" <= now() THEN 1 ELSE login_attempts.attempts + 1 END,
    "expiresAt" = CASE WHEN login_attempts."expiresAt" <= now() THEN now() + $2 * interval '1 second' ELSE login_attempts."expiresAt" END RETURNING attempts`, [key, seconds]);
  return rows[0].attempts;
}
/** Increments several distinct fixed-window counters in one statement; returns each count in the order given. */
export async function countAttempts(db: DataSource | EntityManager, counters: { key: string; seconds: number }[]): Promise<number[]> {
  const rows: { key: string; attempts: number }[] = await db.query(`INSERT INTO login_attempts (key, attempts, "expiresAt")
    SELECT key, 1, now() + seconds * interval '1 second' FROM unnest($1::text[], $2::int[]) AS counter(key, seconds)
    ON CONFLICT (key) DO UPDATE SET attempts = CASE WHEN login_attempts."expiresAt" <= now() THEN 1 ELSE login_attempts.attempts + 1 END,
    "expiresAt" = CASE WHEN login_attempts."expiresAt" <= now() THEN EXCLUDED."expiresAt" ELSE login_attempts."expiresAt" END RETURNING key, attempts`,
    [counters.map(counter => counter.key), counters.map(counter => counter.seconds)]);
  const counts = new Map(rows.map(row => [row.key, row.attempts]));
  return counters.map(counter => counts.get(counter.key) ?? 0);
}
export async function clearAttempts(db: DataSource | EntityManager, key: string | string[]): Promise<void> {
  await db.query('DELETE FROM login_attempts WHERE key = ANY($1::text[])', [Array.isArray(key) ? key : [key]]);
}
/** Current count of an unexpired counter, without incrementing it. */
export async function readAttempts(db: DataSource | EntityManager, key: string): Promise<number> {
  const rows: { attempts: number }[] = await db.query(`SELECT attempts FROM login_attempts WHERE key = $1 AND "expiresAt" > now()`, [key]);
  return rows[0]?.attempts ?? 0;
}
/** Marks a key as locked for the given duration, replacing any earlier state. */
export async function lockKey(db: DataSource | EntityManager, key: string, seconds: number): Promise<void> {
  await db.query(`INSERT INTO login_attempts (key, attempts, "expiresAt") VALUES ($1, 1, now() + $2 * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET attempts = 1, "expiresAt" = EXCLUDED."expiresAt"`, [key, seconds]);
}
/** Increments a counter whose window restarts at every increment, so it expires only after a quiet period. */
export async function countSliding(db: DataSource | EntityManager, key: string, seconds: number): Promise<number> {
  const rows: { attempts: number }[] = await db.query(`INSERT INTO login_attempts (key, attempts, "expiresAt") VALUES ($1, 1, now() + $2 * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET attempts = CASE WHEN login_attempts."expiresAt" <= now() THEN 1 ELSE login_attempts.attempts + 1 END,
    "expiresAt" = EXCLUDED."expiresAt" RETURNING attempts`, [key, seconds]);
  return rows[0].attempts;
}
