import { addDays, usDay } from '../src/modules/safety/screening-rules';
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
import { User, Role, UserStatus } from '../src/modules/users/user.entity';
import { ItModule } from '../src/modules/it/it.module';
import { WorkspaceModule } from '../src/modules/workspace/workspace.module';
import { DispatchModule } from '../src/modules/dispatch/dispatch.module';
import { LoadBoardsModule } from '../src/modules/load-boards/load-boards.module';
type Agent = ReturnType<typeof request.agent>;
type Key = 'manager' | 'it';
type Row = Record<string, unknown>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

integration('Load board accounts and seats (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url');
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  const base = (row: number, name: string, extra: Row = {}): Row => ({ row, firstName: name, lastName: 'Fictional', mc: 'Northwind Freight', team: 'Red team', jobTitle: 'Dispatcher', startedOn: '2024-03-04', personalEmail: `${name.toLowerCase()}.home@example.test`, ...extra });
  const add = async (rows: Row[]) => (await agents.manager.post('/api/dispatch/existing/add').set(headers).send({ rows }).expect(201)).body;
  const addOne = async (name: string, extra: Row = {}) => { const body = await add([base(2, name, extra)]); expect(body.left).toEqual([]); return body.members[0].id as string; };
  const account = async (name: string, provider = 'DAT') => (await agents.it.post('/api/lists/load-board-accounts').set(headers).send({ provider, name }).expect(201)).body.id as string;
  const seat = (memberId: string, accountId: string, signInEmail: string) => agents.it.post('/api/load-board-seats').set(headers).send({ memberId, accountId, signInEmail, startedOn: '2025-02-01' });
  const profile = async (id: string) => (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body;
  const seatsOf = (id: string) => db.query(`SELECT s.*, a.name AS account, a.placeholder FROM member_load_board_seats s JOIN load_board_accounts a ON a.id = s."accountId" WHERE s."memberId" = $1 ORDER BY s."createdAt"`, [id]);

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, ItModule, WorkspaceModule, DispatchModule, LoadBoardsModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, notification_deliveries, it_removal_requests, list_events CASCADE');
    // TRUNCATE mcs CASCADE reaches the accounts too; the migration's two placeholders come back as it adds them.
    await db.query('DELETE FROM load_board_accounts WHERE NOT placeholder');
    await db.query(`INSERT INTO load_board_accounts (provider, name, "nameKey", placeholder) VALUES ('DAT', 'DAT account not recorded', 'dat account not recorded', true), ('TRUCKSTOP', 'Truckstop account not recorded', 'truckstop account not recorded', true) ON CONFLICT DO NOTHING`);
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `seats.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    }
    const [mc] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Northwind Freight','northwind freight') RETURNING id`);
    await db.query(`INSERT INTO teams (name,"nameKey","mcId") VALUES ('Red team','red team',$1)`, [mc.id]);
    await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Dispatcher','dispatcher')`);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, it_removal_requests, users, list_events CASCADE'); await db.query('DELETE FROM load_board_accounts WHERE NOT placeholder'); await db.destroy(); } });

  it('lets IT and administrators keep the list, and dispatch managers read it', async () => {
    await agents.manager.post('/api/lists/load-board-accounts').set(headers).send({ provider: 'DAT', name: 'Northwind DAT' }).expect(403);
    const id = await account('Northwind DAT');
    await agents.it.post('/api/lists/load-board-accounts').set(headers).send({ provider: 'TRUCKSTOP', name: 'northwind  dat' }).expect(409);
    const { body } = await agents.manager.get('/api/lists/load-board-accounts').set(headers).expect(200);
    expect(body.items.map((item: Row) => item.name)).toEqual(['Northwind DAT', 'DAT account not recorded', 'Truckstop account not recorded']);
    const [placeholder] = await db.query(`SELECT id, version FROM load_board_accounts WHERE placeholder AND provider = 'DAT'`);
    await agents.it.patch(`/api/lists/load-board-accounts/${placeholder.id}`).set(headers).send({ version: placeholder.version, name: 'Mine' }).expect(400);
    await agents.it.patch(`/api/lists/load-board-accounts/${id}`).set(headers).send({ version: 1, companyName: 'YouPro' }).expect(200);
    const [event] = await db.query(`SELECT metadata FROM list_events WHERE list = 'LOAD_BOARD_ACCOUNT' AND event = 'UPDATED'`);
    expect(event.metadata).toEqual({ fields: ['companyName'] });
  });

  it('adds seats from the list, shows who shares a sign-in, and keeps every change as history', async () => {
    const riley = await addOne('Riley'), sky = await addOne('Sky', { personalEmail: 'sky.home@example.test' });
    const youpro = await account('YouPro DAT'), northwind = await account('Northwind DAT');
    const [placeholder] = await db.query(`SELECT id FROM load_board_accounts WHERE placeholder AND provider = 'DAT'`);
    await seat(riley, placeholder.id, 'ryan.sands@example.test').expect(400);
    await agents.manager.post('/api/load-board-seats').set(headers).send({ memberId: riley, accountId: youpro, signInEmail: 'ryan.sands@example.test', startedOn: '2025-02-01' }).expect(403);
    await seat(riley, youpro, 'hunter2').expect(400);
    await seat(riley, youpro, 'ryan.sands@realcompany.com').expect(400);
    const first = (await seat(riley, youpro, 'Ryan.Sands@example.test').expect(201)).body;
    await seat(riley, youpro, 'other@example.test').expect(409);
    await seat(sky, youpro, 'ryan.sands@example.test').expect(201);
    const page = await profile(riley);
    expect(page.loadBoardSeats).toEqual([expect.objectContaining({ account: 'YouPro DAT', signInEmail: 'ryan.sands@example.test', status: 'ACTIVE', sharedWith: [{ id: sky, name: 'Sky Fictional' }] })]);
    // IT sees sign-ins on the account page; a manager sees them on each person's page only.
    const asIt = (await agents.it.get(`/api/lists/load-board-accounts/${youpro}`).set(headers).expect(200)).body;
    expect(asIt.using.map((row: Row) => [row.name, row.signInEmail, row.sharedWith, row.mcName])).toEqual([['Riley Fictional', 'ryan.sands@example.test', ['Sky Fictional'], 'Northwind Freight'], ['Sky Fictional', 'ryan.sands@example.test', ['Riley Fictional'], 'Northwind Freight']]);
    expect((await agents.manager.get(`/api/lists/load-board-accounts/${youpro}`).set(headers).expect(200)).body.using[0].signInEmail).toBeNull();
    const change = (version: number, body: Row) => agents.it.post(`/api/load-board-seats/${first.id}`).set(headers).send({ version, ...body });
    await change(1, { action: 'SUSPEND', on: '2099-01-01' }).expect(400);
    await change(1, { action: 'SUSPEND', on: '2025-01-01' }).expect(400);
    await change(1, { action: 'SUSPEND', on: usDay('latest') }).expect(201);
    await change(1, { action: 'RESUME' }).expect(409);
    await change(2, { action: 'RESUME' }).expect(201);
    const moved = (await change(3, { action: 'MOVE', accountId: northwind, signInEmail: 'riley.santos@example.test', on: usDay('latest') }).expect(201)).body;
    expect(await seatsOf(riley)).toEqual([expect.objectContaining({ account: 'YouPro DAT', status: 'ENDED', endedHow: 'MOVED' }), expect.objectContaining({ id: moved.movedTo, account: 'Northwind DAT', status: 'ACTIVE', signInEmail: 'riley.santos@example.test' })]);
    await change(4, { action: 'END', on: usDay('latest') }).expect(409);
    // Archiving waits until nobody holds a seat on it.
    await agents.it.patch(`/api/lists/load-board-accounts/${northwind}`).set(headers).send({ version: 1, archived: true }).expect(409);
    const events = await db.query(`SELECT event, metadata FROM dispatch_events WHERE event IN ('SEAT_ADDED','SEAT_CHANGED') ORDER BY "createdAt"`);
    expect(events.map((row: Row) => row.metadata)).toEqual([{ provider: 'DAT', shared: false }, { provider: 'DAT', shared: true }, { action: 'SUSPEND', provider: 'DAT' }, { action: 'RESUME', provider: 'DAT' }, { action: 'MOVE', provider: 'DAT', to: 'DAT', shared: false }]);
    expect(JSON.stringify(events)).not.toContain('@');
  });

  it('turns sign-ins recorded the older way into seats on “account not recorded”, and follows their changes', async () => {
    const riley = await addOne('Riley', { datEmail: 'riley.dat@example.test' });
    expect(await seatsOf(riley)).toEqual([expect.objectContaining({ account: 'DAT account not recorded', placeholder: true, signInEmail: 'riley.dat@example.test', status: 'ACTIVE' })]);
    const edit = async (body: Row) => { const { version } = await profile(riley); await agents.manager.patch(`/api/dispatch/members/${riley}/existing`).set(headers).send({ version, ...body }).expect(200); };
    await edit({ datEmail: 'riley.new@example.test' });
    expect((await seatsOf(riley)).map((row: Row) => [row.signInEmail, row.status])).toEqual([['riley.new@example.test', 'ACTIVE']]);
    await edit({ datEmail: '' });
    expect((await seatsOf(riley)).map((row: Row) => row.status)).toEqual(['ENDED']);
  });

  it('puts a sign-in on the account the file names, and asks about a name the list doesn’t know', async () => {
    const youpro = await account('YouPro DAT');
    const checked = (await agents.manager.post('/api/dispatch/existing/check').set(headers).send({ rows: [base(2, 'Riley', { datEmail: 'ryan@example.test', datAccount: 'YP DAT' }), base(3, 'Kai', { datAccount: 'YouPro DAT' })] }).expect(201)).body;
    expect(checked.rows[0].status).toBe('CHOICE');
    expect(checked.choices).toEqual([expect.objectContaining({ field: 'datAccount', text: 'YP DAT', rows: [2] })]);
    expect(checked.rows[1].problems.join(' ')).toMatch(/needs the DAT sign-in email/);
    const added = await add([base(2, 'Riley', { datEmail: 'ryan@example.test', datAccount: 'youpro dat' })]);
    expect(await seatsOf(added.members[0].id)).toEqual([expect.objectContaining({ accountId: youpro, signInEmail: 'ryan@example.test', status: 'ACTIVE' })]);
  });

  it('lists seats on IT’s removal and ends them when IT finishes', async () => {
    const riley = await addOne('Riley');
    const youpro = await account('YouPro DAT');
    await seat(riley, youpro, 'ryan.sands@example.test').expect(201);
    const { version } = await profile(riley);
    await agents.manager.post(`/api/dispatch/members/${riley}/leave`).set(headers).send({ version, leftAt: usDay('latest'), reason: 'Moved on.' }).expect(201);
    const [removal] = await db.query(`SELECT id, profile FROM it_removal_requests WHERE "memberId" = $1`, [riley]);
    expect(removal.profile.seats).toEqual([expect.objectContaining({ account: 'YouPro DAT', signInEmail: 'ryan.sands@example.test', sharedWith: [] })]);
    let detail = (await agents.it.get(`/api/it/removals/${removal.id}`).set(headers).expect(200)).body;
    expect(detail.seats).toHaveLength(1);
    for (const task of detail.tasks) {
      detail = (await agents.it.patch(`/api/it/removals/${removal.id}/tasks/${task.key}`).set(headers).send({ version: detail.request.version, status: task.optional ? 'NOT_NEEDED' : 'COMPLETED' }).expect(200)).body;
    }
    expect(detail.request.completedAt).not.toBeNull();
    expect((await seatsOf(riley)).map((row: Row) => [row.status, row.endedHow])).toEqual([['ENDED', 'LEFT']]);
  });

  it('reopens Load boards on an open removal when a seat is added during their notice', async () => {
    const riley = await addOne('Riley');
    const { version } = await profile(riley);
    await agents.manager.post(`/api/dispatch/members/${riley}/leave`).set(headers).send({ version, leftAt: addDays(usDay('latest'), 10), reason: 'Moved on.' }).expect(201);
    const [removal] = await db.query(`SELECT id FROM it_removal_requests WHERE "memberId" = $1`, [riley]);
    await db.query(`UPDATE it_removal_tasks SET status = 'COMPLETED' WHERE "requestId" = $1 AND key = 'BUSINESS_SOFTWARE'`, [removal.id]);
    await seat(riley, await account('YouPro DAT'), 'ryan.sands@example.test').expect(201);
    const [after] = await db.query(`SELECT r.profile, t.status FROM it_removal_requests r JOIN it_removal_tasks t ON t."requestId" = r.id AND t.key = 'BUSINESS_SOFTWARE' WHERE r.id = $1`, [removal.id]);
    expect(after.status).toBe('PENDING');
    expect(after.profile.seats).toEqual([expect.objectContaining({ account: 'YouPro DAT' })]);
  });

  it('filters Dispatchers by load board account', async () => {
    const riley = await addOne('Riley'), kai = await addOne('Kai', { personalEmail: 'kai.home@example.test' });
    const youpro = await account('YouPro DAT');
    await seat(riley, youpro, 'ryan.sands@example.test').expect(201);
    const { body } = await agents.manager.get(`/api/dispatch/members?page=1&status=ALL&loadBoardAccountId=${youpro}`).set(headers).expect(200);
    expect(body.items.map((row: Row) => row.id)).toEqual([riley]);
    expect(body.options.loadBoardAccounts.map((row: Row) => row.name)).toContain('YouPro DAT');
    expect(kai).toBeTruthy();
  });

  it('turns the sign-ins recorded before it into seats when the migration runs', async () => {
    const riley = await addOne('Riley', { datEmail: 'riley.dat@example.test' }), gone = await addOne('Gone', { personalEmail: 'gone.home@example.test', truckstopEmail: 'gone.ts@example.test' });
    await db.query(`UPDATE dispatch_members SET status = 'LEFT', "leftAt" = now() WHERE id = $1`, [gone]);
    await db.undoLastMigration(); // HandPhotos, with none here
    await db.undoLastMigration(); // AccountRequests, with none here
    await db.undoLastMigration(); // CompanyAccounts, with none here
    await db.undoLastMigration(); // LoadBoardSeats
    await db.runMigrations();
    expect((await seatsOf(riley)).map((row: Row) => [row.account, row.signInEmail, row.status])).toEqual([['DAT account not recorded', 'riley.dat@example.test', 'ACTIVE']]);
    expect((await seatsOf(gone)).map((row: Row) => [row.account, row.status, row.endedHow])).toEqual([['Truckstop account not recorded', 'ENDED', 'LEFT']]);
  });
  it('refuses a rollback once a real account is recorded', async () => {
    await account('YouPro DAT');
    const runner = db.createQueryRunner();
    const { LoadBoardSeats1793240000000: Migration } = await import('../src/database/migrations/1793240000000-LoadBoardSeats');
    await expect(new Migration().down(runner)).rejects.toThrow('Refusing to roll back while load board accounts');
    await runner.release();
  });
});
