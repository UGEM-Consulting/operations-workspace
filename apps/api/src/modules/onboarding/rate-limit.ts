import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
export async function onboardingLimit(db: DataSource, key: string, max = 10, seconds = 900): Promise<void> {
 const hashedKey = createHash('sha256').update('applicant:' + key).digest('hex');
 const rows: { attempts: number }[] = await db.query(`INSERT INTO login_attempts (key, attempts, "expiresAt") VALUES ($1,1,now()+$2*interval '1 second')
  ON CONFLICT (key) DO UPDATE SET attempts = CASE WHEN login_attempts."expiresAt" <= now() THEN 1 ELSE login_attempts.attempts+1 END,
  "expiresAt" = CASE WHEN login_attempts."expiresAt" <= now() THEN now()+$2*interval '1 second' ELSE login_attempts."expiresAt" END RETURNING attempts`, [hashedKey,seconds]);
 if (rows[0].attempts > max) throw new HttpException('Too many attempts. Please try again later.',429);
}
