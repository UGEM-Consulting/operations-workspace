import { createHash, randomBytes } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { DataSource, EntityManager } from 'typeorm';
import type { User } from '../users/user.entity';
import { clientContext } from '../documents/client-context';
import { SecurityEventType, StaffSecurityEvent } from './mfa.entity';

/**
 * Devices that skip the sign-in code (section 38, TrustedDevicesScreen). Ticking "Don't ask for a code on this device for
 * 30 days" after a correct code leaves a random device cookie, apart from the session cookie; only its SHA-256 hash is stored,
 * with the account's authVersion. The password is still asked every time. Anything that ends a person's sessions (a password,
 * authenticator, role, status or email change, an administrator reset) bumps authVersion and deletes their devices, so a
 * device trusted before never skips the code after. Administrators never get one (emailCodesAllowed in mfa.service).
 */
export const TRUSTED_DAYS = 30;
const TRUSTED_MS = TRUSTED_DAYS * 86_400_000;
// The newest devices are kept; the oldest go once someone trusts more than this many.
const MAX_DEVICES = 10;
// The web's deviceCookieName (apps/web/src/lib/session-cookie.ts) must give the same names; test/mfa.integration.spec.ts compares them.
export const deviceCookieName = (production: boolean) => production ? '__Host-operations.device' : 'operations.device';
const production = () => process.env.NODE_ENV === 'production';
const cookieOptions = () => ({ httpOnly: true, secure: production(), sameSite: 'lax' as const, path: '/' });
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** The device cookie the BFF forwarded on sign-in and Account security routes, if any. */
export function deviceToken(req: Request): string | null {
 const name = deviceCookieName(production());
 for (const part of (req.headers.cookie ?? '').split(';')) {
  const [key, ...value] = part.trim().split('=');
  if (key === name) { const token = value.join('='); return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null; }
 }
 return null;
}

/** “Chrome on Windows”: the browser and system only, never an address or a location. */
export function deviceLabel(userAgent: string | null | undefined): string {
 const ua = userAgent ?? '';
 // iOS browsers name themselves EdgiOS, FxiOS and CriOS and still carry Safari/.
 const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge' : /OPR\/|OPiOS\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
 // An iPad asks for desktop pages and calls itself a Mac; only its mobile build marker (Mobile/) tells them apart.
 const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || /Macintosh/.test(ua) && /Mobile\//.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : null;
 return system ? `${browser} on ${system}` : browser;
}

/** A PostgreSQL error code (such as 42P01, a missing table during a deploy) for the log, never the message or values. */
export function trustFailureCode(error: unknown): string {
 const code = typeof error === 'object' && error !== null ? (error as { driverError?: { code?: unknown }; code?: unknown }).driverError?.code ?? (error as { code?: unknown }).code : undefined;
 return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'TRUST_FAILED';
}

/** Whether this request's device cookie is trusted for this person now; records the use when it is. */
export async function useTrustedDevice(db: DataSource, user: Pick<User, 'id' | 'authVersion'>, req: Request): Promise<boolean> {
 const token = deviceToken(req);
 if (!token) return false;
 const rows: unknown[] = await db.query(`UPDATE staff_trusted_devices SET "lastUsedAt" = now() WHERE "tokenHash" = $1 AND "userId" = $2 AND "authVersion" = $3 AND "expiresAt" > now() RETURNING id`,
  [hash(token), user.id, user.authVersion]);
 return ((rows[0] as unknown[] | undefined)?.length ?? 0) > 0;
}

