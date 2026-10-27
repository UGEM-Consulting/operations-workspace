import { timingSafeEqual } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import { webOrigins, type Environment } from '../../config/environment';
import type { User } from '../users/user.entity';
declare module 'express-session' {
  interface SessionData {
    applicantApplicationId: string; userId: string; authVersion: number; expiresAt: number;
    // Whether this staff session completed two-step verification. Earlier sessions lack it.
    mfa: 'verified' | 'not-required';
    // Password accepted, second step outstanding. Grants no staff access: userId stays unset.
    mfaPending: { userId: string; authVersion: number; stage: MfaStage; expiresAt: number };
  }
}
export type MfaStage = 'verify' | 'enrol';
export type AuthRequest = Request & { currentUser: User };
export const regenerateSession = (req: Request) => new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
export const saveSession = (req: Request) => new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
export const cookieName = (production: boolean) => production ? '__Host-operations.sid' : 'operations.sid';
export function equalSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function boundary(env: Environment) {
  const origins = webOrigins(env);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api/health' || (env.NODE_ENV !== 'production' && req.path.startsWith('/api/docs'))) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (!equalSecret(req.get('x-workspace-key'), env.BFF_SHARED_SECRET)) return res.status(403).json({ message: 'Forbidden' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (!origins.includes(req.get('origin') ?? '') || req.get('x-csrf-protection') !== '1' || !req.is('application/json'))) {
      return res.status(403).json({ message: 'Invalid request origin or CSRF protection' });
    }
    next();
  };
}
export function sessionOptions(env: Environment, store: session.Store): session.SessionOptions {
  return { store, name: cookieName(env.NODE_ENV === 'production'), secret: env.SESSION_SECRET,
    resave: false, saveUninitialized: false, rolling: false, proxy: true,
    cookie: { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: env.SESSION_TTL_SECONDS * 1000 } };
}
export function installSessions(app: INestApplication, env: Environment): () => Promise<void> {
  // Only the authenticated BFF may supply forwarding headers; boundary runs before sessions.
  app.use(boundary(env));
  const pool = new Pool({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false, max: 5, connectionTimeoutMillis: 5000 });
  pool.on('error', () => Logger.error('Session database connection failed', 'Sessions'));
  const Store = connectPgSimple(session);
  const store = new Store({ pool, tableName: 'staff_sessions', createTableIfMissing: false, disableTouch: true, pruneSessionInterval: 60,
    errorLog: () => Logger.error('Session store operation failed', 'Sessions') });
  const applicantStore = new Store({ pool, tableName: 'applicant_sessions', createTableIfMissing: false, disableTouch: true, pruneSessionInterval: 60,
    errorLog: () => Logger.error('Applicant session store operation failed', 'Sessions') });
  const staffMiddleware = session(sessionOptions(env, store));
  const applicantMiddleware = session({ ...sessionOptions(env, applicantStore), name: env.NODE_ENV === 'production' ? '__Host-applicant.sid' : 'applicant.sid' });
  app.use((req: Request, res: Response, next: NextFunction) => (req.path.startsWith('/api/applicant/') ? applicantMiddleware : staffMiddleware)(req,res,next));
  return async () => { store.close(); applicantStore.close(); await pool.end(); };
}
