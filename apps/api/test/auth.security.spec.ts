import { randomBytes } from 'node:crypto';
import session from 'express-session';
import { validateEnvironment } from '../src/config/environment';
import { canAccessAssignedApplication } from '../src/modules/auth/policy';
import { cookieName, equalSecret, sessionOptions } from '../src/modules/auth/session';
import { Role, UserStatus } from '../src/modules/users/user.entity';
import { allowedEndpoint, validMutation } from '../../web/src/lib/bff-policy';

describe('Security configuration and future assignment policy', () => {
  const env = validateEnvironment({ DATABASE_URL: 'postgresql://localhost/test', CORS_ORIGINS: 'https://workspace.example.test', WEB_ORIGIN: 'https://workspace.example.test', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), NODE_ENV: 'production' });
  it('uses host-only Secure HttpOnly SameSite cookies in production', () => {
    const options = sessionOptions(env, new session.MemoryStore());
    expect(options.cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 28800000 });
    expect(options.cookie).not.toHaveProperty('domain');
    expect(cookieName(true)).toBe('__Host-operations.sid');
    expect(options.saveUninitialized).toBe(false);
    expect(options.resave).toBe(false);
  });
  it('requires HTTPS and separate strong secrets in production', () => {
    expect(() => validateEnvironment({ ...env, WEB_ORIGIN: 'http://localhost:3000' })).toThrow();
    expect(() => validateEnvironment({ ...env, SESSION_SECRET: 'short' })).toThrow();
    expect(() => validateEnvironment({ ...env, SESSION_SECRET: env.BFF_SHARED_SECRET })).toThrow();
    expect(equalSecret(undefined, env.BFF_SHARED_SECRET)).toBe(false);
    expect(equalSecret('bad', env.BFF_SHARED_SECRET)).toBe(false);
    expect(equalSecret(env.BFF_SHARED_SECRET, env.BFF_SHARED_SECRET)).toBe(true);
  });
  it('requires a database-loaded manager assignment and an active role', () => {
    const manager = { id: 'manager-one', role: Role.DISPATCHER_MANAGER, status: UserStatus.ACTIVE };
    expect(canAccessAssignedApplication(manager, { assignedManagerId: manager.id })).toBe(true);
    expect(canAccessAssignedApplication(manager, { assignedManagerId: 'another-manager' })).toBe(false);
    expect(canAccessAssignedApplication(manager, { assignedManagerId: null })).toBe(false);
    expect(canAccessAssignedApplication({ ...manager, status: UserStatus.INACTIVE }, { assignedManagerId: manager.id })).toBe(false);
    expect(canAccessAssignedApplication({ ...manager, role: Role.IT_SPECIALIST }, { assignedManagerId: manager.id })).toBe(false);
  });
});
describe('Next.js same-origin transport boundary', () => {
  const origin = 'https://workspace.vercel.app';
  const headers = () => new Headers({ origin, 'x-csrf-protection': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' });
  it('requires exact origin, non-simple header and JSON content type', () => {
    expect(validMutation(headers(), origin)).toBe(true);
    for (const key of ['origin', 'x-csrf-protection', 'content-type']) { const modified = headers(); modified.delete(key); expect(validMutation(modified, origin)).toBe(false); }
    const crossSite = headers(); crossSite.set('origin', 'https://attacker.example'); expect(validMutation(crossSite, origin)).toBe(false);
    const form = headers(); form.set('content-type', 'application/x-www-form-urlencoded'); expect(validMutation(form, origin)).toBe(false);
    const fetchSite = headers(); fetchSite.set('sec-fetch-site', 'cross-site'); expect(validMutation(fetchSite, origin)).toBe(false);
  });
  it('cannot proxy arbitrary API paths or methods', () => {
    expect(allowedEndpoint('POST', 'auth/login')).toBe(true);
    expect(allowedEndpoint('POST', 'auth/register')).toBe(false);
    for (const path of ['auth/mfa/verify', 'auth/mfa/enrolment', 'auth/mfa/enrolment/confirm', 'auth/mfa/recovery-codes', 'auth/mfa/disable']) expect(allowedEndpoint('POST', path)).toBe(true);
    expect(allowedEndpoint('GET', 'auth/mfa')).toBe(true);
    expect(allowedEndpoint('PATCH', 'settings/security')).toBe(true);
    expect(allowedEndpoint('POST', 'users/00000000-0000-4000-8000-000000000000/mfa/reset')).toBe(true);
    expect(allowedEndpoint('POST', 'users/../mfa/reset')).toBe(false);
    expect(allowedEndpoint('GET', 'auth/mfa/enrolment')).toBe(false);
    expect(allowedEndpoint('DELETE', 'auth/mfa')).toBe(false);
    expect(allowedEndpoint('GET', '../health')).toBe(false);
    expect(allowedEndpoint('DELETE', 'users')).toBe(false);
  });
});
