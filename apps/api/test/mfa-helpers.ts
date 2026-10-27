import { Secret, TOTP } from 'otpauth';
import type request from 'supertest';
import type { Response } from 'supertest';
import type { DataSource } from 'typeorm';
import { SecretBox, newTotpSecret } from '../src/modules/auth/mfa-crypto';

/** Enrols a fictional test user directly and returns the plaintext secret for generating codes. */
export async function enrolForTest(db: DataSource, key: string, userId: string): Promise<string> {
  const secret = newTotpSecret();
  await db.query(`INSERT INTO staff_mfa ("userId", "secretCiphertext", "confirmedAt") VALUES ($1, $2, now())
    ON CONFLICT ("userId") DO UPDATE SET "secretCiphertext" = EXCLUDED."secretCiphertext", "confirmedAt" = now(), "lastUsedStep" = NULL`,
  [userId, new SecretBox(key).seal(secret, userId)]);
  return secret;
}
export const totpCode = (secret: string, offsetSteps = 0) =>
  new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + offsetSteps * 30_000 });

/** Second sign-in step. Suites sign in repeatedly within one 30-second step, so replay state is cleared first; mfa.integration covers replays. */
export async function completeMfa(agent: ReturnType<typeof request.agent>, headers: Record<string, string>, db: DataSource, userId: string, secret: string): Promise<Response> {
  await db.query(`UPDATE staff_mfa SET "lastUsedStep" = NULL WHERE "userId" = $1`, [userId]);
  return agent.post('/api/auth/mfa/verify').set(headers).send({ code: totpCode(secret) });
}
