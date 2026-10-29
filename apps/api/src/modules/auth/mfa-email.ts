import { createHash, randomInt } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
/** What an emailed code may be used for; a code for one purpose never satisfies another. */
export type EmailCodePurpose = 'login' | 'enrol' | 'manage';
export const EMAIL_CODE_PATTERN = /^[0-9]{6}$/;
export const EMAIL_CODE_SECONDS = 600;
// A new code can be requested this long after the previous one (the "Send a new code" countdown).
export const EMAIL_RESEND_SECONDS = 30;
// Sends per user within 15 minutes, across purposes.
export const EMAIL_SENDS_PER_WINDOW = 5;
export const generateEmailCode = () => randomInt(0, 1_000_000).toString().padStart(6, '0');
// Bound to the user and purpose, so a hash is useless for any other account or action.
export const emailCodeHash = (userId: string, purpose: EmailCodePurpose, code: string) =>
  createHash('sha256').update(`staff-mfa-email:${userId}:${purpose}:${code}`).digest('hex');
/** j•••••@example.com: enough to recognise the inbox without printing the address in full. */
export function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(3, Math.min(local.length - 1, 6)))}@${domain}`;
}
/** Stores a new code (replacing any outstanding one for this purpose) unless the previous one is too recent. */
export async function storeEmailCode(db: DataSource | EntityManager, userId: string, purpose: EmailCodePurpose, code: string): Promise<boolean> {
  const rows: unknown[] = await db.query(`INSERT INTO staff_mfa_email_codes ("userId", purpose, "codeHash", "sentAt", "expiresAt")
    VALUES ($1, $2, $3, now(), now() + $4 * interval '1 second')
    ON CONFLICT ("userId", purpose) DO UPDATE SET "codeHash" = EXCLUDED."codeHash", "sentAt" = now(), "expiresAt" = EXCLUDED."expiresAt", "usedAt" = NULL
    WHERE staff_mfa_email_codes."sentAt" <= now() - $5 * interval '1 second' OR staff_mfa_email_codes."usedAt" IS NOT NULL
    RETURNING "userId"`, [userId, purpose, emailCodeHash(userId, purpose, code), EMAIL_CODE_SECONDS, EMAIL_RESEND_SECONDS]);
  return rows.length > 0;
}
/** Seconds until another code may be sent for this purpose (0 when one can be sent now). */
export async function resendAfter(db: DataSource | EntityManager, userId: string, purpose: EmailCodePurpose): Promise<number> {
  const rows: { wait: number }[] = await db.query(`SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("sentAt" + $3 * interval '1 second' - now()))))::int AS wait
    FROM staff_mfa_email_codes WHERE "userId" = $1 AND purpose = $2 AND "usedAt" IS NULL AND "expiresAt" > now()`, [userId, purpose, EMAIL_RESEND_SECONDS]);
  return rows[0]?.wait ?? 0;
}
/** Whether an unused, unexpired code is outstanding for this purpose. */
export async function hasEmailCode(db: DataSource | EntityManager, userId: string, purpose: EmailCodePurpose): Promise<boolean> {
  const rows: unknown[] = await db.query(`SELECT 1 FROM staff_mfa_email_codes WHERE "userId" = $1 AND purpose = $2 AND "usedAt" IS NULL AND "expiresAt" > now()`, [userId, purpose]);
  return rows.length > 0;
}
/** Consumes a matching code atomically: each code works once, even across concurrent requests. */
export async function consumeEmailCode(db: DataSource | EntityManager, userId: string, purpose: EmailCodePurpose, code: string): Promise<boolean> {
  if (!EMAIL_CODE_PATTERN.test(code)) return false;
  // For UPDATE, TypeORM's PostgreSQL driver returns [rows, affectedCount] rather than the rows.
  const [rows]: [unknown[], number] = await db.query(`UPDATE staff_mfa_email_codes SET "usedAt" = now()
    WHERE "userId" = $1 AND purpose = $2 AND "codeHash" = $3 AND "usedAt" IS NULL AND "expiresAt" > now() RETURNING "userId"`,
    [userId, purpose, emailCodeHash(userId, purpose, code)]);
  return rows.length > 0;
}
