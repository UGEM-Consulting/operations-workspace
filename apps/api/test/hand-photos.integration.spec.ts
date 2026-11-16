import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { User, Role, UserStatus } from '../src/modules/users/user.entity';
import { OnboardingModule } from '../src/modules/onboarding/onboarding.module';
import { ItModule } from '../src/modules/it/it.module';
import { WorkspaceModule } from '../src/modules/workspace/workspace.module';
import { DispatchModule } from '../src/modules/dispatch/dispatch.module';
import { DocumentsModule } from '../src/modules/documents/documents.module';
import { jpeg } from './documents.fixtures';
import { completeMfa, enrolForTest } from './mfa-helpers';
type Agent = ReturnType<typeof request.agent>;
type Key = 'admin' | 'manager' | 'it' | 'safety';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

integration('Photos for people added by hand (section 33, disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const storage = mkdtempSync(join(tmpdir(), 'hand-photos-'));
  const password = randomBytes(24).toString('base64url');
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  const addOne = async (name: string) => (await agents.manager.post('/api/dispatch/existing/add').set(headers).send({ rows: [{ row: 2, firstName: name, lastName: 'Fictional', mc: 'Northwind Freight', team: 'Red team', jobTitle: 'Dispatcher', startedOn: '2024-03-04' }] }).expect(201)).body.members[0].id as string;
  const add = (agent: Agent, id: string, kind: string, body: Record<string, unknown> = {}) => agent.post(`/api/dispatch/members/${id}/hand-photos/${kind}`).set(headers).send({ image: jpeg().toString('base64'), confirmed: true, ...body });
  const profile = async (id: string) => (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body;

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: storage });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, OnboardingModule, ItModule, WorkspaceModule, DispatchModule, DocumentsModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, notification_deliveries, it_removal_requests, staff_mfa CASCADE');
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['admin', Role.SYSTEM_ADMIN], ['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST], ['safety', Role.SAFETY_STAFF]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `photos.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      const secret = key === 'admin' ? await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users[key].id) : null;
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
      if (secret) await completeMfa(agents[key], headers, db, users[key].id, secret);
    }
    const [mc] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Northwind Freight','northwind freight') RETURNING id`);
    await db.query(`INSERT INTO teams (name,"nameKey","mcId") VALUES ('Red team','red team',$1)`, [mc.id]);
    await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Dispatcher','dispatcher')`);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, dispatch_members, it_removal_requests, users CASCADE'); await db.destroy(); } rmSync(storage, { recursive: true, force: true }); });

  it('lets only administrators add the two photos, keeps replaced files and records each ID photo view', async () => {
    const riley = await addOne('Riley');
    await add(agents.manager, riley, 'profile').expect(403);
    await add(agents.admin, riley, 'profile', { confirmed: false }).expect(400);
    await add(agents.admin, riley, 'profile', { image: Buffer.from('not a photo').toString('base64') }).expect(400);
    await add(agents.admin, riley, 'face').expect(404);
    await add(agents.admin, riley, 'profile').expect(201);
    await add(agents.admin, riley, 'profile').expect(201);
    await add(agents.admin, riley, 'id').expect(201);
    expect((await db.query(`SELECT kind, "replacedAt" IS NULL AS current FROM member_photos ORDER BY "createdAt"`)).map((row: { kind: string; current: boolean }) => [row.kind, row.current])).toEqual([['PROFILE', false], ['PROFILE', true], ['ID', true]]);
    const page = await profile(riley);
    expect(page).toMatchObject({ photo: true, idPhoto: true, handPhotos: { profile: expect.objectContaining({ uploadedBy: 'Fictional admin' }), id: expect.objectContaining({ uploadedBy: 'Fictional admin' }), idViews: [] } });
    // Managers and IT open both; the ID photo view is recorded with who and their role.
    const shown = await agents.manager.get(`/api/dispatch/members/${riley}/photos/selfie`).set(headers).expect(200);
    expect(shown.headers['content-type']).toBe('image/jpeg');
    await agents.it.get(`/api/member-photos/${riley}/profile`).set(headers).expect(200);
    await agents.it.get(`/api/member-photos/${riley}/id`).set(headers).expect(200);
    await agents.manager.get(`/api/dispatch/members/${riley}/photos/id-selfie`).set(headers).expect(200);
    const views = (await profile(riley)).handPhotos.idViews;
    expect(views.map((view: { viewedBy: string; role: string }) => [view.viewedBy, view.role])).toEqual([['Fictional manager', 'DISPATCHER_MANAGER'], ['Fictional it', 'IT_SPECIALIST']]);
    // Safety sees only the dispatchers drivers have worked with.
    await agents.safety.get(`/api/member-photos/${riley}/profile`).set(headers).expect(404);
    const [{ id: driver }] = await db.query(`INSERT INTO drivers ("firstName","lastName",phone,"phoneKey","driverType") VALUES ('Lena','Park','+1 202 555 0111','2025550111','COMPANY') RETURNING id`);
    await db.query(`INSERT INTO driver_assignments ("driverId","memberId","mcId","startedAt") SELECT $1, $2, id, now() FROM mcs LIMIT 1`, [driver, riley]);
    await agents.safety.get(`/api/member-photos/${riley}/profile`).set(headers).expect(200);
  });

  it('adds photos only for someone added by hand', async () => {
    // A record with no application and no manager's record: not someone added by hand.
    const [{ id }] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName","joinedAt") VALUES ('Sam','Fictional',now()) RETURNING id`);
    await add(agents.admin, id, 'profile').expect(409);
    await agents.it.get(`/api/member-photos/${id}/id`).set(headers).expect(404);
  });
  it('refuses a rollback while photos are recorded', async () => {
    const riley = await addOne('Riley');
    await add(agents.admin, riley, 'profile').expect(201);
    const runner = db.createQueryRunner();
    const { HandPhotos1793270000000: Migration } = await import('../src/database/migrations/1793270000000-HandPhotos');
    await expect(new Migration().down(runner)).rejects.toThrow('Refusing to roll back while photos');
    await runner.release();
  });
});