/** After a correct authenticator or emailed code with the box ticked: a new device cookie for 30 days. */
export async function trustDevice(db: DataSource, user: Pick<User, 'id' | 'authVersion'>, req: Request) {
 const token = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now() + TRUSTED_MS);
 await db.transaction(async manager => {
  // A browser holds one device cookie, so the row its earlier cookie names goes, whoever's it was (a shared browser trusted by
  // two people): it could never skip the code again. Stale rows (expired, or from before a sign-out-everywhere change) go too.
  const earlier = deviceToken(req);
  const [replaced] = earlier ? await manager.query(`DELETE FROM staff_trusted_devices WHERE "tokenHash" = $1 RETURNING "userId"`, [hash(earlier)]) as [{ userId: string }[], number] : [[]];
  for (const row of replaced.filter(row => row.userId !== user.id)) {
   await manager.insert(StaffSecurityEvent, { userId: row.userId, actorId: user.id, type: SecurityEventType.TRUSTED_DEVICE_FORGOTTEN, metadata: { all: false, count: 1, replacedOther: true } });
  }
  await manager.query(`DELETE FROM staff_trusted_devices WHERE "userId" = $1 AND ("expiresAt" <= now() OR "authVersion" <> $2)`, [user.id, user.authVersion]);
  await manager.query(`INSERT INTO staff_trusted_devices ("userId", "tokenHash", "authVersion", label, "expiresAt") VALUES ($1, $2, $3, $4, $5)`,
   [user.id, hash(token), user.authVersion, deviceLabel(clientContext(req).userAgent), expiresAt]);
  await manager.query(`DELETE FROM staff_trusted_devices WHERE id IN (SELECT id FROM staff_trusted_devices WHERE "userId" = $1 ORDER BY "createdAt" DESC OFFSET ${MAX_DEVICES})`, [user.id]);
  await manager.insert(StaffSecurityEvent, { userId: user.id, actorId: user.id, type: SecurityEventType.TRUSTED_DEVICE_ADDED, metadata: {} });
 });
 req.res?.cookie(deviceCookieName(production()), token, { ...cookieOptions(), maxAge: TRUSTED_MS });
}

/** Account security's list: browser and system, last used and when it asks again; never the cookie or its hash. */
export async function trustedDevices(db: DataSource, user: Pick<User, 'id' | 'authVersion'>, req: Request) {
 const token = deviceToken(req), current = token ? hash(token) : null;
 const rows: { id: string; label: string; createdAt: Date; lastUsedAt: Date; expiresAt: Date; tokenHash: string }[] = await db.query(`SELECT id, label, "createdAt", "lastUsedAt", "expiresAt", "tokenHash"
  FROM staff_trusted_devices WHERE "userId" = $1 AND "authVersion" = $2 AND "expiresAt" > now() ORDER BY "lastUsedAt" DESC`, [user.id, user.authVersion]);
 return rows.map(({ tokenHash, ...row }) => ({ ...row, current: tokenHash === current }));
}

/** Forgets one device, or all of them. Nobody is signed out: the next sign-in on them asks for a code. */
export async function forgetDevices(db: DataSource, user: Pick<User, 'id'>, req: Request, id: string | null) {
 const token = deviceToken(req), current = token ? hash(token) : null;
 const removed: { tokenHash: string }[] = await db.transaction(async manager => {
  const [rows] = await manager.query(`DELETE FROM staff_trusted_devices WHERE "userId" = $1 ${id ? 'AND id = $2' : ''} RETURNING "tokenHash"`, id ? [user.id, id] : [user.id]) as [{ tokenHash: string }[], number];
  if (id && !rows.length) throw new NotFoundException('This device was already forgotten.');
  if (rows.length) await manager.insert(StaffSecurityEvent, { userId: user.id, actorId: user.id, type: SecurityEventType.TRUSTED_DEVICE_FORGOTTEN, metadata: { all: !id, count: rows.length } });
  return rows;
 });
 // Only when the cookie was one of theirs: on a shared browser it may be someone else's trusted device.
 if (removed.some(row => row.tokenHash === current)) req.res?.clearCookie(deviceCookieName(production()), cookieOptions());
 return { forgotten: removed.length };
}

/** With every session revoked (revokeUserSessions): no device skips the code any more. */
export async function deleteTrustedDevices(manager: EntityManager, userId: string) {
 await manager.query(`DELETE FROM staff_trusted_devices WHERE "userId" = $1`, [userId]);
}
