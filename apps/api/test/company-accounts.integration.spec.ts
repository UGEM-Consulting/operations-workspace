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
import { CompanyAccountsModule } from '../src/modules/company-accounts/company-accounts.module';
type Agent = ReturnType<typeof request.agent>;
type Key = 'manager' | 'it';
type Row = Record<string, unknown>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

integration('Company accounts at other MCs (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>, lakeside: string;
  const password = randomBytes(24).toString('base64url');
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  const base = (row: number, name: string, extra: Row = {}): Row => ({ row, firstName: name, lastName: 'Fictional', mc: 'Northwind Freight', team: 'Red team', jobTitle: 'Dispatcher', startedOn: '2024-03-04', personalEmail: `${name.toLowerCase()}.home@example.test`, ...extra });
  const check = async (rows: Row[]) => (await agents.manager.post('/api/dispatch/existing/check').set(headers).send({ rows }).expect(201)).body;
  const add = async (rows: Row[], sourceName?: string) => (await agents.manager.post('/api/dispatch/existing/add').set(headers).send({ rows, sourceName }).expect(201)).body;
  const addOne = async (name: string, extra: Row = {}) => { const body = await add([base(2, name, extra)]); expect(body.left).toEqual([]); return body.members[0].id as string; };
  const profile = async (id: string) => (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body;
  const account = (body: Row) => agents.it.post('/api/company-accounts').set(headers).send(body);

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
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, notification_deliveries, it_removal_requests, list_events CASCADE');
    await db.query(`INSERT INTO load_board_accounts (provider, name, "nameKey", placeholder) VALUES ('DAT', 'DAT account not recorded', 'dat account not recorded', true), ('TRUCKSTOP', 'Truckstop account not recorded', 'truckstop account not recorded', true) ON CONFLICT DO NOTHING`);
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `accounts.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    }
    const [mc] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Northwind Freight','northwind freight') RETURNING id`);
    [{ id: lakeside }] = await db.query(`INSERT INTO mcs (name,"nameKey","archivedAt") VALUES ('Lakeside Carriers','lakeside carriers', now()) RETURNING id`);
    await db.query(`INSERT INTO teams (name,"nameKey","mcId") VALUES ('Red team','red team',$1)`, [mc.id]);
    await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Dispatcher','dispatcher')`);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, it_removal_requests, users, list_events CASCADE'); await db.destroy(); } });

  it('lets IT and administrators record accounts at other companies, one owner for each open email', async () => {
    const riley = await addOne('Riley', { companyEmail: 'riley@example.test' }), sky = await addOne('Sky');
    await agents.manager.post('/api/company-accounts').set(headers).send({ memberId: riley, mcId: lakeside, companyEmail: 'ryan@example.test' }).expect(403);
    await account({ memberId: riley, mcId: lakeside }).expect(400);
    await account({ memberId: riley, mcId: lakeside, companyName: 'Other' }).expect(400);
    await account({ memberId: sky, mcId: lakeside, companyEmail: 'riley@example.test' }).expect(409);
    await account({ memberId: riley, mcId: lakeside, companyEmail: 'ryan@realcompany.com' }).expect(400);
    const added = (await account({ memberId: riley, mcId: lakeside, nameUsed: 'Ryan Sands', companyEmail: 'Ryan@example.test', ringCentralNumber: '+1 469 555 0131', ringCentralExtension: '214' }).expect(201)).body;
    await account({ memberId: sky, companyName: 'YouPro', companyEmail: 'ryan@example.test' }).expect(409);
    // Edit recorded details refuses it for someone else too: one person, one record.
    const { version } = await profile(sky);
    await agents.manager.patch(`/api/dispatch/members/${sky}/existing`).set(headers).send({ version, companyEmail: 'ryan@example.test' }).expect(409);
    // And the main company email of someone added by hand (the already-here check once skipped people with no application).
    await agents.manager.patch(`/api/dispatch/members/${sky}/existing`).set(headers).send({ version, companyEmail: 'riley@example.test' }).expect(409);
    const page = await profile(riley);
    expect(page.companyAccounts).toEqual([expect.objectContaining({ id: added.id, mc: 'Lakeside Carriers', mcArchived: true, nameUsed: 'Ryan Sands', companyEmail: 'ryan@example.test', status: 'ACTIVE', keptFor: [] })]);
    const change = (body: Row) => agents.it.patch(`/api/company-accounts/${added.id}`).set(headers).send(body);
    await change({ version: 1, status: 'CLOSED', closedOn: '2099-01-01' }).expect(400);
    await change({ version: 1, status: 'KEPT_FOR_LOAD_BOARDS' }).expect(200);
    await change({ version: 2, status: 'CLOSED', closedOn: usDay('latest') }).expect(200);
    // Closed, its email is free again.
    await account({ memberId: sky, companyName: 'YouPro', companyEmail: 'ryan@example.test' }).expect(201);
    const events = await db.query(`SELECT event, metadata FROM dispatch_events WHERE event LIKE 'COMPANY_ACCOUNT_%' ORDER BY "createdAt"`);
    expect(events.map((row: Row) => [row.event, row.metadata])).toEqual([
      ['COMPANY_ACCOUNT_ADDED', { status: 'ACTIVE', fields: ['nameUsed', 'companyEmail', 'ringCentralNumber', 'ringCentralExtension'], from: 'form' }],
      ['COMPANY_ACCOUNT_CHANGED', { fields: [], status: 'KEPT_FOR_LOAD_BOARDS' }], ['COMPANY_ACCOUNT_CHANGED', { fields: [], status: 'CLOSED' }],
      ['COMPANY_ACCOUNT_ADDED', { status: 'ACTIVE', fields: ['companyEmail'], from: 'form' }]]);
    expect(JSON.stringify(events)).not.toContain('@');
  });

  it('records a row from another company as an account of someone already here, not a second record', async () => {
    const riley = await addOne('Riley', { companyEmail: 'riley@example.test' });
    const row = base(2, 'Ryan', { lastName: 'Sands', mc: 'Lakeside Carriers', team: '', personalEmail: 'riley.home@example.test', companyEmail: 'ryan@example.test', ringCentralNumber: '+1 469 555 0131', datEmail: 'ryan@example.test' });
    const checked = (await check([row])).rows[0];
    expect(checked).toMatchObject({ status: 'ALREADY', match: { id: riley, options: expect.arrayContaining(['ACCOUNT']), account: { mc: 'Lakeside Carriers', adds: ['company email', 'RingCentral number', 'other name', 'DAT seat'] } } });
    const done = await add([{ ...row, alreadyAction: 'ACCOUNT' }], 'lakeside.csv');
    expect(done).toMatchObject({ added: 0, accounts: 1, left: [] });
    const page = await profile(riley);
    expect(page.companyAccounts).toEqual([expect.objectContaining({ mc: 'Lakeside Carriers', nameUsed: 'Ryan Sands', companyEmail: 'ryan@example.test', sourceName: 'lakeside.csv', keptFor: ['DAT account not recorded'] })]);
    expect(page.otherNames).toEqual([expect.objectContaining({ name: 'Ryan Sands', mc: 'Lakeside Carriers' })]);
    expect(page.loadBoardSeats).toEqual([expect.objectContaining({ signInEmail: 'ryan@example.test', status: 'ACTIVE' })]);
    expect(page.existing.companyEmail).toBe('riley@example.test');
    // The same file again: matched by that account's email, and nothing more to add there.
    const again = (await check([row])).rows[0];
    expect(again.status).toBe('ALREADY');
    expect(again.match.options).not.toContain('ACCOUNT');
    // Search finds them by it.
    const found = (await agents.manager.get('/api/dispatch/members?page=1&status=ALL&search=ryan@example').set(headers).expect(200)).body;
    expect(found.items.map((item: Row) => [item.id, item.matched])).toEqual([[riley, { label: 'Company email at Lakeside Carriers', value: 'ryan@example.test' }]]);
  });

  it('lists accounts at other companies on IT’s removal, and reopens Google Workspace for one IT wasn’t told about', async () => {
    const riley = await addOne('Riley');
    await account({ memberId: riley, mcId: lakeside, companyEmail: 'ryan@example.test' }).expect(201);
    const { version } = await profile(riley);
    await agents.manager.post(`/api/dispatch/members/${riley}/leave`).set(headers).send({ version, leftAt: addDays(usDay('latest'), 10), reason: 'Moved on.' }).expect(201);
    const [removal] = await db.query(`SELECT id, profile FROM it_removal_requests WHERE "memberId" = $1`, [riley]);
    expect(removal.profile.companyAccounts).toEqual([expect.objectContaining({ company: 'Lakeside Carriers', companyEmail: 'ryan@example.test' })]);
    await db.query(`UPDATE it_removal_tasks SET status = 'COMPLETED' WHERE "requestId" = $1 AND key = 'GOOGLE_WORKSPACE'`, [removal.id]);
    await account({ memberId: riley, companyName: 'YouPro', companyEmail: 'ryan.yp@example.test' }).expect(201);
    const [after] = await db.query(`SELECT r.profile, t.status FROM it_removal_requests r JOIN it_removal_tasks t ON t."requestId" = r.id AND t.key = 'GOOGLE_WORKSPACE' WHERE r.id = $1`, [removal.id]);
    expect(after.status).toBe('PENDING');
    expect(after.profile.companyAccounts.map((item: Row) => item.company)).toEqual(['Lakeside Carriers', 'YouPro']);
  });

  it('refuses a rollback while accounts at other companies are recorded', async () => {
    await account({ memberId: await addOne('Riley'), mcId: lakeside, companyEmail: 'ryan@example.test' }).expect(201);
    const runner = db.createQueryRunner();
    const { CompanyAccounts1793250000000: Migration } = await import('../src/database/migrations/1793250000000-CompanyAccounts');
    await expect(new Migration().down(runner)).rejects.toThrow('Refusing to roll back while company accounts');
    await runner.release();
  });
});
