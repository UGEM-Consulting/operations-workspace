import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../src/config/environment';
import { databaseOptions } from '../src/database/options';
import { configureApp } from '../src/common/configure-app';
import { AuthModule } from '../src/modules/auth/auth.module';
import { installSessions } from '../src/modules/auth/session';
import { hashPassword } from '../src/modules/auth/password';
import { Role, User, UserStatus } from '../src/modules/users/user.entity';
import { EmailService } from '../src/modules/email/email.service';
import { EmailMfa1792790000000 } from '../src/database/migrations/1792790000000-EmailMfa';
import { enrolForTest, totpCode } from './mfa-helpers';

type Agent = ReturnType<typeof request.agent>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Staff two-step verification with email codes (isolated PostgreSQL database only)', () => {
  let app: INestApplication;
  let db: DataSource;
  let closeSessions: () => Promise<void>;
  const password = randomBytes(24).toString('base64url');
  const env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test',
    CORS_ORIGINS: 'http://localhost:3000', WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'),
    BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  const headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
  const users: Record<'admin' | 'manager' | 'it', User> = {} as never;
  // Captures codes instead of sending mail; `accept` simulates the mail server refusing a message.
  const sent: { to: string; code: string; purpose: string }[] = [];
  let accept = true;
  const email = { enabled: true, onModuleInit: () => undefined, onApplicationShutdown: async () => undefined,
    sendStaffCode: async (to: string, code: string, purpose: string) => { if (!accept) return 'ECONNECTION'; sent.push({ to, code, purpose }); return true; } };
  const agent = (): Agent => request.agent(app.getHttpServer());
  const login = (client: Agent, user: User) => client.post('/api/auth/login').set(headers).send({ email: user.email, password });
  const lastCode = (purpose: string) => [...sent].reverse().find(item => item.purpose === purpose)!.code;
  // Lets the next code be sent at once instead of waiting out the 30-second resend interval.
  const allowResend = () => db.query(`UPDATE staff_mfa_email_codes SET "sentAt" = now() - interval '1 minute'`);
  async function enrolByEmail(user: User) {
    const client = agent();
    await login(client, user).expect(200);
    expect((await client.get('/api/auth/mfa/methods').set(headers).expect(200)).body).toEqual({ methods: ['TOTP', 'EMAIL'], email: expect.stringMatching(/^m•+@example\.test$/) });
    const begin = await client.post('/api/auth/mfa/enrolment').set(headers).send({ method: 'EMAIL' }).expect(200);
    expect(begin.body).toEqual({ method: 'EMAIL', sentTo: expect.stringContaining('@example.test'), resendAfter: expect.any(Number) });
    const confirmed = await client.post('/api/auth/mfa/enrolment/confirm').set(headers).send({ code: lastCode('enrol') }).expect(200);
    return { client, recoveryCodes: confirmed.body.recoveryCodes as string[] };
  }

  beforeAll(async () => {
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must name a dedicated database ending in _test');
    db = await new DataSource(databaseOptions(env)).initialize();
    await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule] })
      .overrideProvider(EmailService).useValue(email).compile();
    app = module.createNestApplication();
    closeSessions = installSessions(app, env);
    configureApp(app, env.CORS_ORIGINS);
    await app.init();
  }, 30000);
  beforeEach(async () => {
    sent.length = 0; accept = true;
    await db.query('TRUNCATE staff_sessions, login_attempts, users CASCADE');
    await db.query(`UPDATE staff_security_settings SET "mfaRequiredFor" = 'ADMINS'`);
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['admin', Role.SYSTEM_ADMIN], ['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: 'Staff', email: `mail.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
    }
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) await db.destroy(); });

  it('enrols with email codes, then signs in with a single-use code sent for sign-in', async () => {
    const { recoveryCodes } = await enrolByEmail(users.manager);
    expect(recoveryCodes).toHaveLength(10);
    expect(sent.map(item => [item.to, item.purpose])).toEqual([['mail.manager@example.test', 'enrol']]);
    const client = agent();
    expect((await login(client, users.manager).expect(200)).body).toEqual({ mfa: 'verify', landingPage: '/login/mfa' });
    const challenge = await client.post('/api/auth/mfa/challenge').set(headers).send({}).expect(200);
    expect(challenge.body).toMatchObject({ method: 'EMAIL', sentTo: 'm••••••@example.test' });
    expect(challenge.body.resendAfter).toBeGreaterThan(0);
    // Reloading the page or asking again straight away does not send another email.
    await client.post('/api/auth/mfa/challenge').set(headers).send({}).expect(200);
    await client.post('/api/auth/mfa/challenge').set(headers).send({ resend: true }).expect(200);
    expect(sent.filter(item => item.purpose === 'login')).toHaveLength(1);
    // A code for another purpose, a wrong code and the right code twice.
    await client.post('/api/auth/mfa/verify').set(headers).send({ code: sent[0].code }).expect(401);
    const code = lastCode('login');
    await client.post('/api/auth/mfa/verify').set(headers).send({ code: code === '000000' ? '111111' : '000000' }).expect(401);
    await client.post('/api/auth/mfa/verify').set(headers).send({ code }).expect(200);
    await client.get('/api/auth/me').set(headers).expect(200);
    const again = agent();
    await login(again, users.manager).expect(200);
    await again.post('/api/auth/mfa/verify').set(headers).send({ code }).expect(401);
    const status = await client.get('/api/auth/mfa').set(headers).expect(200);
    expect(status.body).toMatchObject({ enabled: true, method: 'EMAIL', emailCodesAvailable: true });
    const enrolled = await db.query(`SELECT type, metadata FROM staff_security_events WHERE "userId" = $1 AND type = 'MFA_ENROLLED'`, [users.manager.id]);
    expect(enrolled[0].metadata).toEqual({ recoveryCodes: 10, method: 'EMAIL' });
  });

  it('confirms Account security changes only with a code sent for that purpose, and accepts recovery codes at sign-in', async () => {
    const { client, recoveryCodes } = await enrolByEmail(users.manager);
    await allowResend();
    await client.post('/api/auth/mfa/email-code').set(headers).send({}).expect(200);
    // A sign-in code cannot turn two-step verification off.
    const other = agent();
    await login(other, users.manager).expect(200);
    await other.post('/api/auth/mfa/challenge').set(headers).send({}).expect(200);
    await client.post('/api/auth/mfa/disable').set(headers).send({ code: lastCode('login') }).expect(401);
    await client.post('/api/auth/mfa/recovery-codes').set(headers).send({ code: lastCode('manage') }).expect(200);
    await other.post('/api/auth/mfa/verify').set(headers).send({ code: recoveryCodes[0] }).expect(401);
    // The regenerated codes replaced the old ones; a new sign-in uses one of those instead.
    const fresh = await db.query(`SELECT count(*)::int AS left FROM staff_mfa_recovery_codes WHERE "userId" = $1 AND "usedAt" IS NULL`, [users.manager.id]);
    expect(fresh[0].left).toBe(10);
    await allowResend();
    await client.post('/api/auth/mfa/email-code').set(headers).send({}).expect(200);
    await client.post('/api/auth/mfa/disable').set(headers).send({ code: lastCode('manage') }).expect(200);
    expect((await client.get('/api/auth/mfa').set(headers).expect(200)).body).toMatchObject({ enabled: false, method: null });
  });

  it('keeps administrators on an authenticator app, including someone promoted from email codes', async () => {
    const admin = agent();
    await login(admin, users.admin).expect(200);
    expect((await admin.get('/api/auth/mfa/methods').set(headers).expect(200)).body.methods).toEqual(['TOTP']);
    await admin.post('/api/auth/mfa/enrolment').set(headers).send({ method: 'EMAIL' }).expect(400);
    const setup = await admin.post('/api/auth/mfa/enrolment').set(headers).send({}).expect(200);
    await admin.post('/api/auth/mfa/enrolment/confirm').set(headers).send({ code: totpCode((setup.body.manualKey as string).replace(/\s/g, '')) }).expect(200);
    await enrolByEmail(users.it);
    await admin.patch(`/api/users/${users.it.id}`).set(headers).send({ role: Role.SYSTEM_ADMIN }).expect(200);
    expect(await db.query(`SELECT 1 FROM staff_mfa WHERE "userId" = $1`, [users.it.id])).toHaveLength(0);
    const promoted = agent();
    expect((await login(promoted, users.it).expect(200)).body).toEqual({ mfa: 'enrol', landingPage: '/login/mfa-setup' });
    const reset = await db.query(`SELECT "actorId", metadata FROM staff_security_events WHERE "userId" = $1 AND type = 'MFA_RESET_BY_ADMIN'`, [users.it.id]);
    expect(reset).toEqual([{ actorId: users.admin.id, metadata: { reason: 'administrator-role', method: 'EMAIL' } }]);
  });

  it('caps sends, reports delivery failures without keeping the code, and never mixes methods', async () => {
    await enrolByEmail(users.manager);
    const client = agent();
    await login(client, users.manager).expect(200);
    accept = false;
    await allowResend();
    await client.post('/api/auth/mfa/challenge').set(headers).send({ resend: true }).expect(503);
    expect(await db.query(`SELECT 1 FROM staff_mfa_email_codes WHERE "userId" = $1 AND purpose = 'login'`, [users.manager.id])).toHaveLength(0);
    accept = true;
    // The enrolment code and the failed attempt already count; five sends per 15 minutes in total.
    for (let index = 0; index < 3; index++) { await allowResend(); await client.post('/api/auth/mfa/challenge').set(headers).send({ resend: true }).expect(200); }
    await allowResend();
    await client.post('/api/auth/mfa/challenge').set(headers).send({ resend: true }).expect(429);
    // An authenticator user's challenge sends nothing.
    const secret = await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users.it.id);
    const it = agent();
    await login(it, users.it).expect(200);
    const before = sent.length;
    expect((await it.post('/api/auth/mfa/challenge').set(headers).send({ resend: true }).expect(200)).body).toEqual({ method: 'TOTP' });
    await it.post('/api/auth/mfa/email-code').set(headers).send({}).expect(401);
    expect(sent).toHaveLength(before);
    await it.post('/api/auth/mfa/verify').set(headers).send({ code: totpCode(secret) }).expect(200);
    await it.post('/api/auth/mfa/email-code').set(headers).send({}).expect(400);
  });

  it('refuses to roll back while email-code enrolments exist', async () => {
    await enrolByEmail(users.manager);
    const runner = db.createQueryRunner();
    try { await expect(new EmailMfa1792790000000().down(runner)).rejects.toThrow('Cannot discard email two-step verification enrolments'); } finally { await runner.release(); }
  });
});
