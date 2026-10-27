import { randomBytes } from 'node:crypto';
import session from 'express-session';
import { validateEnvironment, webOrigins } from '../src/config/environment';
import { canAccessAssignedApplication } from '../src/modules/auth/policy';
import { boundary, cookieName, equalSecret, sessionOptions } from '../src/modules/auth/session';
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
    expect(() => validateEnvironment({ ...env, WEB_ORIGIN: 'https://workspace.example.test,http://localhost:3000' })).toThrow('HTTPS');
    expect(() => validateEnvironment({ ...env, SESSION_SECRET: 'short' })).toThrow();
    expect(() => validateEnvironment({ ...env, SESSION_SECRET: env.BFF_SHARED_SECRET })).toThrow();
    expect(equalSecret(undefined, env.BFF_SHARED_SECRET)).toBe(false);
    expect(equalSecret('bad', env.BFF_SHARED_SECRET)).toBe(false);
    expect(equalSecret(env.BFF_SHARED_SECRET, env.BFF_SHARED_SECRET)).toBe(true);
  });
  it('accepts several exact web origins, keeping the first as primary', () => {
    const multi = validateEnvironment({ ...env, WEB_ORIGIN: ' https://workspace.ugemconsulting.com , https://workspace.example.test ' });
    expect(multi.WEB_ORIGIN).toBe('https://workspace.ugemconsulting.com,https://workspace.example.test');
    expect(webOrigins(multi)).toEqual(['https://workspace.ugemconsulting.com', 'https://workspace.example.test']);
    for (const value of ['*', 'https://*.example.test', 'https://workspace.example.test/', 'https://workspace.example.test/app', 'https://a.example.test,https://a.example.test', 'https://a.example.test,', '']) {
      expect(() => validateEnvironment({ ...env, WEB_ORIGIN: value })).toThrow();
    }
  });
  it('lets the API boundary accept a mutation from any configured web origin only', () => {
    const check = boundary(validateEnvironment({ ...env, WEB_ORIGIN: 'https://workspace.ugemconsulting.com,https://workspace.example.test' }));
    const run = (origin: string) => {
      const values: Record<string, string> = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin, 'x-csrf-protection': '1' };
      const req = { path: '/api/auth/login', method: 'POST', get: (name: string) => values[name], is: () => 'application/json' };
      let status = 0, passed = false;
      const res = { setHeader: () => undefined, status: (code: number) => { status = code; return { json: () => undefined }; } };
      check(req as never, res as never, () => { passed = true; });
      return passed ? 200 : status;
    };
    expect(run('https://workspace.ugemconsulting.com')).toBe(200);
    expect(run('https://workspace.example.test')).toBe(200);
    expect(run('https://attacker.example')).toBe(403);
    expect(run('https://workspace.ugemconsulting.com,https://workspace.example.test')).toBe(403);
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
    expect(validMutation(headers(), [origin])).toBe(true);
    for (const key of ['origin', 'x-csrf-protection', 'content-type']) { const modified = headers(); modified.delete(key); expect(validMutation(modified, [origin])).toBe(false); }
    const crossSite = headers(); crossSite.set('origin', 'https://attacker.example'); expect(validMutation(crossSite, [origin])).toBe(false);
    const form = headers(); form.set('content-type', 'application/x-www-form-urlencoded'); expect(validMutation(form, [origin])).toBe(false);
    const fetchSite = headers(); fetchSite.set('sec-fetch-site', 'cross-site'); expect(validMutation(fetchSite, [origin])).toBe(false);
  });
  it('accepts any configured web origin exactly, and nothing else', () => {
    const origins = ['https://workspace.ugemconsulting.com', origin];
    expect(validMutation(headers(), origins)).toBe(true);
    const company = headers(); company.set('origin', origins[0]); expect(validMutation(company, origins)).toBe(true);
    for (const value of ['https://evil.ugemconsulting.com', `${origin}/`, `${origins[0]},${origin}`, 'null']) {
      const modified = headers(); modified.set('origin', value); expect(validMutation(modified, origins)).toBe(false);
    }
    expect(validMutation(headers(), [])).toBe(false);
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
