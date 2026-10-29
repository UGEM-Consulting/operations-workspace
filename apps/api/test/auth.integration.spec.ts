import { randomBytes } from 'node:crypto';
import { Controller, Get, INestApplication } from '@nestjs/common';
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
import { HealthModule } from '../src/modules/health/health.module';
import { seedDemo } from '../src/database/seed';
import { attemptKey } from '../src/modules/auth/attempts';
import { StaffPasswordChange1792760000000 } from '../src/database/migrations/1792760000000-StaffPasswordChange';
import { completeMfa, enrolForTest } from './mfa-helpers';

@Controller('unclassified')
class UnclassifiedController { @Get() get() { return {}; } }
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Identity integration (isolated PostgreSQL database only)', () => {
  let app: INestApplication;
  let db: DataSource;
  let closeSessions: () => Promise<void>;
  const password = randomBytes(24).toString('base64url');
  const env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test',
    CORS_ORIGINS: 'http://localhost:3000', WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'),
    BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  const headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
  const accounts = new Map<Role, User>();
  let adminSecret = '';
  const login = (agent: ReturnType<typeof request.agent>, role = Role.SYSTEM_ADMIN) => agent.post('/api/auth/login').set(headers).send({ email: accounts.get(role)!.email, password });
  // Full sign-in: administrators must complete the authenticator step.
  const signIn = async (agent: ReturnType<typeof request.agent>, role = Role.SYSTEM_ADMIN) => {
    const response = await login(agent, role).expect(200);
    if (role !== Role.SYSTEM_ADMIN) return response;
    expect(response.body).toEqual({ mfa: 'verify', landingPage: '/login/mfa' });
    const verified = await completeMfa(agent, headers, db, accounts.get(role)!.id, adminSecret);
    expect(verified.status).toBe(200);
    return verified;
  };
  beforeAll(async () => {
    // Explicit opt-in and dedicated database name prevent accidental use of application data.
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must name a dedicated database ending in _test');
    db = await new DataSource(databaseOptions(env)).initialize();
    await db.runMigrations();
    await db.query('TRUNCATE staff_sessions, login_attempts, users CASCADE');
    const encoded = await hashPassword(password);
    for (const role of Object.values(Role)) {
      const user = await db.getRepository(User).save(db.getRepository(User).create({ firstName: 'Fictional', lastName: 'Tester', email: `${role.toLowerCase()}@example.test`, role, status: UserStatus.ACTIVE, passwordHash: encoded }));
      accounts.set(role, user);
    }
    adminSecret = await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, accounts.get(Role.SYSTEM_ADMIN)!.id);
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, HealthModule], controllers: [UnclassifiedController] }).compile();
    app = module.createNestApplication();
    closeSessions = installSessions(app, env);
    configureApp(app, env.CORS_ORIGINS);
    await app.init();
  }, 30000);
  beforeEach(async () => { await db.query('TRUNCATE login_attempts'); });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) await db.destroy(); });

  it.each(Object.values(Role))('authenticates %s and persists identity across requests', async role => {
    const agent = request.agent(app.getHttpServer());
    const response = await signIn(agent, role);
    expect(response.body.user.role).toBe(role);
    expect(response.body.user.passwordHash).toBeUndefined();
    expect(response.body.user.authVersion).toBeUndefined();
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Lax');
    await agent.get('/api/auth/me').set(headers).expect(200);
    await agent.get('/api/auth/me').set(headers).expect(200);
    expect((await db.getRepository(User).findOneByOrFail({ id: accounts.get(role)!.id })).lastLoginAt).not.toBeNull();
  });
  it('uses generic invalid credentials and accepts case-insensitive email', async () => {
    for (const email of [accounts.get(Role.SYSTEM_ADMIN)!.email, 'missing@example.test']) {
      const result = await request(app.getHttpServer()).post('/api/auth/login').set(headers).send({ email, password: randomBytes(16).toString('hex') }).expect(401);
      expect(result.body.message).toBe('Invalid email or password');
    }
    await request(app.getHttpServer()).post('/api/auth/login').set(headers).send({ email: accounts.get(Role.SYSTEM_ADMIN)!.email.toUpperCase(), password }).expect(200);
  });
  it('denies unauthenticated API requests and unclassified endpoints by default', async () => {
    await request(app.getHttpServer()).get('/api/users').set(headers).expect(401);
    const agent = request.agent(app.getHttpServer()); await signIn(agent);
    await agent.get('/api/unclassified').set(headers).expect(403);
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });
  it('rejects direct access without the BFF secret', async () => {
    await request(app.getHttpServer()).post('/api/auth/login').send({ email: accounts.get(Role.SYSTEM_ADMIN)!.email, password }).expect(403);
  });
  it.each([
    { origin: 'https://attacker.example' },
    { origin: '' },
    { 'x-csrf-protection': '' },
  ])('rejects login CSRF with %j', async override => {
    await request(app.getHttpServer()).post('/api/auth/login').set({ ...headers, ...override }).send({ email: accounts.get(Role.SYSTEM_ADMIN)!.email, password }).expect(403);
  });
  it('rejects authenticated mutation CSRF and privilege escalation', async () => {
    const agent = request.agent(app.getHttpServer()); await signIn(agent);
    await agent.patch(`/api/users/${accounts.get(Role.DISPATCHER_MANAGER)!.id}`).set({ ...headers, origin: 'https://attacker.example' }).send({ role: Role.SYSTEM_ADMIN }).expect(403);
    await agent.post('/api/auth/logout').set({ ...headers, 'x-csrf-protection': '' }).send({}).expect(403);
    await agent.get('/api/auth/me').set(headers).expect(200);
    await agent.post('/api/auth/login').set(headers).send({ email: accounts.get(Role.DISPATCHER_MANAGER)!.email, password, role: Role.SYSTEM_ADMIN }).expect(400);
  });
  const from = (ip: string, body: { email: string; password: string }) => request(app.getHttpServer()).post('/api/auth/login').set({ ...headers, 'x-client-ip': ip }).send(body);
  const counter = async (key: string) => ((await db.query(`SELECT attempts FROM login_attempts WHERE key = $1 AND "expiresAt" > now()`, [key]))[0]?.attempts ?? 0) as number;
  it('limits guessing per address and per account, identically for unknown accounts', async () => {
    for (const email of ['limited@example.test', accounts.get(Role.IT_SPECIALIST)!.email]) {
      const wrong = { email, password: randomBytes(16).toString('hex') };
      for (let i = 0; i < 10; i++) await from('198.51.100.1', wrong).expect(401);
      expect((await from('198.51.100.1', wrong).expect(429)).body.message).toBe('Too many login attempts. Try again later.');
      // Another address may keep trying the same account only until the account-wide failure limit.
      for (let i = 0; i < 10; i++) await from('198.51.100.2', wrong).expect(401);
      await from('198.51.100.3', { email, password }).expect(429);
      // Other accounts from those addresses are unaffected.
      await from('198.51.100.1', { email: accounts.get(Role.DISPATCHER_MANAGER)!.email, password }).expect(200);
      await db.query('TRUNCATE login_attempts');
    }
    // Stored keys are digests: no email or address appears.
    await from('198.51.100.4', { email: 'stored@example.test', password }).expect(401);
    expect(JSON.stringify(await db.query('SELECT key FROM login_attempts'))).not.toMatch(/stored|198\.51/);
  }, 60000);
  it('clears the account counters on a correct password but never the address counter', async () => {
    const email = accounts.get(Role.IT_SPECIALIST)!.email, ip = '203.0.113.7';
    for (let i = 0; i < 9; i++) await from(ip, { email, password: 'incorrect-password' }).expect(401);
    expect(await counter(attemptKey('login-email', email))).toBe(9);
    await from(ip, { email, password }).expect(200);
    expect(await counter(attemptKey('login-email', email))).toBe(0);
    expect(await counter(attemptKey('login-email-ip', `${email}\n${ip}`))).toBe(0);
    expect(await counter(attemptKey('login-ip', ip))).toBe(10);
    // Cleared, so the owner gets a fresh allowance instead of staying locked out.
    for (let i = 0; i < 9; i++) await from(ip, { email, password: 'incorrect-password' }).expect(401);
    await from(ip, { email, password }).expect(200);
  }, 30000);
  it('limits each address and keeps a service-wide circuit breaker', async () => {
    const email = accounts.get(Role.IT_SPECIALIST)!.email;
    await db.query(`INSERT INTO login_attempts VALUES ($1, 100, now() + interval '15 minutes')`, [attemptKey('login-ip', '192.0.2.10')]);
    await from('192.0.2.10', { email, password }).expect(429);
    await from('192.0.2.11', { email, password }).expect(200);
    await db.query(`INSERT INTO login_attempts VALUES ($1, 1000, now() + interval '1 minute') ON CONFLICT (key) DO UPDATE SET attempts = 1000`, [attemptKey('login-service', 'all')]);
    await from('192.0.2.12', { email, password }).expect(429);
  });
  it('enforces manager and IT roles at the API boundary', async () => {
    const manager = request.agent(app.getHttpServer()); await login(manager, Role.DISPATCHER_MANAGER);
    await manager.get('/api/access/onboarding').set(headers).expect(200);
    await manager.get('/api/access/it').set(headers).expect(403);
    await manager.get('/api/users').set(headers).expect(403);
    await manager.patch(`/api/users/${accounts.get(Role.DISPATCHER_MANAGER)!.id}`).set(headers).send({ role: Role.SYSTEM_ADMIN }).expect(403);
    await manager.post('/api/users').set(headers).send({}).expect(403);
    const it = request.agent(app.getHttpServer()); await login(it, Role.IT_SPECIALIST);
    await it.get('/api/access/it').set(headers).expect(200);
    await it.get('/api/access/applications').set(headers).expect(403);
    const me = await it.get('/api/auth/me').set(headers).expect(200);
    expect(me.body.navigation.map((item: { key: string; section: string | null }) => [item.key, item.section])).toEqual([['dashboard', null], ['it', 'IT'], ['security', 'Account']]);
  });
  it('rejects disabled users both on login and with an existing session', async () => {
    const agent = request.agent(app.getHttpServer()); await login(agent, Role.IT_SPECIALIST);
    const id = accounts.get(Role.IT_SPECIALIST)!.id;
    await db.getRepository(User).update(id, { status: UserStatus.INACTIVE });
    await agent.get('/api/auth/me').set(headers).expect(401);
    await login(request.agent(app.getHttpServer()), Role.IT_SPECIALIST).expect(401);
    await db.getRepository(User).update(id, { status: UserStatus.ACTIVE });
  });
  it('rejects nullable SSO-only passwords', async () => {
    const id = accounts.get(Role.IT_SPECIALIST)!.id;
    await db.getRepository(User).update(id, { passwordHash: null });
    await login(request.agent(app.getHttpServer()), Role.IT_SPECIALIST).expect(401);
    await db.getRepository(User).update(id, { passwordHash: await hashPassword(password) });
  });
  it('invalidates sessions on logout and rejects replay', async () => {
    const agent = request.agent(app.getHttpServer());
    const signedIn = await signIn(agent);
    const cookie = signedIn.headers['set-cookie'][0].split(';')[0];
    await agent.post('/api/auth/logout').set(headers).send({}).expect(204);
    await request(app.getHttpServer()).get('/api/auth/me').set(headers).set('Cookie', cookie).expect(401);
  });
  it('rejects expired sessions and server-side revocation', async () => {
    const agent = request.agent(app.getHttpServer()); await signIn(agent);
    await db.query(`UPDATE staff_sessions SET expire = now() - interval '1 minute'`);
    await agent.get('/api/auth/me').set(headers).expect(401);
    const agent2 = request.agent(app.getHttpServer()); await signIn(agent2);
    await db.query('DELETE FROM staff_sessions');
    await agent2.get('/api/auth/me').set(headers).expect(401);
  });
  it('enforces absolute expiration independently of store expiry', async () => {
    const agent = request.agent(app.getHttpServer()); await signIn(agent);
    await db.query(`UPDATE staff_sessions SET sess = jsonb_set(sess::jsonb, '{expiresAt}', '1'::jsonb)::json`);
    await agent.get('/api/auth/me').set(headers).expect(401);
  });
  it('creates users, rejects duplicate emails, and revokes sessions on role changes', async () => {
    const admin = request.agent(app.getHttpServer()); await signIn(admin);
    const manager = request.agent(app.getHttpServer()); await login(manager, Role.DISPATCHER_MANAGER);
    const created = await admin.post('/api/users').set(headers).send({ firstName: 'Demo', lastName: 'New', email: 'new@example.test', password: randomBytes(24).toString('hex'), role: Role.IT_SPECIALIST }).expect(201);
    expect(created.body.passwordHash).toBeUndefined();
    await admin.post('/api/users').set(headers).send({ firstName: 'Demo', lastName: 'Duplicate', email: 'NEW@example.test', password, role: Role.IT_SPECIALIST }).expect(409);
    await admin.patch(`/api/users/${accounts.get(Role.DISPATCHER_MANAGER)!.id}`).set(headers).send({ role: Role.IT_SPECIALIST }).expect(200);
    await manager.get('/api/auth/me').set(headers).expect(401);
    await db.getRepository(User).update(accounts.get(Role.DISPATCHER_MANAGER)!.id, { role: Role.DISPATCHER_MANAGER });
    await admin.patch(`/api/users/${accounts.get(Role.SYSTEM_ADMIN)!.id}`).set(headers).send({ status: UserStatus.INACTIVE }).expect(400);
  });
  it('revokes sessions on password reset and disabled-user administration', async () => {
    const admin = request.agent(app.getHttpServer()); await signIn(admin);
    const it = request.agent(app.getHttpServer()); await login(it, Role.IT_SPECIALIST);
    const id = accounts.get(Role.IT_SPECIALIST)!.id;
    const changedPassword = randomBytes(24).toString('base64url');
    await admin.patch(`/api/users/${id}`).set(headers).send({ password: changedPassword }).expect(200);
    await it.get('/api/auth/me').set(headers).expect(401);
    await login(request.agent(app.getHttpServer()), Role.IT_SPECIALIST).expect(401);
    const updated = request.agent(app.getHttpServer());
    // An administrator-set password works once, for choosing a new one.
    expect((await updated.post('/api/auth/login').set(headers).send({ email: accounts.get(Role.IT_SPECIALIST)!.email, password: changedPassword }).expect(200)).body).toEqual({ stage: 'password', landingPage: '/login/password' });
    await updated.get('/api/auth/me').set(headers).expect(401);
    await admin.patch(`/api/users/${id}`).set(headers).send({ status: UserStatus.INACTIVE }).expect(200);
    await updated.post('/api/auth/password').set(headers).send({ currentPassword: changedPassword, newPassword: randomBytes(24).toString('base64url') }).expect(401);
    await updated.post('/api/auth/login').set(headers).send({ email: accounts.get(Role.IT_SPECIALIST)!.email, password: changedPassword }).expect(401);
    await db.getRepository(User).update(id, { status: UserStatus.ACTIVE, passwordHash: await hashPassword(password), mustChangePassword: false });
  });
  const events = async (userId: string) => (await db.query(`SELECT type, "actorId", metadata FROM staff_security_events WHERE "userId" = $1 ORDER BY "createdAt", type`, [userId])) as { type: string; actorId: string | null; metadata: Record<string, unknown> }[];
  it('makes administrator-created users choose their own password before any access', async () => {
    const admin = request.agent(app.getHttpServer()); await signIn(admin);
    const initial = randomBytes(24).toString('base64url'), chosen = randomBytes(24).toString('base64url');
    const created = await admin.post('/api/users').set(headers).send({ firstName: 'Fictional', lastName: 'Forced', email: 'forced@example.test', password: initial, role: Role.IT_SPECIALIST }).expect(201);
    const user = request.agent(app.getHttpServer());
    expect((await user.post('/api/auth/login').set(headers).send({ email: 'forced@example.test', password: initial }).expect(200)).body).toEqual({ stage: 'password', landingPage: '/login/password' });
    for (const path of ['/api/auth/me', '/api/access/dashboard', '/api/auth/mfa']) await user.get(path).set(headers).expect(401);
    await user.post('/api/auth/mfa/enrolment').set(headers).send({}).expect(401);
    const change = (currentPassword: string, newPassword: string) => user.post('/api/auth/password').set(headers).send({ currentPassword, newPassword });
    expect((await change('incorrect-password', chosen).expect(400)).body.message).toBe('Your current password is incorrect');
    expect((await change(initial, initial).expect(400)).body.message).toMatch(/differs/);
    await change(initial, 'short').expect(400);
    await user.post('/api/auth/password').set({ ...headers, origin: 'https://attacker.example' }).send({ currentPassword: initial, newPassword: chosen }).expect(403);
    const changed = await change(initial, chosen).expect(200);
    expect(changed.body).toMatchObject({ user: { id: created.body.id }, landingPage: '/it/tasks' });
    await user.get('/api/auth/me').set(headers).expect(200);
    expect((await db.getRepository(User).findOneByOrFail({ id: created.body.id })).mustChangePassword).toBe(false);
    await request(app.getHttpServer()).post('/api/auth/login').set(headers).send({ email: 'forced@example.test', password: initial }).expect(401);
    expect((await request(app.getHttpServer()).post('/api/auth/login').set(headers).send({ email: 'forced@example.test', password: chosen }).expect(200)).body.user.id).toBe(created.body.id);
    const audit = await events(created.body.id);
    expect(audit.map(({ type, actorId }) => [type, actorId])).toEqual([['USER_CREATED', accounts.get(Role.SYSTEM_ADMIN)!.id], ['PASSWORD_CHANGED', created.body.id]]);
    expect(audit[0].metadata).toEqual({ fields: ['firstName', 'lastName', 'email', 'role', 'password'] });
    expect(audit[1].metadata).toEqual({ forced: true });
    expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${initial}|${chosen}|forced@|Fictional|IT_SPECIALIST`));
  }, 30000);
  it('continues a forced password change with the authenticator step', async () => {
    const id = accounts.get(Role.SYSTEM_ADMIN)!.id;
    await db.getRepository(User).update(id, { mustChangePassword: true });
    const agent = request.agent(app.getHttpServer());
    expect((await login(agent).expect(200)).body.stage).toBe('password');
    const chosen = randomBytes(24).toString('base64url');
    expect((await agent.post('/api/auth/password').set(headers).send({ currentPassword: password, newPassword: chosen }).expect(200)).body).toEqual({ mfa: 'verify', landingPage: '/login/mfa' });
    await agent.get('/api/auth/me').set(headers).expect(401);
    expect((await completeMfa(agent, headers, db, id, adminSecret)).status).toBe(200);
    await agent.get('/api/auth/me').set(headers).expect(200);
    await db.getRepository(User).update(id, { passwordHash: await hashPassword(password) });
  }, 30000);
  it('rejects full sessions and expired pending changes while a password change is required', async () => {
    const id = accounts.get(Role.IT_SPECIALIST)!.id;
    const before = request.agent(app.getHttpServer()); await login(before, Role.IT_SPECIALIST).expect(200);
    // Set directly, as an older API instance could leave it during an overlapping deploy.
    await db.getRepository(User).update(id, { mustChangePassword: true });
    await before.get('/api/auth/me').set(headers).expect(401);
    const pending = request.agent(app.getHttpServer()); await login(pending, Role.IT_SPECIALIST).expect(200);
    await db.query(`UPDATE staff_sessions SET sess = jsonb_set(sess::jsonb, '{mfaPending,expiresAt}', '1'::jsonb)::json WHERE sess->'mfaPending'->>'userId' = $1`, [id]);
    await pending.post('/api/auth/password').set(headers).send({ currentPassword: password, newPassword: randomBytes(24).toString('base64url') }).expect(401);
    await db.getRepository(User).update(id, { mustChangePassword: false });
  });
  it('changes a password from Account security, ending only the other sessions', async () => {
    const id = accounts.get(Role.IT_SPECIALIST)!.id;
    const acting = request.agent(app.getHttpServer());
    const first = await login(acting, Role.IT_SPECIALIST).expect(200);
    const other = request.agent(app.getHttpServer()); await login(other, Role.IT_SPECIALIST).expect(200);
    const chosen = randomBytes(24).toString('base64url');
    const changed = await acting.post('/api/auth/password').set(headers).send({ currentPassword: password, newPassword: chosen }).expect(200);
    expect(changed.headers['set-cookie'][0].split(';')[0]).not.toBe(first.headers['set-cookie'][0].split(';')[0]);
    await acting.get('/api/auth/me').set(headers).expect(200);
    await other.get('/api/auth/me').set(headers).expect(401);
    await request(app.getHttpServer()).get('/api/auth/me').set(headers).set('Cookie', first.headers['set-cookie'][0].split(';')[0]).expect(401);
    expect((await events(id)).at(-1)).toEqual({ type: 'PASSWORD_CHANGED', actorId: id, metadata: { forced: false } });
    // Wrong current passwords are rate limited per user.
    for (let i = 0; i < 5; i++) await acting.post('/api/auth/password').set(headers).send({ currentPassword: 'incorrect-password', newPassword: password }).expect(400);
    await acting.post('/api/auth/password').set(headers).send({ currentPassword: chosen, newPassword: password }).expect(429);
    await db.getRepository(User).update(id, { passwordHash: await hashPassword(password) });
  }, 30000);
  it('ends sessions only for access-relevant edits and audits field names only', async () => {
    const admin = request.agent(app.getHttpServer()); await signIn(admin);
    const target = accounts.get(Role.DISPATCHER_MANAGER)!;
    const manager = request.agent(app.getHttpServer()); await login(manager, Role.DISPATCHER_MANAGER).expect(200);
    const all = { firstName: target.firstName, lastName: target.lastName, email: target.email, role: target.role, status: UserStatus.ACTIVE };
    const before = (await events(target.id)).length;
    expect((await admin.patch(`/api/users/${target.id}`).set(headers).send(all).expect(200)).body.sessionsRevoked).toBe(false);
    expect((await admin.patch(`/api/users/${target.id}`).set(headers).send({ ...all, firstName: 'Renamed' }).expect(200)).body.sessionsRevoked).toBe(false);
    await manager.get('/api/auth/me').set(headers).expect(200);
    expect((await admin.patch(`/api/users/${target.id}`).set(headers).send({ ...all, firstName: 'Renamed', email: 'renamed.manager@example.test' }).expect(200)).body.sessionsRevoked).toBe(true);
    await manager.get('/api/auth/me').set(headers).expect(401);
    await admin.patch(`/api/users/${target.id}`).set(headers).send(all).expect(200);
    const audit = (await events(target.id)).slice(before);
    expect(audit.map(event => [event.type, event.actorId, event.metadata])).toEqual([
      ['USER_NAME_CHANGED', accounts.get(Role.SYSTEM_ADMIN)!.id, { fields: ['firstName'], sessionsRevoked: false }],
      ['USER_EMAIL_CHANGED', accounts.get(Role.SYSTEM_ADMIN)!.id, { fields: ['email'], sessionsRevoked: true }],
      ['USER_EMAIL_CHANGED', accounts.get(Role.SYSTEM_ADMIN)!.id, { fields: ['email'], sessionsRevoked: true }],
      ['USER_NAME_CHANGED', accounts.get(Role.SYSTEM_ADMIN)!.id, { fields: ['firstName'], sessionsRevoked: true }],
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/Renamed|renamed.manager|example.test/);
  });
  it('refuses to roll back the forced-change migration while a change is pending', async () => {
    const id = accounts.get(Role.IT_SPECIALIST)!.id;
    await db.getRepository(User).update(id, { mustChangePassword: true });
    const runner = db.createQueryRunner();
    try { await expect(new StaffPasswordChange1792760000000().down(runner)).rejects.toThrow('Cannot discard pending forced password changes'); } finally { await runner.release(); }
    await db.getRepository(User).update(id, { mustChangePassword: false });
  });
  it('regenerates the session identifier when logging in again', async () => {
    const agent = request.agent(app.getHttpServer());
    const first = await signIn(agent);
    const second = await signIn(agent);
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    expect(second.headers['set-cookie'][0].split(';')[0]).not.toBe(cookie);
    await request(app.getHttpServer()).get('/api/auth/me').set(headers).set('Cookie', cookie).expect(401);
  });
  it('does not expose or accept internal user/session fields', async () => {
    const admin = request.agent(app.getHttpServer()); await signIn(admin);
    const list = await admin.get('/api/users').set(headers).expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|authVersion/);
    await admin.patch(`/api/users/${accounts.get(Role.IT_SPECIALIST)!.id}`).set(headers).send({ authVersion: 0, passwordHash: 'fake' }).expect(400);
  });
  it('seeds fictional accounts idempotently without resetting their credentials', async () => {
    const input = { ALLOW_DEMO_SEED: 'true', NODE_ENV: 'test', DEMO_ADMIN_EMAIL: 'seed.admin@example.test', DEMO_MANAGER_EMAIL: 'seed.manager@example.test', DEMO_IT_EMAIL: 'seed.it@example.test', DEMO_ADMIN_PASSWORD: password, DEMO_MANAGER_PASSWORD: password, DEMO_IT_PASSWORD: password };
    expect(await seedDemo(db, input)).toBe(3);
    expect(await seedDemo(db, input)).toBe(0);
    await expect(seedDemo(db, { ...input, NODE_ENV: 'production' })).rejects.toThrow();
  });
});
