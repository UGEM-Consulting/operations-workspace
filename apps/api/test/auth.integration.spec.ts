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
    BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600 });
  const headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
  const accounts = new Map<Role, User>();
  const login = (agent: ReturnType<typeof request.agent>, role = Role.SYSTEM_ADMIN) => agent.post('/api/auth/login').set(headers).send({ email: accounts.get(role)!.email, password });
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
    const response = await login(agent, role).expect(200);
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
    const agent = request.agent(app.getHttpServer()); await login(agent);
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
    const agent = request.agent(app.getHttpServer()); await login(agent);
    await agent.patch(`/api/users/${accounts.get(Role.DISPATCHER_MANAGER)!.id}`).set({ ...headers, origin: 'https://attacker.example' }).send({ role: Role.SYSTEM_ADMIN }).expect(403);
    await agent.post('/api/auth/logout').set({ ...headers, 'x-csrf-protection': '' }).send({}).expect(403);
    await agent.get('/api/auth/me').set(headers).expect(200);
    await agent.post('/api/auth/login').set(headers).send({ email: accounts.get(Role.DISPATCHER_MANAGER)!.email, password, role: Role.SYSTEM_ADMIN }).expect(400);
  });
  it('throttles login attempts across separate clients', async () => {
    for (let i = 0; i < 5; i++) await request(app.getHttpServer()).post('/api/auth/login').set(headers).send({ email: 'limited@example.test', password }).expect(401);
    await request(app.getHttpServer()).post('/api/auth/login').set(headers).send({ email: 'limited@example.test', password }).expect(429);
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
    expect(me.body.navigation.map((item: { key: string }) => item.key)).toEqual(['dashboard', 'it']);
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
    const signedIn = await login(agent).expect(200);
    const cookie = signedIn.headers['set-cookie'][0].split(';')[0];
    await agent.post('/api/auth/logout').set(headers).send({}).expect(204);
    await request(app.getHttpServer()).get('/api/auth/me').set(headers).set('Cookie', cookie).expect(401);
  });
  it('rejects expired sessions and server-side revocation', async () => {
    const agent = request.agent(app.getHttpServer()); await login(agent);
    await db.query(`UPDATE staff_sessions SET expire = now() - interval '1 minute'`);
    await agent.get('/api/auth/me').set(headers).expect(401);
    const agent2 = request.agent(app.getHttpServer()); await login(agent2);
    await db.query('DELETE FROM staff_sessions');
    await agent2.get('/api/auth/me').set(headers).expect(401);
  });
  it('enforces absolute expiration independently of store expiry', async () => {
    const agent = request.agent(app.getHttpServer()); await login(agent);
    await db.query(`UPDATE staff_sessions SET sess = jsonb_set(sess::jsonb, '{expiresAt}', '1'::jsonb)::json`);
    await agent.get('/api/auth/me').set(headers).expect(401);
  });
  it('creates users, rejects duplicate emails, and revokes sessions on role changes', async () => {
    const admin = request.agent(app.getHttpServer()); await login(admin);
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
    const admin = request.agent(app.getHttpServer()); await login(admin);
    const it = request.agent(app.getHttpServer()); await login(it, Role.IT_SPECIALIST);
    const id = accounts.get(Role.IT_SPECIALIST)!.id;
    const changedPassword = randomBytes(24).toString('base64url');
    await admin.patch(`/api/users/${id}`).set(headers).send({ password: changedPassword }).expect(200);
    await it.get('/api/auth/me').set(headers).expect(401);
    await login(request.agent(app.getHttpServer()), Role.IT_SPECIALIST).expect(401);
    const updated = request.agent(app.getHttpServer());
    await updated.post('/api/auth/login').set(headers).send({ email: accounts.get(Role.IT_SPECIALIST)!.email, password: changedPassword }).expect(200);
    await admin.patch(`/api/users/${id}`).set(headers).send({ status: UserStatus.INACTIVE }).expect(200);
    await updated.get('/api/auth/me').set(headers).expect(401);
    await updated.post('/api/auth/login').set(headers).send({ email: accounts.get(Role.IT_SPECIALIST)!.email, password: changedPassword }).expect(401);
    await db.getRepository(User).update(id, { status: UserStatus.ACTIVE, passwordHash: await hashPassword(password) });
  });
  it('regenerates the session identifier when logging in again', async () => {
    const agent = request.agent(app.getHttpServer());
    const first = await login(agent).expect(200);
    const second = await login(agent).expect(200);
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    expect(second.headers['set-cookie'][0].split(';')[0]).not.toBe(cookie);
    await request(app.getHttpServer()).get('/api/auth/me').set(headers).set('Cookie', cookie).expect(401);
  });
  it('does not expose or accept internal user/session fields', async () => {
    const admin = request.agent(app.getHttpServer()); await login(admin);
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
