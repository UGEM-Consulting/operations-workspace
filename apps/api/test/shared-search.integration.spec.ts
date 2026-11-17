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
import { SearchModule } from '../src/modules/search/search.module';
import { addDays, usDay } from '../src/modules/safety/screening-rules';
type Agent = ReturnType<typeof request.agent>;
type Key = 'manager' | 'it';
type Row = Record<string, unknown>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Section 35: shared company email and RingCentral number, and search as you type. Fictional people only.
integration('Shared accounts and search (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>, teamId: string;
  const password = randomBytes(24).toString('base64url');
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  const base = (row: number, first: string, last: string, extra: Row = {}): Row => ({ row, firstName: first, lastName: last, mc: 'Northwind Freight', team: 'Red team', jobTitle: 'Dispatcher', startedOn: '2024-03-04', personalEmail: `${first.toLowerCase()}.home@example.test`, ...extra });
  const check = async (rows: Row[]) => (await agents.manager.post('/api/dispatch/existing/check').set(headers).send({ rows }).expect(201)).body;
  const add = async (rows: Row[]) => (await agents.manager.post('/api/dispatch/existing/add').set(headers).send({ rows }).expect(201)).body;
  const addOne = async (first: string, last: string, extra: Row = {}) => { const body = await add([base(2, first, last, extra)]); expect(body.left).toEqual([]); return body.members[0].id as string; };
  const profile = async (id: string) => (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body;
  const edit = async (id: string, body: Row, status = 200) => { const { version } = await profile(id); return agents.manager.patch(`/api/dispatch/members/${id}/existing`).set(headers).send({ version, ...body }).expect(status); };

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, ItModule, WorkspaceModule, DispatchModule, LoadBoardsModule, CompanyAccountsModule, SearchModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, notification_deliveries, it_removal_requests, list_events CASCADE');
    await db.query(`INSERT INTO load_board_accounts (provider, name, "nameKey", placeholder) VALUES ('DAT', 'DAT account not recorded', 'dat account not recorded', true), ('TRUCKSTOP', 'Truckstop account not recorded', 'truckstop account not recorded', true) ON CONFLICT DO NOTHING`);
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `shared.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    }
    const [mc] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Northwind Freight','northwind freight') RETURNING id`);
    [{ id: teamId }] = await db.query(`INSERT INTO teams (name,"nameKey","mcId") VALUES ('Red team','red team',$1) RETURNING id`, [mc.id]);
    await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Dispatcher','dispatcher')`);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, it_removal_requests, users, list_events CASCADE'); await db.destroy(); } });

  it('asks before recording someone else’s email or number, then records it as shared on both pages', async () => {
    const riley = await addOne('Riley', 'Santos', { companyEmail: 'riley.santos@example.test', ringCentralNumber: '+1 469 555 0142' }), drew = await addOne('Drew', 'Calloway');
    const owners = (await agents.manager.post('/api/dispatch/existing/account-owners').set(headers).send({ memberId: drew, companyEmail: 'Riley.Santos@example.test', ringCentralNumber: '(469) 555-0142' }).expect(201)).body;
    expect(owners).toEqual({ companyEmail: [{ id: riley, name: 'Riley Santos', onRecord: true }], ringCentralNumber: [{ id: riley, name: 'Riley Santos', onRecord: true }] });
    // Without the answer it's refused, as before; with it, recorded as shared and never on Drew's own record.
    expect((await edit(drew, { companyEmail: 'riley.santos@example.test' }, 409)).body.message).toContain('Riley Santos');
    await edit(drew, { companyEmail: 'riley.santos@example.test', ringCentralNumber: '+1 469 555 0142', ringCentralExtension: '231', shareCompanyEmail: true, shareRingCentral: true });
    const drewPage = await profile(drew);
    expect(drewPage.existing).toEqual(expect.objectContaining({ companyEmail: null, ringCentralNumber: null, ringCentralExtension: '231' }));
    expect(drewPage.sharing.uses).toEqual([expect.objectContaining({ kind: 'EMAIL', value: 'riley.santos@example.test', owner: { id: riley, name: 'Riley Santos' }, handedOver: false }),
      expect.objectContaining({ kind: 'RINGCENTRAL', value: '+1 469 555 0142', owner: { id: riley, name: 'Riley Santos' } })]);
    expect((await profile(riley)).sharing.usedBy).toEqual([{ kind: 'EMAIL', value: 'riley.santos@example.test', users: [{ id: drew, name: 'Drew Calloway' }] },
      { kind: 'RINGCENTRAL', value: '+1 469 555 0142', users: [{ id: drew, name: 'Drew Calloway' }] }]);
    // The form sends the shared value back unchanged on the next save: nothing changes. Clearing it ends the sharing.
    await edit(drew, { companyEmail: 'riley.santos@example.test', personalPhone: '+1 202 555 0193' });
    expect((await profile(drew)).sharing.uses).toHaveLength(2);
    await edit(drew, { companyEmail: '' });
    expect((await profile(drew)).sharing.uses.map((use: Row) => use.kind)).toEqual(['RINGCENTRAL']);
    const events = await db.query(`SELECT event, metadata FROM dispatch_events WHERE event IN ('ACCOUNT_SHARED','SHARING_ENDED') ORDER BY "createdAt"`);
    expect(events.map((row: Row) => [row.event, row.metadata])).toEqual([['ACCOUNT_SHARED', { kind: 'EMAIL' }], ['ACCOUNT_SHARED', { kind: 'RINGCENTRAL' }], ['SHARING_ENDED', { kind: 'EMAIL', how: 'STOPPED' }]]);
    // Search finds a shared number on everyone using it, marked whose it is.
    const found = (await agents.manager.get('/api/dispatch/members').query({ status: 'ALL', search: '555 0142' }).set(headers).expect(200)).body;
    expect(found.items.map((row: Row) => [row.firstName, row.matched])).toEqual([['Drew', { label: 'RingCentral number, Riley Santos’s, shared', value: '+1 469 555 0142' }], ['Riley', { label: 'RingCentral number', value: '+1 469 555 0142' }]]);
  });

  it('moves an email typed on the wrong person to its owner, keeping the other as a user', async () => {
    // The case found on Nov 17: Drew was added with Riley's email.
    const drew = await addOne('Drew', 'Calloway', { companyEmail: 'riley.santos@example.test' });
    const checked = await check([base(2, 'Riley', 'Santos', { companyEmail: 'riley.santos@example.test' })]);
    expect(checked.rows[0]).toEqual(expect.objectContaining({ status: 'CHOICE', shared: { owners: [{ id: drew, name: 'Drew Calloway', fields: ['companyEmail'] }], options: ['SHARED', 'MOVE_SHARED', 'MOVE', 'WITHOUT'] } }));
    const added = await add([base(2, 'Riley', 'Santos', { companyEmail: 'riley.santos@example.test', sharedAction: 'MOVE_SHARED' })]);
    const riley = added.members[0].id;
    expect((await profile(riley)).existing.companyEmail).toBe('riley.santos@example.test');
    const drewPage = await profile(drew);
    expect(drewPage.existing.companyEmail).toBeNull();
    expect(drewPage.sharing.uses).toEqual([expect.objectContaining({ kind: 'EMAIL', owner: { id: riley, name: 'Riley Santos' } })]);
    expect(await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'ACCOUNT_MOVED'`)).toEqual([{ metadata: { fields: ['companyEmail'], stillUses: true } }]);
    // A third person with the same email now asks about Riley, and adding them as a user works; same name is the same person.
    const sky = await check([base(3, 'Sky', 'Martin', { companyEmail: 'riley.santos@example.test' })]);
    expect(sky.rows[0].shared.owners).toEqual([{ id: riley, name: 'Riley Santos', fields: ['companyEmail'] }]);
    expect((await check([base(4, 'Riley', 'Santos', { companyEmail: 'riley.santos@example.test' })])).rows[0].status).toBe('ALREADY');
    const skyId = (await add([base(3, 'Sky', 'Martin', { companyEmail: 'riley.santos@example.test', sharedAction: 'SHARED' })])).members[0].id;
    expect((await profile(riley)).sharing.usedBy[0].users.map((user: Row) => user.name)).toEqual(['Drew Calloway', 'Sky Martin']);
    expect((await profile(skyId)).existing.companyEmail).toBeNull();
  });

  it('hands a leaving owner’s email and number to someone using them, or closes them', async () => {
    const riley = await addOne('Riley', 'Santos', { companyEmail: 'riley.santos@example.test', ringCentralNumber: '+1 469 555 0142' });
    const drew = await addOne('Drew', 'Calloway'), morgan = await addOne('Morgan', 'Pike');
    await edit(drew, { companyEmail: 'riley.santos@example.test', shareCompanyEmail: true });
    await edit(morgan, { ringCentralNumber: '+1 469 555 0142', shareRingCentral: true });
    const leave = async (body: Row, status: number) => { const { version } = await profile(riley); return agents.manager.post(`/api/dispatch/members/${riley}/leave`).set(headers).send({ version, leftAt: usDay('latest'), reason: 'Moved to another company.', ...body }).expect(status); };
    await leave({ handOverTo: users.manager.id }, 400);
    await leave({ handOverTo: drew }, 201);
    const [removal] = await db.query(`SELECT profile FROM it_removal_requests WHERE "memberId" = $1`, [riley]);
    expect(removal.profile.shared).toEqual({ uses: [], usedBy: [{ kind: 'EMAIL', value: 'riley.santos@example.test', users: ['Drew Calloway'] }, { kind: 'RINGCENTRAL', value: '+1 469 555 0142', users: ['Morgan Pike'] }], handOverToId: drew, handOverTo: 'Drew Calloway' });
    // Drew owns both now; Morgan uses the number as Drew's.
    const drewPage = await profile(drew);
    expect(drewPage.sharing.uses.map((use: Row) => [use.kind, use.handedOver])).toEqual([['EMAIL', true], ['RINGCENTRAL', true]]);
    expect(drewPage.sharing.usedBy).toEqual([{ kind: 'RINGCENTRAL', value: '+1 469 555 0142', users: [{ id: morgan, name: 'Morgan Pike' }] }]);
    expect((await agents.manager.post('/api/dispatch/existing/account-owners').set(headers).send({ companyEmail: 'riley.santos@example.test' }).expect(201)).body.companyEmail).toEqual([{ id: drew, name: 'Drew Calloway', onRecord: false }]);
    // Drew leaves without a hand-over: Morgan's use ends with them, and nothing names a value in events.
    const drewVersion = (await profile(drew)).version;
    await agents.manager.post(`/api/dispatch/members/${drew}/leave`).set(headers).send({ version: drewVersion, leftAt: usDay('latest'), reason: 'Left.' }).expect(201);
    expect((await profile(morgan)).sharing.uses).toEqual([]);
    expect(await db.query(`SELECT "endedHow" FROM member_shared_accounts WHERE "memberId" = $1`, [morgan])).toEqual([{ endedHow: 'OWNER_LEFT' }]);
    expect(JSON.stringify(await db.query(`SELECT metadata FROM dispatch_events`))).not.toMatch(/@|555/);
  });

  it('gives IT a removal for shared accounts only, adds steps for a later one, and leaves an unchanged value alone', async () => {
    const riley = await addOne('Riley', 'Santos', { companyEmail: 'riley.santos@example.test', ringCentralNumber: '+1 469 555 0142' });
    const sue = (await add([{ row: 2, firstName: 'Sue', lastName: 'Support', position: 'Support', supports: 'Riley Santos', startedOn: '2024-03-04', personalEmail: 'sue.home@example.test' }])).members[0].id;
    await edit(sue, { companyEmail: 'riley.santos@example.test', shareCompanyEmail: true });
    // A support with nothing recorded of their own still gets a removal while they use Riley's email, with the Google Workspace step.
    const { version } = await profile(sue);
    await agents.manager.post(`/api/dispatch/members/${sue}/leave`).set(headers).send({ version, leftAt: `${usDay('latest')}T12:00:00.000Z`, reason: 'Moving.' }).expect(201);
    const [removal] = await db.query(`SELECT id, profile FROM it_removal_requests WHERE "memberId" = $1`, [sue]);
    expect(removal.profile.shared.uses).toEqual([{ kind: 'EMAIL', value: 'riley.santos@example.test', owner: 'Riley Santos', handedOver: false }]);
    expect((await db.query(`SELECT key FROM it_removal_tasks WHERE "requestId" = $1 ORDER BY key`, [removal.id])).map((row: Row) => row.key)).toEqual(['DISPATCH_GROUP', 'GOOGLE_WORKSPACE', 'SHARED_PASSWORDS']);
    // Riley on notice; someone starting to use Riley's number later adds that step to Riley's removal.
    const rileyVersion = (await profile(riley)).version;
    await agents.manager.post(`/api/dispatch/members/${riley}/leave`).set(headers).send({ version: rileyVersion, leftAt: `${addDays(usDay('latest'), 7)}T12:00:00.000Z`, reason: 'Moving.' }).expect(201);
    const kai = await addOne('Kai', 'Fictional');
    await db.query(`UPDATE it_removal_tasks SET status = 'COMPLETED' WHERE key = 'RINGCENTRAL' AND "requestId" = (SELECT id FROM it_removal_requests WHERE "memberId" = $1)`, [riley]);
    await edit(kai, { ringCentralNumber: '+1 469 555 0142', shareRingCentral: true });
    expect(await db.query(`SELECT status FROM it_removal_tasks WHERE key = 'RINGCENTRAL' AND "requestId" = (SELECT id FROM it_removal_requests WHERE "memberId" = $1)`, [riley])).toEqual([{ status: 'PENDING' }]);
    // Two records holding one number from before sharing: saving something else on either isn't refused.
    const omar = await addOne('Omar', 'Fictional');
    await db.query(`UPDATE existing_member_records SET "ringCentralNumber" = '+1 469 555 0142' WHERE "memberId" = $1`, [omar]);
    await edit(omar, { ringCentralNumber: '+1 469 555 0142', telegram: '@omarfictional' });
  });

  it('searches people, not groups, and suggests teams and team leads as filters', async () => {
    const riley = await addOne('Riley', 'Santos'), casey = await addOne('Casey', 'Hart');
    await addOne('Jesse', 'Lin', { otherNameList: [{ name: 'Riley Lin' }] });
    await db.query(`UPDATE teams SET "leadMemberId" = $1 WHERE id = $2`, [riley, teamId]);
    const list = (await agents.manager.get('/api/dispatch/members').query({ status: 'ALL', search: 'Riley Santos' }).set(headers).expect(200)).body;
    expect(list.items.map((row: Row) => row.id)).toEqual([riley]);
    expect(list.leadOf).toEqual({ id: riley, name: 'Riley Santos', teamId, team: 'Red team', count: 3 });
    // The team's name no longer matches everyone in it.
    expect((await agents.manager.get('/api/dispatch/members').query({ status: 'ALL', search: 'Red team' }).set(headers).expect(200)).body.items).toEqual([]);
    const suggest = (q: string) => agents.manager.get('/api/dispatch/members/suggest').query({ q }).set(headers);
    expect((await suggest('ri').expect(200)).body).toEqual({ people: [], teams: [], leads: [], total: 0 });
    const typed = (await suggest('rile').expect(200)).body;
    expect(typed.people.map((row: Row) => [row.firstName, row.matched])).toEqual([['Riley', null], ['Jesse', { label: 'Other name', value: 'Riley Lin' }]]);
    expect(typed.leads).toEqual([{ id: riley, name: 'Riley Santos', teamId, team: 'Red team', count: 3 }]);
    expect((await suggest('red t').expect(200)).body.teams).toEqual([expect.objectContaining({ name: 'Red team', mc: 'Northwind Freight', count: 3 })]);
    expect(casey).toBeTruthy();
    // The top bar: grouped, only what this person may open; IT has no search.
    const everywhere = (await agents.manager.get('/api/search').query({ q: 'rile' }).set(headers).expect(200)).body;
    expect(everywhere.groups.map((group: Row) => group.key)).toEqual(['dispatchers']);
    expect(everywhere.groups[0].items[0]).toEqual({ id: riley, name: 'Riley Santos', meta: 'Dispatcher · team lead · Red team', status: { label: 'Active', tone: 'success' }, href: `/dispatch/dispatchers/${riley}` });
    await agents.it.get('/api/search').query({ q: 'rile' }).set(headers).expect(403);
  });
});
