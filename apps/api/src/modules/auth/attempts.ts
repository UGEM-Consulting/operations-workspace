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
export async function clearAttempts(db: DataSource | EntityManager, key: string): Promise<void> {
  await db.query('DELETE FROM login_attempts WHERE key = $1', [key]);
}
