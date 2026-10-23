import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { validateEnvironment } from '../src/config/environment';
import { EmailService, deliveryFailureCode } from '../src/modules/email/email.service';
import { verificationEmail } from '../src/modules/email/verification-email';
import { generateVerificationCode, VERIFICATION_CODE_PATTERN } from '../src/modules/onboarding/verification-code';
const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/operations', WEB_ORIGIN: 'https://workspace.example.test', CORS_ORIGINS: 'https://workspace.example.test', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex') };
const password = randomBytes(12).toString('hex');
const smtp = { ...base, EMAIL_DELIVERY: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'sender@example.test', SMTP_PASSWORD: password, EMAIL_FROM: 'Operations <sender@example.test>' };
const local = { ...smtp, NODE_ENV: 'development', WEB_ORIGIN: 'http://localhost:3000', CORS_ORIGINS: 'http://localhost:3000', SMTP_HOST: 'localhost', SMTP_PORT: '1025', SMTP_USER: '', SMTP_PASSWORD: '' };
describe('Deployment configuration', () => {
  it('defaults a hosted deployment to production with email delivery off, so verification fails closed', () => {
    expect(validateEnvironment(base)).toMatchObject({ DEPLOYMENT_PURPOSE: 'production', EMAIL_DELIVERY: 'none' });
    expect(new EmailService(new ConfigService(validateEnvironment(base))).enabled).toBe(false);
  });
  it.each([
    { DEPLOYMENT_PURPOSE: 'demo' }, { DEMO_EMAIL_MODE: 'true' }, { DEMO_STARTER_MODE: 'true' }, { DEMO_FICTIONAL_DATA_ONLY: 'true' },
    { DEMO_DEPLOYMENT_ID: randomUUID() }, { DEMO_MAILBOX_KEY: randomBytes(32).toString('base64') },
  ])('refuses settings from the retired demo deployment %#', override => { expect(() => validateEnvironment({ ...base, ...override })).toThrow('retired'); });
  it('ignores blank or false leftovers of retired demo settings', () => {
    expect(() => validateEnvironment({ ...base, DEMO_EMAIL_MODE: 'false', DEMO_MAILBOX_KEY: '' })).not.toThrow();
  });
});
describe('SMTP delivery configuration', () => {
  it.each(['465', '587'])('accepts authenticated TLS on port %s in production', port => {
    expect(validateEnvironment({ ...smtp, SMTP_PORT: port })).toMatchObject({ EMAIL_DELIVERY: 'smtp', SMTP_PORT: Number(port) });
    expect(new EmailService(new ConfigService(validateEnvironment({ ...smtp, SMTP_PORT: port }))).enabled).toBe(true);
  });
  it.each(['sender@example.test', 'UGEM Operations <sender@example.test>', '<sender@example.test>'])('accepts the single sender %s', from => {
    expect(validateEnvironment({ ...smtp, EMAIL_FROM: from }).EMAIL_FROM).toBe(from);
  });
  it.each([
    { SMTP_PORT: '25' }, { SMTP_USER: '', SMTP_PASSWORD: '' }, { SMTP_PASSWORD: '' }, { SMTP_HOST: '' }, { EMAIL_FROM: '' },
    { EMAIL_FROM: 'Operations' }, { EMAIL_FROM: 'sender@example.test\r\nBcc: victim@example.test' },
    { EMAIL_FROM: 'Ops <a@example.test>, <b@example.test>' }, { EMAIL_FROM: 'x@y <a@example.test>' }, { EMAIL_FROM: 'a@example.test, b@example.test' },
    { SMTP_HOST: 'localhost', SMTP_PORT: '1025', SMTP_USER: '', SMTP_PASSWORD: '' },
  ])('rejects unsafe or incomplete production SMTP settings %#', override => { expect(() => validateEnvironment({ ...smtp, ...override })).toThrow(); });
  it('allows only a local test inbox outside production, never a real mail server', () => {
    expect(validateEnvironment(local).SMTP_HOST).toBe('localhost');
    expect(() => validateEnvironment({ ...local, SMTP_HOST: 'smtp.gmail.com' })).toThrow('local test inbox');
    expect(() => validateEnvironment({ ...local, SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'sender@example.test', SMTP_PASSWORD: password })).toThrow('local test inbox');
  });
  it('never includes the SMTP password in validation errors', () => {
    try { validateEnvironment({ ...smtp, SMTP_PORT: '25' }); throw new Error('expected rejection'); }
    catch (error) { expect(error instanceof Error && error.message.includes(password)).toBe(false); }
  });
});
describe('Verification codes and email content', () => {
  it('generates codes matching the single shared format', () => {
    for (let i = 0; i < 50; i++) expect(generateVerificationCode()).toMatch(VERIFICATION_CODE_PATTERN);
  });
  it('contains only the one-time code and expiry guidance', () => {
    const message = verificationEmail('01234567');
    expect(message.text).toContain('01234567');
    expect(message.html).toContain('01234567');
    expect(message.subject).not.toContain('01234567');
    expect(`${message.text}${message.html}`).not.toMatch(/apply|https?:\/\//);
  });
  it('refuses anything other than an eight-digit code', () => {
    for (const code of ['1234567', '123456789', '<script>', '']) expect(() => verificationEmail(code)).toThrow();
  });
});
describe('Delivery attempts', () => {
  const service = (sendMail: jest.Mock) => {
    const email = new EmailService(new ConfigService(validateEnvironment(smtp)));
    Object.assign(email, { transport: { sendMail } });
    jest.spyOn((email as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
    return email;
  };
  it('reports false instead of throwing when delivery is disabled', async () => {
    await expect(new EmailService(new ConfigService(validateEnvironment(base))).sendVerificationCode('person@example.test', '01234567')).resolves.toBe(false);
  });
  it('retries a transient failure', async () => {
    const sendMail = jest.fn().mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })).mockResolvedValueOnce({});
    await expect(service(sendMail).sendVerificationCode('person@example.test', '01234567')).resolves.toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
  it('does not retry a permanent failure such as rejected credentials', async () => {
    const sendMail = jest.fn().mockRejectedValue(Object.assign(new Error('535 bad credentials'), { code: 'EAUTH' }));
    await expect(service(sendMail).sendVerificationCode('person@example.test', '01234567')).resolves.toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
  it('finishes background work before shutdown', async () => {
    const email = new EmailService(new ConfigService(validateEnvironment(base)));
    let done = false;
    email.runInBackground(async () => { await new Promise(resolve => setTimeout(resolve, 50)); done = true; });
    await email.onApplicationShutdown();
    expect(done).toBe(true);
  });
  it('logs only allowlisted SMTP failure codes', () => {
    expect(deliveryFailureCode(Object.assign(new Error('535 user@example.test bad credentials'), { code: 'EAUTH' }))).toBe('EAUTH');
    expect(deliveryFailureCode(Object.assign(new Error('secret detail'), { code: 'SOMETHING_ELSE' }))).toBe('SEND_FAILED');
    expect(deliveryFailureCode('raw string')).toBe('SEND_FAILED');
  });
});
