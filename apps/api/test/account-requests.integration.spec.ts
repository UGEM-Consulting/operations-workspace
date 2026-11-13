import { usDay } from '../src/modules/safety/screening-rules';
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
import { CompanyAccountsModule } from '../src/modules/company-accounts/company-accounts.module';
type Agent = ReturnType<typeof request.agent>;
type Key = 'manager' | 'it';
type Row = Record<string, unknown>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

integration('IT requests about company accounts (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>, northwind: string, lakeside: string, red: string;
  const password = randomBytes(24).toString('base64url');
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  const base = (row: number, name: string, extra: Row = {}): Row => ({ row, firstName: name, lastName: 'Fictional', mc: 'Lakeside Carriers', team: '', jobTitle: 'Dispatcher', startedOn: '2024-03-04', personalEmail: `${name.toLowerCase()}.home@example.test`, ...extra });
  const addOne = async (name: string, extra: Row = {}) => (await agents.manager.post('/api/dispatch/existing/add').set(headers).send({ rows: [base(2, name, extra)] }).expect(201)).body.members[0].id as string;
  const profile = async (id: string) => (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body;
  const detail = async (id: string) => (await agents.it.get(`/api/it/accounts/${id}`).set(headers).expect(200)).body;
  async function finish(id: string, record?: Row) {
    let page = await detail(id);
    if (record) page = (await agents.it.patch(`/api/it/accounts/${id}/contact`).set(headers).send({ version: page.request.version, ...record }).expect(200)).body;
    for (const task of page.tasks) page = (await agents.it.patch(`/api/it/accounts/${id}/tasks/${task.key}`).set(headers).send({ version: page.request.version, status: 'COMPLETED' }).expect(200)).body;
    return page;
  }

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, ItModule, WorkspaceModule, DispatchModule, LoadBoardsModule, CompanyAccountsModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, notification_deliveries, it_removal_requests, list_events, it_account_requests CASCADE');
    await db.query(`INSERT INTO load_board_accounts (provider, name, "nameKey", placeholder) VALUES ('DAT', 'DAT account not recorded', 'dat account not recorded', true), ('TRUCKSTOP', 'Truckstop account not recorded', 'truckstop account not recorded', true) ON CONFLICT DO NOTHING`);
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `requests.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    }
    [{ id: northwind }] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Northwind Freight','northwind freight') RETURNING id`);
    [{ id: lakeside }] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Lakeside Carriers','lakeside carriers') RETURNING id`);
    [{ id: red }] = await db.query(`INSERT INTO teams (name,"nameKey","mcId") VALUES ('Red team','red team',$1) RETURNING id`, [northwind]);
    await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Dispatcher','dispatcher')`);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, it_removal_requests, users, list_events, it_account_requests CASCADE'); await db.destroy(); } });

  it('asks IT to close an account once no seat uses it, and marks it Closed when IT finishes', async () => {
    const riley = await addOne('Riley');
    const { id: accountId } = (await agents.it.post('/api/company-accounts').set(headers).send({ memberId: riley, companyName: 'YouPro', companyEmail: 'ryan@example.test' }).expect(201)).body;
    const [youpro] = (await agents.it.post('/api/lists/load-board-accounts').set(headers).send({ provider: 'DAT', name: 'YouPro DAT' }).expect(201)).body.id ? [(await db.query(`SELECT id FROM load_board_accounts WHERE name = 'YouPro DAT'`))[0].id] : [];
    const seat = (await agents.it.post('/api/load-board-seats').set(headers).send({ memberId: riley, accountId: youpro, signInEmail: 'ryan@example.test', startedOn: '2025-02-01' }).expect(201)).body;
    const close = async (status: number) => { const [account] = (await profile(riley)).companyAccounts; return agents.manager.post(`/api/company-accounts/${accountId}/close`).set(headers).send({ version: account.version, emailAfter: 'FORWARD', note: 'Not used since the move.' }).expect(status); };
    await agents.it.post(`/api/company-accounts/${accountId}/close`).set(headers).send({ version: 1, emailAfter: 'SUSPEND' }).expect(403);
    expect((await close(409)).body.message).toMatch(/still signs in to YouPro DAT/);
    await agents.it.post(`/api/load-board-seats/${seat.id}`).set(headers).send({ version: 1, action: 'END', on: usDay('latest') }).expect(201);
    const { id } = (await close(201)).body;
    await close(409);
    const page = await detail(id);
    expect(page.request).toMatchObject({ kind: 'CLOSE', emailAfter: 'FORWARD', note: 'Not used since the move.', profile: { fromMc: 'YouPro', close: [{ label: 'Company email', value: 'ryan@example.test' }] } });
    expect(page.tasks.map((task: Row) => task.key)).toEqual(['CLOSE_EMAIL', 'SHARED_PASSWORDS']);
    expect((await profile(riley)).accountRequests).toEqual([expect.objectContaining({ id, kind: 'CLOSE', accountId })]);
    const tasks = (await agents.it.get('/api/it/tasks?accounts=1').set(headers).expect(200)).body;
    expect(tasks.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'CLOSE_ACCOUNT', id })]));
    expect(tasks.stats.accounts).toBe(1);
    await agents.it.patch(`/api/it/accounts/${id}/tasks/CLOSE_EMAIL`).set(headers).send({ version: page.request.version, status: 'BLOCKED' }).expect(400);
    const done = await finish(id);
    expect(done.request.completedAt).not.toBeNull();
    expect((await profile(riley)).companyAccounts[0]).toMatchObject({ status: 'CLOSED' });
    const [notice] = await db.query(`SELECT kind, "recipientId" FROM portal_notifications WHERE "accountRequestId" = $1`, [id]);
    expect(notice).toEqual({ kind: 'IT_ACCOUNT_COMPLETED', recipientId: users.manager.id });
    const listed = (await agents.manager.get('/api/notifications').set(headers).expect(200)).body.items;
    expect(listed[0]).toMatchObject({ kind: 'IT_ACCOUNT_COMPLETED', memberId: riley, displayName: 'Riley Fictional' });
  });

  it('asks IT for accounts at the new MC on a move, keeps an email a seat still uses, and swaps them when IT finishes', async () => {
    const casey = await addOne('Casey', { companyEmail: 'casey@example.test', ringCentralNumber: '+1 469 555 0131', datEmail: 'casey@example.test' });
    const move = async (extra: Row, status: number) => { const { version } = await profile(casey); return agents.manager.post(`/api/dispatch/members/${casey}/move`).set(headers).send({ version, mcId: northwind, teamId: red, startedAt: usDay('latest'), reason: 'Northwind needs help.', ...extra }).expect(status); };
    await move({ accounts: 'NEW' }, 201);
    const [request] = await db.query(`SELECT id FROM it_account_requests WHERE "memberId" = $1`, [casey]);
    const page = await detail(request.id);
    expect(page.request.profile).toMatchObject({ fromMc: 'Lakeside Carriers', toMc: 'Northwind Freight', close: [{ label: 'RingCentral number', value: '+1 469 555 0131' }],
      keep: [{ value: 'casey@example.test', reason: 'Signs in to DAT account not recorded' }] });
    expect(page.tasks.map((task: Row) => task.key)).toEqual(['NEW_EMAIL', 'NEW_NUMBER', 'CLOSE_NUMBER']);
    // Nothing changes on the record until IT finishes.
    expect((await profile(casey)).existing.companyEmail).toBe('casey@example.test');
    await agents.it.patch(`/api/it/accounts/${request.id}/tasks/NEW_EMAIL`).set(headers).send({ version: page.request.version, status: 'COMPLETED' }).expect(400);
    const done = await finish(request.id, { companyEmail: 'casey.hart@example.test', ringCentralNumber: '+1 469 555 0177' });
    expect(done.request.completedAt).not.toBeNull();
    const after = await profile(casey);
    expect(after.existing).toMatchObject({ companyEmail: 'casey.hart@example.test', ringCentralNumber: '+1 469 555 0177' });
    expect(after.companyAccounts).toEqual([expect.objectContaining({ mc: 'Lakeside Carriers', companyEmail: 'casey@example.test', ringCentralNumber: '+1 469 555 0131', status: 'KEPT_FOR_LOAD_BOARDS', keptFor: ['DAT account not recorded'] })]);
    // Keep the same accounts (the default) asks IT for nothing.
    const { version } = await profile(casey);
    await agents.manager.post(`/api/dispatch/members/${casey}/move`).set(headers).send({ version, mcId: lakeside, teamId: null, startedAt: usDay('latest'), reason: 'Back.' }).expect(201);
    expect((await db.query(`SELECT count(*)::integer AS n FROM it_account_requests WHERE "memberId" = $1`, [casey]))[0].n).toBe(1);
  });

  it('refuses a rollback while account requests exist', async () => {
    const riley = await addOne('Riley');
    const { id } = (await agents.it.post('/api/company-accounts').set(headers).send({ memberId: riley, companyName: 'YouPro', companyEmail: 'ryan@example.test' }).expect(201)).body;
    await agents.manager.post(`/api/company-accounts/${id}/close`).set(headers).send({ version: 1, emailAfter: 'SUSPEND' }).expect(201);
    const runner = db.createQueryRunner();
    const { AccountRequests1793260000000: Migration } = await import('../src/database/migrations/1793260000000-AccountRequests');
    await expect(new Migration().down(runner)).rejects.toThrow('Refusing to roll back while IT requests about company accounts');
    await runner.release();
  });
});
