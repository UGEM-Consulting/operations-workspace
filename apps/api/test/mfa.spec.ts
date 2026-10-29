import { randomBytes } from 'node:crypto';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Secret, TOTP } from 'otpauth';
import { EnvironmentError, validateEnvironment } from '../src/config/environment';
import { SecretBox, formatManualKey, matchTotp, newRecoveryCode, newTotpSecret, normalizeRecoveryCode, totpUri } from '../src/modules/auth/mfa-crypto';
import { MfaPolicy } from '../src/modules/auth/mfa.entity';
import { LOCKOUT_STEPS, MfaService, mfaRequired } from '../src/modules/auth/mfa.service';
import { Role } from '../src/modules/users/user.entity';

const code = (secret: string, timestamp: number) => new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp });
const baseEnv = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/operations_test', CORS_ORIGINS: 'http://localhost:3000', WEB_ORIGIN: 'http://localhost:3000',
  SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex') };

describe('TOTP secret encryption', () => {
  const box = new SecretBox(randomBytes(32).toString('base64'));
  it('round-trips without exposing the secret and uses a fresh IV each time', () => {
    const secret = newTotpSecret();
    const sealed = box.seal(secret, 'user-a');
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain(secret);
    expect(box.seal(secret, 'user-a')).not.toBe(sealed);
    expect(box.open(sealed, 'user-a')).toBe(secret);
  });
  it('rejects tampering, another account, another key and unknown formats', () => {
    const sealed = box.seal(newTotpSecret(), 'user-a');
    const parts = sealed.split(':');
    const data = Buffer.from(parts[3], 'base64'); data[0] ^= 1;
    expect(() => box.open([...parts.slice(0, 3), data.toString('base64')].join(':'), 'user-a')).toThrow();
    expect(() => box.open(sealed, 'user-b')).toThrow();
    expect(() => new SecretBox(randomBytes(32).toString('base64')).open(sealed, 'user-a')).toThrow();
    expect(() => box.open(sealed.replace('v1', 'v2'), 'user-a')).toThrow('Unsupported');
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow('Invalid MFA encryption key');
  });
});

