import { randomBytes, randomUUID } from 'node:crypto';
import { validateEnvironment } from '../src/config/environment';
import { allowedEndpoint } from '../../web/src/lib/bff-policy';
import { bootstrapIdentity } from '../src/database/bootstrap-admin';
const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/fictional_demo', WEB_ORIGIN: 'https://workspace-demo.example.test', CORS_ORIGINS: 'https://workspace-demo.example.test', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex') };
const demo = { ...base, DEPLOYMENT_PURPOSE: 'demo', DEMO_EMAIL_MODE: 'true', DEMO_FICTIONAL_DATA_ONLY: 'true', DEMO_DEPLOYMENT_ID: randomUUID(), DEMO_MAILBOX_KEY: randomBytes(32).toString('base64') };
describe('Demo verification configuration fails closed', () => {
  it('defaults a hosted deployment to production with no simulator', () => {
    expect(validateEnvironment(base)).toMatchObject({ DEPLOYMENT_PURPOSE: 'production', DEMO_EMAIL_MODE: false });
  });
  it('rejects real administrator addresses before demo bootstrap can insert them', () => {
    expect(() => bootstrapIdentity({ DEPLOYMENT_PURPOSE: 'demo', BOOTSTRAP_ADMIN_EMAIL: 'person@company.example', BOOTSTRAP_ADMIN_FIRST_NAME: 'Fictional', BOOTSTRAP_ADMIN_LAST_NAME: 'Demo' })).toThrow('fictional');
  });
  it('uses production runtime cookie security on an explicitly isolated demo deployment', () => {
    expect(validateEnvironment(demo)).toMatchObject({ NODE_ENV: 'production', DEPLOYMENT_PURPOSE: 'demo', DEMO_EMAIL_MODE: true });
  });
  it.each([
    { DEPLOYMENT_PURPOSE: 'production' }, { DEMO_EMAIL_MODE: 'false' }, { DEMO_FICTIONAL_DATA_ONLY: 'false' },
    { DEMO_DEPLOYMENT_ID: '' }, { DEMO_DEPLOYMENT_ID: 'invalid' }, { DEMO_MAILBOX_KEY: '' }, { DEMO_MAILBOX_KEY: 'invalid' },
    { DATABASE_URL: 'postgresql://localhost/operations' }, { WEB_ORIGIN: 'https://workspace.example.test' },
    { DEPLOYMENT_PURPOSE: 'local', NODE_ENV: 'development' },
  ])('rejects incomplete or unsafe designation %#', override => { expect(() => validateEnvironment({ ...demo, ...override })).toThrow(); });
  it('does not let NODE_ENV=development enable simulation on a production-designated deployment', () => {
    expect(() => validateEnvironment({ ...demo, NODE_ENV: 'development', DEPLOYMENT_PURPOSE: 'production' })).toThrow();
  });
  it('rejects leftover simulator keys on ordinary production configuration', () => {
    expect(() => validateEnvironment({ ...base, DEMO_MAILBOX_KEY: demo.DEMO_MAILBOX_KEY })).toThrow();
  });
  it('never includes an invalid mailbox key in validation errors', () => {
    const marker = randomBytes(30).toString('hex');
    try { validateEnvironment({ ...demo, DEMO_MAILBOX_KEY: marker }); throw new Error('expected rejection'); }
    catch (error) { expect(error instanceof Error && error.message.includes(marker)).toBe(false); }
  });
  it('allows existing names only with explicit starter mode, never ordinary production purpose', () => {
    expect(validateEnvironment({ ...demo, DEMO_STARTER_MODE: true, DATABASE_URL: 'postgresql://localhost/operations', WEB_ORIGIN: 'https://workspace.example.test' }).DEMO_STARTER_MODE).toBe(true);
    expect(() => validateEnvironment({ ...base, DEMO_STARTER_MODE: true })).toThrow();
    expect(() => validateEnvironment({ ...demo, DEMO_STARTER_MODE: true, DEPLOYMENT_PURPOSE: 'production' })).toThrow();
  });
  it('exposes only the exact authenticated mailbox transport routes', () => {
    expect(allowedEndpoint('GET', 'demo-mailbox')).toBe(true);
    expect(allowedEndpoint('POST', `demo-mailbox/${randomUUID()}/reveal`)).toBe(true);
    expect(allowedEndpoint('GET', `demo-mailbox/${randomUUID()}/reveal`)).toBe(false);
    expect(allowedEndpoint('GET', 'applicant/codes')).toBe(false);
  });
});
