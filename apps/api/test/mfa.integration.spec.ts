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
import { StaffMfa1792720000000 } from '../src/database/migrations/1792720000000-StaffMfa';
import { attemptKey } from '../src/modules/auth/attempts';
import { enrolForTest, totpCode } from './mfa-helpers';

type Agent = ReturnType<typeof request.agent>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Staff two-step verification (isolated PostgreSQL database only)', () => {
  let app: INestApplication;
  let db: DataSource;
  let closeSessions: () => Promise<void>;
  const password = randomBytes(24).toString('base64url');
  const env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test',
    CORS_ORIGINS: 'http://localhost:3000', WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'),
    BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  const headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
  const users: Record<'admin' | 'admin2' | 'manager' | 'it', User> = {} as never;
  const agent = (): Agent => request.agent(app.getHttpServer());
  const login = (client: Agent, user: User) => client.post('/api/auth/login').set(headers).send({ email: user.email, password });
  const verify = (client: Agent, code: string) => client.post('/api/auth/mfa/verify').set(headers).send({ code });
  const events = async (userId: string) => (await db.query(`SELECT type, "actorId", metadata FROM staff_security_events WHERE "userId" = $1 ORDER BY "createdAt"`, [userId])) as { type: string; actorId: string | null; metadata: Record<string, unknown> }[];
  const clearReplay = (userId: string) => db.query(`UPDATE staff_mfa SET "lastUsedStep" = NULL WHERE "userId" = $1`, [userId]);
  /** Enrols through the real API from a forced or voluntary enrolment session. */
  async function enrolViaApi(client: Agent) {
    const setup = await client.post('/api/auth/mfa/enrolment').set(headers).send({}).expect(200);
    const secret = (setup.body.manualKey as string).replace(/\s/g, '');
    const confirmed = await client.post('/api/auth/mfa/enrolment/confirm').set(headers).send({ code: totpCode(secret) }).expect(200);
    return { setup: setup.body, secret, recoveryCodes: confirmed.body.recoveryCodes as string[], confirmed };
  }

  beforeAll(async () => {
    // Explicit opt-in and a dedicated database name prevent accidental use of application data.
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must name a dedicated database ending in _test');
    db = await new DataSource(databaseOptions(env)).initialize();
    await db.runMigrations();
    await db.query('TRUNCATE staff_sessions, login_attempts, users CASCADE');
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['admin', Role.SYSTEM_ADMIN], ['admin2', Role.SYSTEM_ADMIN], ['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: 'Staff', email: `mfa.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
    }
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule] }).compile();
    app = module.createNestApplication();
    closeSessions = installSessions(app, env);
    configureApp(app, env.CORS_ORIGINS);
    await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE login_attempts, staff_security_events, staff_mfa, staff_mfa_recovery_codes');
    await db.query(`UPDATE staff_security_settings SET "mfaRequiredFor" = 'ADMINS'`);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) await db.destroy(); });

  it('forces administrator enrolment before any staff access and stores only ciphertext and hashes', async () => {
    const client = agent();
    expect((await login(client, users.admin).expect(200)).body).toEqual({ mfa: 'enrol', landingPage: '/login/mfa-setup' });
    for (const path of ['/api/auth/me', '/api/users', '/api/auth/mfa', '/api/access/dashboard']) await client.get(path).set(headers).expect(401);
    await verify(client, '123456').expect(401);
    const setup = await client.post('/api/auth/mfa/enrolment').set(headers).send({}).expect(200);
    expect(setup.body.qrCode).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(setup.body.uri).toMatch(/^otpauth:\/\/totp\/UGEM%20Workspace:mfa\.admin%40example\.test\?/);
    const secret = (setup.body.manualKey as string).replace(/\s/g, '');
    await client.post('/api/auth/mfa/enrolment/confirm').set(headers).send({ code: totpCode(secret, 5) }).expect(401);
    await client.get('/api/auth/me').set(headers).expect(401);
    const confirmed = await client.post('/api/auth/mfa/enrolment/confirm').set(headers).send({ code: totpCode(secret) }).expect(200);
    expect(confirmed.body.user.role).toBe(Role.SYSTEM_ADMIN);
    expect(confirmed.body.recoveryCodes).toHaveLength(10);
    expect(new Set(confirmed.body.recoveryCodes).size).toBe(10);
    await client.get('/api/auth/me').set(headers).expect(200);
    const [stored] = await db.query(`SELECT "secretCiphertext", "confirmedAt" FROM staff_mfa WHERE "userId" = $1`, [users.admin.id]);
    expect(stored.confirmedAt).not.toBeNull();
    expect(stored.secretCiphertext).toMatch(/^v1:/);
    expect(stored.secretCiphertext).not.toContain(secret);
    const codes: { codeHash: string }[] = await db.query(`SELECT "codeHash" FROM staff_mfa_recovery_codes WHERE "userId" = $1`, [users.admin.id]);
    expect(codes).toHaveLength(10);
    for (const { codeHash } of codes) expect(codeHash).toMatch(/^\$argon2id\$/);
    const audit = await events(users.admin.id);
    expect(audit).toEqual([{ type: 'MFA_ENROLLED', actorId: null, metadata: { recoveryCodes: 10, method: 'TOTP' } }]);
    expect(JSON.stringify(audit)).not.toContain(secret);
    await client.post('/api/auth/mfa/enrolment').set(headers).send({}).expect(409);
  });

  it('signs in with a code, rejects wrong and replayed codes, and grants nothing while pending', async () => {
    const secret = await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users.admin.id);
    const pending = agent();
    expect((await login(pending, users.admin).expect(200)).body).toEqual({ mfa: 'verify', landingPage: '/login/mfa' });
    await pending.get('/api/auth/me').set(headers).expect(401);
    await pending.post('/api/auth/mfa/enrolment').set(headers).send({}).expect(401);
    await verify(pending, totpCode(secret, 3)).expect(401);
    await verify(pending, '<code>').expect(400);
    await pending.post('/api/auth/mfa/verify').set(headers).send({ code: totpCode(secret), extra: true }).expect(400);
    const code = totpCode(secret);
    const signedIn = await verify(pending, code).expect(200);
    expect(signedIn.body.user.id).toBe(users.admin.id);
    await pending.get('/api/auth/me').set(headers).expect(200);
    // The same code cannot complete another sign-in, even in a new session.
    const replay = agent();
    await login(replay, users.admin).expect(200);
    await verify(replay, code).expect(401);
    await replay.get('/api/auth/me').set(headers).expect(401);
    // A completed session cannot use the verify step again.
    await verify(pending, totpCode(secret, 1)).expect(401);
  });

  it('accepts each recovery code once and records only metadata', async () => {
    const client = agent();
    await login(client, users.admin).expect(200);
    const { recoveryCodes, secret } = await enrolViaApi(client);
    const recovery = agent();
    await login(recovery, users.admin).expect(200);
    const used = await verify(recovery, recoveryCodes[0].toLowerCase().replace('-', ' ')).expect(200);
    expect(used.body.recoveryCodesRemaining).toBe(9);
    await recovery.get('/api/auth/me').set(headers).expect(200);
    const again = agent();
    await login(again, users.admin).expect(200);
    await verify(again, recoveryCodes[0]).expect(401);
    const audit = await events(users.admin.id);
    expect(audit.map(event => event.type)).toEqual(['MFA_ENROLLED', 'MFA_RECOVERY_CODE_USED']);
    expect(audit[1].metadata).toEqual({ remaining: 9 });
    expect(JSON.stringify(audit)).not.toContain(recoveryCodes[0]);
    // Regenerating requires a current authenticator code (not a recovery code) and replaces all codes.
    await recovery.post('/api/auth/mfa/recovery-codes').set(headers).send({ code: recoveryCodes[1] }).expect(401);
    await clearReplay(users.admin.id);
    const regenerated = await recovery.post('/api/auth/mfa/recovery-codes').set(headers).send({ code: totpCode(secret) }).expect(200);
    expect(regenerated.body.recoveryCodes).toHaveLength(10);
    const old = agent();
    await login(old, users.admin).expect(200);
    await verify(old, recoveryCodes[1]).expect(401);
  }, 30000);

  it('locks out after five wrong codes across sessions, even for a correct code', async () => {
    const secret = await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users.admin.id);
    const first = agent();
    await login(first, users.admin).expect(200);
    // Codes five steps ahead are outside the ±1 step drift window.
    for (let attempt = 0; attempt < 5; attempt++) await verify(first, totpCode(secret, 5 + attempt)).expect(401);
    const client = agent();
    await login(client, users.admin).expect(200);
    await verify(client, totpCode(secret)).expect(429);
    await verify(client, totpCode(secret)).expect(429);
    await client.get('/api/auth/me').set(headers).expect(401);
    expect((await events(users.admin.id)).map(event => event.type)).toEqual(['MFA_LOCKED_OUT']);
  });

  it('lengthens a repeated lockout to one hour, never longer', async () => {
    const secret = await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users.admin.id);
    const client = agent();
    await login(client, users.admin).expect(200);
    const endLock = () => db.query(`UPDATE login_attempts SET "expiresAt" = now() - interval '1 second' WHERE key = $1`, [attemptKey('mfa-lock', users.admin.id)]);
    for (const label of ['15 minutes', '1 hour', '1 hour']) {
      for (let attempt = 0; attempt < 5; attempt++) await verify(client, totpCode(secret, 10)).expect(401);
      expect((await verify(client, totpCode(secret, 10)).expect(429)).body.message).toBe(`Too many incorrect codes. Try again in ${label}.`);
      // While locked, even a correct code is refused without extending the lock.
      expect((await verify(client, totpCode(secret)).expect(429)).body.message).toBe('Too many incorrect codes. Try again later.');
      await endLock();
    }
    const lockouts = (await events(users.admin.id)).filter(event => event.type === 'MFA_LOCKED_OUT').map(event => event.metadata);
    expect(lockouts).toEqual([900, 3600, 3600].map((lockoutSeconds, index) => ({ lockoutSeconds, lockoutsInSeries: index + 1 })));
    // Once the lock ends, the correct code works again.
    await verify(client, totpCode(secret)).expect(200);
  }, 30000);

  it('ends existing sessions when a user enrols, and makes old unverified sessions re-authenticate', async () => {
    const before = agent();
    await login(before, users.manager).expect(200);
    await before.get('/api/auth/me').set(headers).expect(200);
    const enrolling = agent();
    await login(enrolling, users.manager).expect(200);
    const { confirmed } = await enrolViaApi(enrolling);
    expect(confirmed.body.user.id).toBe(users.manager.id);
    await before.get('/api/auth/me').set(headers).expect(401);
    await enrolling.get('/api/auth/me').set(headers).expect(200);
    const status = await enrolling.get('/api/auth/mfa').set(headers).expect(200);
    expect(status.body).toMatchObject({ enabled: true, required: false, policy: 'ADMINS', recoveryCodesRemaining: 10 });
    // A session from before MFA existed (no verification flag) no longer works once the user is enrolled.
    const legacy = agent();
    await login(legacy, users.it).expect(200);
    await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users.it.id);
    await legacy.get('/api/auth/me').set(headers).expect(401);
  });

  it('lets optional roles turn MFA off with a code, but never administrators', async () => {
    const admin = agent();
    await login(admin, users.admin).expect(200);
    const adminEnrolment = await enrolViaApi(admin);
    await clearReplay(users.admin.id);
    await admin.post('/api/auth/mfa/disable').set(headers).send({ code: totpCode(adminEnrolment.secret) }).expect(400);
    const manager = agent();
    await login(manager, users.manager).expect(200);
    const { secret } = await enrolViaApi(manager);
    const other = agent();
    await login(other, users.manager).expect(200);
    await clearReplay(users.manager.id);
    await verify(other, totpCode(secret)).expect(200);
    await manager.post('/api/auth/mfa/disable').set(headers).send({ code: totpCode(secret, 5) }).expect(401);
    await clearReplay(users.manager.id);
    await manager.post('/api/auth/mfa/disable').set(headers).send({ code: totpCode(secret) }).expect(200);
    await manager.get('/api/auth/me').set(headers).expect(200);
    await other.get('/api/auth/me').set(headers).expect(401);
    expect((await login(agent(), users.manager).expect(200)).body.user.id).toBe(users.manager.id);
    expect((await events(users.manager.id)).map(event => event.type)).toEqual(['MFA_ENROLLED', 'MFA_DISABLED']);
  });

  it('lets administrators reset another user without seeing secrets, revoking that user’s sessions', async () => {
    const adminSecret = await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users.admin.id);
    const admin = agent();
    await login(admin, users.admin).expect(200);
    await verify(admin, totpCode(adminSecret)).expect(200);
    const target = agent();
    await login(target, users.admin2).expect(200);
    const { secret } = await enrolViaApi(target);
    const list = await admin.get('/api/users').set(headers).expect(200);
    expect(list.body.find((user: { id: string }) => user.id === users.admin2.id).mfaEnabled).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/secret|codeHash|ciphertext/i);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    const manager = agent();
    await login(manager, users.manager).expect(200);
    await manager.post(`/api/users/${users.admin2.id}/mfa/reset`).set(headers).send({}).expect(403);
    await admin.post(`/api/users/${users.admin.id}/mfa/reset`).set(headers).send({}).expect(400);
    await admin.post(`/api/users/${users.admin2.id}/mfa/reset`).set({ ...headers, origin: 'https://attacker.example' }).send({}).expect(403);
    const reset = await admin.post(`/api/users/${users.admin2.id}/mfa/reset`).set(headers).send({}).expect(200);
    expect(reset.body).toEqual({ mfaEnabled: false });
    await target.get('/api/auth/me').set(headers).expect(401);
    expect(await db.query(`SELECT 1 FROM staff_mfa WHERE "userId" = $1 UNION ALL SELECT 1 FROM staff_mfa_recovery_codes WHERE "userId" = $1`, [users.admin2.id])).toEqual([]);
    expect((await events(users.admin2.id)).map(({ type, actorId }) => ({ type, actorId }))).toEqual([{ type: 'MFA_ENROLLED', actorId: null }, { type: 'MFA_RESET_BY_ADMIN', actorId: users.admin.id }]);
    // The reset also ends any lock from earlier wrong codes.
    expect(await db.query(`SELECT 1 FROM login_attempts WHERE key = ANY($1)`, [['mfa', 'mfa-lock', 'mfa-lockouts'].map(scope => attemptKey(scope, users.admin2.id))])).toEqual([]);
    // The reset administrator must enrol again at the next sign-in; the admin count is unchanged.
    expect((await login(agent(), users.admin2).expect(200)).body.mfa).toBe('enrol');
    await admin.post(`/api/users/${users.admin2.id}/mfa/reset`).set(headers).send({}).expect(404);
    expect(await db.getRepository(User).countBy({ role: Role.SYSTEM_ADMIN, status: UserStatus.ACTIVE })).toBe(2);
  });

  it('raises the requirement to all staff, ending unverified sessions', async () => {
    const adminSecret = await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users.admin.id);
    const admin = agent();
    await login(admin, users.admin).expect(200);
    await verify(admin, totpCode(adminSecret)).expect(200);
    const it = agent();
    await login(it, users.it).expect(200);
    await it.get('/api/auth/me').set(headers).expect(200);
    await it.patch('/api/settings/security').set(headers).send({ mfaRequiredFor: 'ALL_STAFF' }).expect(403);
    await admin.patch('/api/settings/security').set(headers).send({ mfaRequiredFor: 'NOBODY' }).expect(400);
    await admin.patch('/api/settings/security').set(headers).send({ mfaRequiredFor: 'ALL_STAFF' }).expect(200);
    expect((await admin.get('/api/settings/security').set(headers).expect(200)).body).toEqual({ mfaRequiredFor: 'ALL_STAFF' });
    await admin.get('/api/auth/me').set(headers).expect(200);
    await it.get('/api/auth/me').set(headers).expect(401);
    expect((await login(agent(), users.it).expect(200)).body.mfa).toBe('enrol');
    expect((await events(users.admin.id)).map(event => [event.type, event.metadata])).toEqual([['MFA_POLICY_CHANGED', { from: 'ADMINS', to: 'ALL_STAFF' }]]);
  });

  it('expires pending sign-ins and only admits each pending stage on its own routes', async () => {
    await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users.admin.id);
    const client = agent();
    await login(client, users.admin).expect(200);
    await client.post('/api/auth/mfa/enrolment/confirm').set(headers).send({ code: '123456' }).expect(401);
    await db.query(`UPDATE staff_sessions SET sess = jsonb_set(sess::jsonb, '{mfaPending,expiresAt}', '1'::jsonb)::json WHERE sess->'mfaPending'->>'userId' = $1`, [users.admin.id]);
    await verify(client, '123456').expect(401);
    await client.post('/api/auth/logout').set(headers).send({}).expect(204);
  });

  it('refuses to roll back the migration while secrets or security events exist', async () => {
    await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users.admin.id);
    const runner = db.createQueryRunner();
    try { await expect(new StaffMfa1792720000000().down(runner)).rejects.toThrow('Cannot discard'); } finally { await runner.release(); }
    expect(await db.query(`SELECT 1 FROM staff_mfa`)).toHaveLength(1);
  });
});
