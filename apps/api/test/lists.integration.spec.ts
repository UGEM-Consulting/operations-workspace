import { randomBytes, randomUUID } from 'node:crypto';
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
import { ListsModule } from '../src/modules/lists/lists.module';
type Agent = ReturnType<typeof request.agent>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Managed lists (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url');
  const users: Record<'manager' | 'it', User> = {} as never, agents: Record<'manager' | 'it', Agent> = {} as never;
  const latest = async () => (await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name as string;
  // An approved dispatcher whose manager-confirmed assignment is the given text.
  async function approved(mcName: string, jobTitle: string, status = 'APPROVED') {
    const [inv] = await db.query(`INSERT INTO invitations ("managerId","tokenHash","mcName","teamLead","jobTitle","expiresAt","telegramRequired") VALUES ($1,$2,$3,'Independent',$4,now()+interval '7 days',false) RETURNING id`,
      [users.manager.id, randomBytes(32).toString('hex'), mcName, jobTitle]);
    await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"applicantAccessUntil","submittedAt") VALUES ($1,$2,$3,'{}',3,now()+interval '7 days',now())`, [inv.id, users.manager.id, status]);
  }
  const mcs = (agent = agents.manager, status = 'ALL') => agent.get(`/api/lists/mcs?status=${status}`).set(headers);

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600 });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, ListsModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, list_events, mcs, job_titles, dispatch_events CASCADE');
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: 'Staff', email: `lists.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    }
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, list_events, mcs, job_titles CASCADE'); await db.destroy(); } });

  it('starts the lists from manager-confirmed assignments, one entry per name however it was typed, without Independent', async () => {
    await db.query('TRUNCATE list_events, dispatch_events, member_contacts'); await db.query(`TRUNCATE member_support_links; UPDATE invitations SET position = 'DISPATCHER', "supportsMemberId" = NULL WHERE position = 'SUPPORT'; DELETE FROM dispatch_events WHERE event = 'SUPPORT_REASSIGNED'`); await db.query('TRUNCATE drivers CASCADE'); await db.undoLastMigration(); await db.undoLastMigration(); await db.query(`TRUNCATE drivers CASCADE; TRUNCATE driver_sessions, driver_challenges`); await db.undoLastMigration(); await db.query(`TRUNCATE drivers CASCADE; TRUNCATE driver_sessions, driver_challenges`); await db.undoLastMigration(); await db.query(`TRUNCATE drivers CASCADE; DELETE FROM users WHERE role::text LIKE 'SAFETY_%'`); await db.undoLastMigration(); await db.query(`UPDATE dispatch_members SET "accountUserId" = NULL; TRUNCATE promotion_requests; DELETE FROM dispatch_events WHERE event LIKE 'PROMOTION_%'; DELETE FROM users WHERE role::text = 'TEAM_LEAD'`); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); expect(await latest()).toBe('Notifications1792800000000');
    await approved('Northwind Freight', 'Dispatcher'); await approved('  northwind   FREIGHT ', 'dispatcher'); await approved('Independent', 'Senior dispatcher');
    await approved('Lakeside Carriers', 'Dispatcher', 'SUBMITTED');
    await db.runMigrations(); expect(await latest()).toBe('DriverScreening1792900000000');
    const body = (await mcs().expect(200)).body;
    expect(body.items.map((item: { name: string; usage: number }) => [item.name, item.usage])).toEqual([['Lakeside Carriers', 0], ['Northwind Freight', 2]]);
    expect(body.counts).toEqual({ active: 2, archived: 0 });
    expect((await agents.manager.get('/api/lists/job-titles').set(headers).expect(200)).body.items.map((item: { name: string }) => item.name)).toEqual(['Dispatcher', 'Senior dispatcher']);
  });

  it('adds, renames, archives and restores MCs with unique names and numbers, recording which fields changed but never their values', async () => {
    const created = (await agents.manager.post('/api/lists/mcs').set(headers).send({ name: ' North  Star Express ', mcNumber: 'MC 123456', dotNumber: '' }).expect(201)).body;
    expect(created).toMatchObject({ name: 'North Star Express', mcNumber: '123456', dotNumber: null, archived: false, version: 1 });
    expect((await agents.manager.post('/api/lists/mcs').set(headers).send({ name: 'north star EXPRESS' }).expect(409)).body.message).toBe('An MC with this name already exists.');
    expect((await agents.manager.post('/api/lists/mcs').set(headers).send({ name: 'Another Carrier', mcNumber: '123456' }).expect(409)).body.message).toBe('Another MC already has this MC number.');
    expect((await agents.manager.post('/api/lists/mcs').set(headers).send({ name: 'independent' }).expect(400)).body.message).toMatch(/fixed choice/);
    await agents.manager.post('/api/lists/mcs').set(headers).send({ name: 'Bad Number', mcNumber: '12ab' }).expect(400);

    await agents.manager.patch(`/api/lists/mcs/${created.id}`).set(headers).send({ version: 2, name: 'Renamed' }).expect(409);
    const renamed = (await agents.manager.patch(`/api/lists/mcs/${created.id}`).set(headers).send({ version: 1, name: 'North Star Express Inc', dotNumber: '2876102' }).expect(200)).body;
    expect(renamed).toMatchObject({ name: 'North Star Express Inc', dotNumber: '2876102', version: 2 });
    const archived = (await agents.manager.patch(`/api/lists/mcs/${created.id}`).set(headers).send({ version: 2, archived: true }).expect(200)).body;
    expect(archived).toMatchObject({ archived: true, version: 3 });
    expect((await mcs(agents.manager, 'ACTIVE').expect(200)).body.items).toEqual([]);
    expect((await mcs(agents.manager, 'ARCHIVED').expect(200)).body).toMatchObject({ items: [{ name: 'North Star Express Inc' }], counts: { active: 0, archived: 1 } });
    // Nothing changed: no new version and no event.
    expect((await agents.manager.patch(`/api/lists/mcs/${created.id}`).set(headers).send({ version: 3, archived: true, name: 'North Star Express Inc' }).expect(200)).body.version).toBe(3);
    await agents.manager.patch(`/api/lists/mcs/${created.id}`).set(headers).send({ version: 3, archived: false }).expect(200);

    const events = await db.query(`SELECT list, event, metadata, "actorId" FROM list_events WHERE "itemId" = $1 ORDER BY "createdAt", event`, [created.id]);
    expect(events).toEqual([
      { list: 'MC', event: 'CREATED', metadata: { fields: ['name', 'mcNumber'] }, actorId: users.manager.id },
      { list: 'MC', event: 'UPDATED', metadata: { fields: ['name', 'dotNumber'] }, actorId: users.manager.id },
      { list: 'MC', event: 'ARCHIVED', metadata: {}, actorId: users.manager.id },
      { list: 'MC', event: 'RESTORED', metadata: {}, actorId: users.manager.id }]);
    expect(JSON.stringify(events)).not.toMatch(/North Star|123456|2876102/);
  });

  it('keeps lists to dispatcher managers and administrators, and validates job titles', async () => {
    await mcs(agents.it).expect(403);
    await agents.it.post('/api/lists/job-titles').set(headers).send({ name: 'Dispatcher' }).expect(403);
    await agents.manager.post('/api/lists/job-titles').set(headers).send({ name: '   ' }).expect(400);
    const title = (await agents.manager.post('/api/lists/job-titles').set(headers).send({ name: 'Track and trace' }).expect(201)).body;
    expect(title).toEqual({ id: title.id, name: 'Track and trace', archived: false, version: 1, usage: 0, updatedAt: expect.any(String) });
    await agents.manager.post('/api/lists/job-titles').set(headers).send({ name: 'TRACK AND TRACE' }).expect(409);
    await agents.manager.patch(`/api/lists/job-titles/${randomUUID()}`).set(headers).send({ version: 1, name: 'X' }).expect(404);
  });

  it('refuses to roll back once someone has changed a list, so manual entries are never lost', async () => {
    await agents.manager.post('/api/lists/mcs').set(headers).send({ name: 'Kept Carrier', mcNumber: '765432' }).expect(201);
    await db.query('TRUNCATE dispatch_events, member_contacts, member_support_links'); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration();
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard managed list changes');
    expect(await latest()).toBe('ManagedLists1792810000000');
    await db.runMigrations();
  });
});
