import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { DataSource } from 'typeorm';
import { attemptKey, countAttempt as countShared, readAttempts } from '../auth/attempts';
import { clientContext } from '../documents/client-context';
// Applicant counters reuse the shared login_attempts helpers under their own hashed key scope.
const hashed = (key: string) => attemptKey('applicant', key);
/** Reads a counter without incrementing it; 0 when absent or expired. */
export const activeAttempts = (db: DataSource, key: string): Promise<number> => readAttempts(db, hashed(key));
/** Increments a fixed-window counter and returns the attempts in the current window. */
export const countAttempt = (db: DataSource, key: string, seconds: number): Promise<number> => countShared(db, hashed(key), seconds);
export async function onboardingLimit(db: DataSource, key: string, max = 10, seconds = 900): Promise<void> {
 if (await countAttempt(db,key,seconds) > max) throw new HttpException('Too many attempts. Please try again later.',429);
}
/**
 * Rate-limit bucket for the browser's address. The BFF forwards it as x-client-ip, which the API trusts only because
 * every request also carries the server-only BFF secret. IPv6 is grouped by /64, the block one subscriber controls.
 * Requests without a usable address share one bucket.
 */
export function clientBucket(req: Request): string {
 const ip = clientContext(req).ipAddress;
 if (!ip) return 'unknown';
 if (!ip.includes(':')) return ip;
 const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
 if (v4) return v4;
 const [head, tail = ''] = ip.toLowerCase().split('::');
 const left = head ? head.split(':') : [], right = ip.includes('::') && tail ? tail.split(':') : [];
 const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
 return groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
