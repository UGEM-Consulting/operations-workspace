import { randomBytes } from 'node:crypto';
import { validateEnvironment } from '../src/config/environment';
import { statusMessage } from '../src/modules/updates/status-messages';

const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000', WEB_ORIGIN: 'http://localhost:3000',
  SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex') };
const bot = { TELEGRAM_DELIVERY: 'bot', TELEGRAM_BOT_TOKEN: `12345678:${'a'.repeat(35)}`, TELEGRAM_BOT_USERNAME: 'ugem_updates_bot' };
const production = { ...base, NODE_ENV: 'production', DEPLOYMENT_PURPOSE: 'production', WEB_ORIGIN: 'https://workspace.example.test', CORS_ORIGINS: 'https://workspace.example.test', STORAGE_DRIVER: 'gcs' };

describe('Telegram update settings', () => {
  it('is off by default and needs a token and bot username when switched on', () => {
    expect(validateEnvironment(base).TELEGRAM_DELIVERY).toBe('none');
    expect(() => validateEnvironment({ ...base, TELEGRAM_DELIVERY: 'bot', TELEGRAM_API_BASE: 'http://127.0.0.1:9' })).toThrow('requires TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME');
    expect(() => validateEnvironment({ ...base, ...bot, TELEGRAM_BOT_TOKEN: 'not-a-token', TELEGRAM_API_BASE: 'http://127.0.0.1:9' })).toThrow('TELEGRAM_BOT_TOKEN (string.pattern.base)');
    expect(() => validateEnvironment({ ...base, ...bot, TELEGRAM_BOT_USERNAME: 'ugem_updates', TELEGRAM_API_BASE: 'http://127.0.0.1:9' })).toThrow('TELEGRAM_BOT_USERNAME');
  });
  it('only reaches a local fake outside production and only the real Bot API in production', () => {
    expect(() => validateEnvironment({ ...base, ...bot })).toThrow('Outside production, TELEGRAM_API_BASE may only target a local test server');
    expect(validateEnvironment({ ...base, ...bot, TELEGRAM_API_BASE: 'http://[::1]:8081' }).TELEGRAM_API_BASE).toBe('http://[::1]:8081');
    const gcs = { GCS_BUCKET: 'ugem-test-bucket', GCS_CREDENTIALS_BASE64: Buffer.from(JSON.stringify({ type: 'service_account', client_email: 'a@example.test', private_key: 'k' })).toString('base64') };
    expect(validateEnvironment({ ...production, ...gcs, ...bot }).TELEGRAM_API_BASE).toBe('https://api.telegram.org');
    expect(() => validateEnvironment({ ...production, ...gcs, ...bot, TELEGRAM_API_BASE: 'https://telegram.example.test' })).toThrow('Production TELEGRAM_API_BASE must be the Telegram Bot API');
  });
});
describe('Status update messages', () => {
  const reference = '7b49ce28-af24-41d9-aad0-618340cd5aa1', url = 'https://workspace.example.test/apply/resume';
  it('gives the reference and the resume page for each decision, and the correction deadline for change requests', () => {
    const changes = statusMessage('CHANGES_REQUESTED', reference, url, new Date('2026-11-26T12:00:00Z'));
    expect(changes.subject).toBe('Changes requested on your UGEM application');
    expect(changes.text).toContain('November 26, 2026');
    for (const status of ['CHANGES_REQUESTED', 'APPROVED', 'REJECTED'] as const) {
      const message = statusMessage(status, reference, url, new Date());
      for (const text of [message.text, message.html, message.telegram]) { expect(text).toContain(reference); expect(text).toContain(url); }
    }
    expect(statusMessage('REJECTED', reference, url, new Date()).text).not.toMatch(/reason/i);
  });
});