describe('TOTP codes', () => {
  const secret = newTotpSecret();
  const now = 1_800_000_015_000;
  it('accepts the current and the previous step only, returning the matched step', () => {
    const step = Math.floor(now / 30_000);
    expect(matchTotp(secret, code(secret, now), now)).toBe(step);
    expect(matchTotp(secret, code(secret, now - 30_000), now)).toBe(step - 1);
    // otpauth's window is symmetric; a code for the next step is discarded.
    expect(matchTotp(secret, code(secret, now + 30_000), now)).toBeNull();
  });
  it('rejects codes outside the window and malformed input', () => {
    expect(matchTotp(secret, code(secret, now - 90_000), now)).toBeNull();
    expect(matchTotp(secret, code(secret, now + 90_000), now)).toBeNull();
    for (const token of ['', '12345', '1234567', 'abcdef', ' 123456']) expect(matchTotp(secret, token, now)).toBeNull();
  });
  it('builds a standard otpauth URI and a grouped manual key', () => {
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(totpUri(secret, 'admin@example.test', 'UGEM Workspace')).toBe(`otpauth://totp/UGEM%20Workspace:admin%40example.test?issuer=UGEM%20Workspace&secret=${secret}&algorithm=SHA1&digits=6&period=30`);
    expect(formatManualKey('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });
});

describe('recovery codes', () => {
  it('are unambiguous, unique and normalized for comparison', () => {
    const codes = Array.from({ length: 200 }, newRecoveryCode);
    expect(new Set(codes).size).toBe(200);
    for (const value of codes) expect(value).toMatch(/^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/);
    expect(normalizeRecoveryCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ABCDE FGHJK')).toBe('ABCDEFGHJK');
    for (const invalid of ['123456', 'ABCDE-FGHI1', 'ABCDE-FGHJKL', 'OOOOO-OOOOO']) expect(normalizeRecoveryCode(invalid)).toBeNull();
  });
});

describe('MFA policy and configuration', () => {
  it('always requires administrators and other roles only under the all-staff policy', () => {
    expect(mfaRequired(Role.SYSTEM_ADMIN, MfaPolicy.ADMINS)).toBe(true);
    for (const role of [Role.DISPATCHER_MANAGER, Role.IT_SPECIALIST]) {
      expect(mfaRequired(role, MfaPolicy.ADMINS)).toBe(false);
      expect(mfaRequired(role, MfaPolicy.ALL_STAFF)).toBe(true);
    }
  });
  it('validates the encryption key structurally without printing it', () => {
    expect(validateEnvironment({ ...baseEnv, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') }).MFA_ENCRYPTION_KEY).toBeDefined();
    expect(validateEnvironment(baseEnv).MFA_ENCRYPTION_KEY).toBeUndefined();
    const short = randomBytes(16).toString('base64');
    expect(() => validateEnvironment({ ...baseEnv, MFA_ENCRYPTION_KEY: short })).toThrow(EnvironmentError);
    try { validateEnvironment({ ...baseEnv, MFA_ENCRYPTION_KEY: short }); } catch (error) { expect((error as Error).message).not.toContain(short); }
    expect(() => validateEnvironment({ ...baseEnv, MFA_ENCRYPTION_KEY: 'not base64!' })).toThrow(EnvironmentError);
  });
  it('refuses to start the production API without the encryption key', () => {
    const config = (values: Record<string, string>) => ({ get: (key: string) => values[key] }) as never;
    expect(() => new MfaService({} as never, config({ NODE_ENV: 'production' }), {} as never)).toThrow('MFA_ENCRYPTION_KEY');
    expect(() => new MfaService({} as never, config({ NODE_ENV: 'production', MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') }), {} as never)).not.toThrow();
    expect(() => new MfaService({} as never, config({ NODE_ENV: 'development' }), {} as never)).not.toThrow();
  });
});

describe('MFA enrolment and pending-step checks in the service', () => {
  const service = new MfaService({} as never, ({ get: () => undefined }) as never, {} as never);
  const user = { id: 'user-a', authVersion: 3 };
  const pending = (overrides: Record<string, unknown>) => ({ userId: 'user-a', authVersion: 3, stage: 'enrol', expiresAt: Date.now() + 60_000, ...overrides });
  const req = (session: Record<string, unknown>) => ({ session, currentUser: user }) as never;
  it('admits only a matching, unexpired pending enrolment or a full session of the same user and version', async () => {
    for (const session of [
      { mfaPending: pending({ stage: 'verify' }) }, { mfaPending: pending({ stage: 'password' }) }, { mfaPending: pending({ expiresAt: Date.now() - 1 }) },
      { mfaPending: pending({ userId: 'user-b' }) }, { mfaPending: pending({ authVersion: 2 }) }, {},
      { userId: 'user-b', authVersion: 3 }, { userId: 'user-a', authVersion: 2 }, { userId: 'user-a', authVersion: 3, mfaPending: pending({}) },
    ]) {
      await expect(service.beginEnrolment(req(session))).rejects.toThrow(UnauthorizedException);
      await expect(service.confirmEnrolment(req(session), '123456')).rejects.toThrow(UnauthorizedException);
    }
    // Valid sessions get past the session check; this server has no encryption key configured.
    for (const session of [{ mfaPending: pending({}) }, { userId: 'user-a', authVersion: 3 }]) {
      await expect(service.beginEnrolment(req(session))).rejects.toThrow(ServiceUnavailableException);
    }
  });
  it('escalates lockouts without a permanent lock', () => {
    expect(LOCKOUT_STEPS).toEqual([900, 3600]);
  });
});

describe('Staff email codes', () => {
  it('sends six random digits, masks addresses and keeps the email to the code and its purpose', () => {
    const { generateEmailCode, maskEmail, emailCodeHash } = jest.requireActual('../src/modules/auth/mfa-email');
    const { staffCodeEmail } = jest.requireActual('../src/modules/email/staff-code-email');
    for (let index = 0; index < 50; index++) expect(generateEmailCode()).toMatch(/^[0-9]{6}$/);
    expect(maskEmail('jordan.lee@example.test')).toBe('j••••••@example.test');
    expect(maskEmail('al@example.test')).toBe('a•••@example.test');
    expect(emailCodeHash('user-a', 'login', '123456')).not.toBe(emailCodeHash('user-a', 'manage', '123456'));
    expect(emailCodeHash('user-a', 'login', '123456')).not.toBe(emailCodeHash('user-b', 'login', '123456'));
    const message = staffCodeEmail('123456', 'login');
    expect(message.text).toContain('123456');
    expect(message.text).toContain('to finish signing in');
    expect(`${message.text}${message.html}`).not.toMatch(/https?:|@/);
    expect(() => staffCodeEmail('12345', 'login')).toThrow();
  });
});
