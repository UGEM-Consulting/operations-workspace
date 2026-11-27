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
import { addDays, usDay } from '../src/modules/safety/screening-rules';
type Agent = ReturnType<typeof request.agent>;
type Key = 'manager' | 'it';
type Row = Record<string, unknown>;
type Entry = { id: string; at: string; category: string; icon: string; title: string; by: string | null; body: string | null };
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Section 38: the complete dispatcher History. Fictional people only.
integration('Complete dispatcher History (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>, mcId: string, red: string, blue: string, senior: string;
  const password = randomBytes(24).toString('base64url');
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  const base = (row: number, first: string, last: string, extra: Row = {}): Row => ({ row, firstName: first, lastName: last, mc: 'Northwind Freight', team: 'Red team', jobTitle: 'Dispatcher', startedOn: '2024-03-04', personalEmail: `${first.toLowerCase()}.home@example.test`, ...extra });
  const add = async (rows: Row[]) => (await agents.manager.post('/api/dispatch/existing/add').set(headers).send({ rows }).expect(201)).body;
  const addOne = async (first: string, last: string, extra: Row = {}) => (await add([base(2, first, last, extra)])).members[0].id as string;
  const profile = async (id: string) => (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body;
  const version = async (id: string) => (await profile(id)).version as number;
  const timeline = async (id: string) => (await profile(id)).timeline as { entries: Entry[]; counts: Record<string, number> };
  const titles = async (id: string) => (await timeline(id)).entries.map(entry => entry.title);
  const post = (key: Key, path: string, body: Row, status = 201) => agents[key].post(`/api/${path}`).set(headers).send(body).expect(status);

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
      users[key] = await db.getRepository(User).save({ firstName: key === 'manager' ? 'Avery' : 'Taylor', lastName: key === 'manager' ? 'Quinn' : 'Brooks', email: `history.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    }
    [{ id: mcId }] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Northwind Freight','northwind freight') RETURNING id`);
    [{ id: red }] = await db.query(`INSERT INTO teams (name,"nameKey","mcId") VALUES ('Red team','red team',$1) RETURNING id`, [mcId]);
    [{ id: blue }] = await db.query(`INSERT INTO teams (name,"nameKey","mcId") VALUES ('Blue team','blue team',$1) RETURNING id`, [mcId]);
    await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Dispatcher','dispatcher')`);
    [{ id: senior }] = await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Senior dispatcher','senior dispatcher') RETURNING id`);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, it_removal_requests, users, list_events CASCADE'); await db.destroy(); } });

  it('records and shows work changes: team lead, job title, moves, contacts and who helps them, newest first', async () => {
    const riley = await addOne('Riley', 'Santos', { companyEmail: 'riley.santos@example.test', ringCentralNumber: '+1 469 555 0142' });
    const team = async (id: string) => (await db.query(`SELECT version FROM teams WHERE id = $1`, [id]))[0].version as number;
    const teamVersion = await team(red);
    await agents.manager.patch(`/api/dispatch/teams/${red}`).set(headers).send({ version: teamVersion, leadMemberId: riley }).expect(200);
    const rileyVersion = await version(riley);
    await agents.manager.patch(`/api/dispatch/members/${riley}`).set(headers).send({ version: rileyVersion, jobTitleId: senior }).expect(200);
    await post('manager', `dispatch/members/${riley}/contacts`, { kind: 'PHONE', value: '+1 214 555 0199', label: 'Work cell' });
    const [phone] = await db.query(`SELECT id FROM member_contacts WHERE "memberId" = $1`, [riley]);
    await agents.manager.post(`/api/dispatch/members/${riley}/contacts/${phone.id}/remove`).set(headers).send({});
    const sue = (await add([{ row: 2, firstName: 'Sue', lastName: 'Support', position: 'Support', supports: 'Riley Santos', startedOn: '2024-03-04', personalEmail: 'sue.home@example.test' }])).members[0].id as string;
    await post('manager', `dispatch/members/${sue}/support-type`, { version: await version(sue), supportType: 'UPDATER' });
    await post('manager', `dispatch/members/${riley}/move`, { version: await version(riley), mcId, teamId: blue, startedAt: `${usDay('latest')}T12:00:00.000Z`, reason: 'Team change after the merge.' });
    const rileyTimeline = await timeline(riley);
    const shown = rileyTimeline.entries.map(entry => [entry.category, entry.title]);
    expect(shown).toEqual(expect.arrayContaining([
      ['WORK', 'Started in Red team at Northwind Freight'], ['WORK', 'Moved to Blue team at Northwind Freight'], ['WORK', 'Became team lead of Red team'], ['WORK', 'No longer team lead of Red team: they moved'],
      ['WORK', 'Job title changed to Senior dispatcher'], ['DETAILS', 'Phone number added'], ['DETAILS', 'Phone number removed'], ['WORK', 'Sue Support started helping them'], ['DETAILS', 'Added by hand']]));
    expect(rileyTimeline.entries.find(entry => entry.title === 'Moved to Blue team at Northwind Freight')).toMatchObject({ by: 'Avery Quinn', body: 'Team change after the merge.' });
    // Newest first, counts follow the categories, and nothing names a value.
    // A day picked in a form shows as a date and sorts after what was clicked that day (US Eastern).
    const times = rileyTimeline.entries.map(entry => (entry as { dateOnly?: boolean }).dateOnly ? new Date(`${entry.at.slice(0, 10)}T23:59:59.999-05:00`).toISOString() : entry.at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(rileyTimeline.entries.filter(entry => entry.at.endsWith('T12:00:00.000Z')).every(entry => (entry as { dateOnly?: boolean }).dateOnly)).toBe(true);
    expect(rileyTimeline.counts.WORK).toBe(rileyTimeline.entries.filter(entry => entry.category === 'WORK').length);
    // Random ids may hold any digits, so only what History shows is checked.
    expect(JSON.stringify(rileyTimeline.entries.map((entry: Row) => [entry.title, entry.by, entry.body]))).not.toMatch(/@|555|Work cell/);
    expect(await titles(sue)).toEqual(expect.arrayContaining(['Started helping Riley Santos', 'Now called an updater']));
    // Team lead events are on the person, not only the team.
    expect((await db.query(`SELECT event FROM dispatch_events WHERE "memberId" = $1 AND event LIKE 'TEAM_LEAD%' ORDER BY "createdAt"`, [riley])).map((row: Row) => row.event)).toEqual(['TEAM_LEAD_SET', 'TEAM_LEAD_CLEARED']);
  });

  it('shows accounts by name: seats and accounts at other companies, never the sign-in or email', async () => {
    const riley = await addOne('Riley', 'Santos');
    const lakeside = (await post('it', 'lists/load-board-accounts', { provider: 'DAT', name: 'Lakeside DAT' })).body.id;
    const seat = (await post('it', 'load-board-seats', { memberId: riley, accountId: lakeside, signInEmail: 'riley.dat@example.test', startedOn: '2025-02-01' })).body;
    await post('it', `load-board-seats/${seat.id}`, { version: seat.version, action: 'SUSPEND', on: usDay('latest') });
    const account = (await post('it', 'company-accounts', { memberId: riley, companyName: 'YouPro', companyEmail: 'riley.youpro@example.test' })).body;
    await agents.it.patch(`/api/company-accounts/${account.id}`).set(headers).send({ version: account.version, note: 'Used for YouPro loads.' }).expect(200);
    const history = await timeline(riley);
    expect(history.entries.filter(entry => entry.category === 'ACCOUNTS').map(entry => [entry.title, entry.by])).toEqual(expect.arrayContaining([
      ['Seat on Lakeside DAT added', 'Taylor Brooks (IT)'], ['Seat on Lakeside DAT suspended', 'Taylor Brooks (IT)'], ['Account at YouPro added: company email', 'Taylor Brooks (IT)'], ['Account at YouPro changed: note', 'Taylor Brooks (IT)']]));
    expect(JSON.stringify(history)).not.toMatch(/@|Used for YouPro/);
  });

  it('keeps a removal scheduled for the last day after Remove access now makes it due today', async () => {
    const riley = await addOne('Riley', 'Santos', { companyEmail: 'riley.santos@example.test' });
    const lastDay = addDays(usDay('latest'), 10);
    await post('manager', `dispatch/members/${riley}/leave`, { version: await version(riley), leftAt: `${lastDay}T12:00:00.000Z`, reason: 'Moving to another company.' });
    await post('manager', `dispatch/members/${riley}/remove-access`, { version: await version(riley), reason: 'Asked to stop working today.' });
    const shown = new Date(`${lastDay}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    expect(await titles(riley)).toEqual(expect.arrayContaining([`IT removal scheduled for ${shown}`]));
    expect(await titles(riley)).not.toContain('IT asked to remove access');
  });

  it('names the last day as it stood when the removal opened, after an earlier change', async () => {
    const riley = await addOne('Riley', 'Santos', { companyEmail: 'riley.santos@example.test' });
    await post('manager', `dispatch/members/${riley}/leave`, { version: await version(riley), leftAt: `${addDays(usDay('latest'), 10)}T12:00:00.000Z`, reason: 'Moving to another company.' });
    const changed = addDays(usDay('latest'), 12);
    await post('manager', `dispatch/members/${riley}/last-day`, { version: await version(riley), lastDay: `${changed}T12:00:00.000Z`, reason: 'Two more days agreed.' });
    // As when a support's first company email opens their removal during the notice: opened after the change.
    await db.query(`UPDATE it_removal_requests SET "createdAt" = now() + interval '1 minute' WHERE "memberId" = $1`, [riley]);
    const shown = new Date(`${changed}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    expect(await titles(riley)).toContain(`IT removal scheduled for ${shown}`);
  });

  it('records a hand-over on everyone it touches, and keeps the whole notice after they leave', async () => {
    const riley = await addOne('Riley', 'Santos', { companyEmail: 'riley.santos@example.test' });
    const drew = await addOne('Drew', 'Calloway'), morgan = await addOne('Morgan', 'Pike');
    for (const id of [drew, morgan]) { const current = await version(id); await agents.manager.patch(`/api/dispatch/members/${id}/existing`).set(headers).send({ version: current, companyEmail: 'riley.santos@example.test', shareCompanyEmail: true }).expect(200); }
    // A notice, a changed last day, then they leave today and hand their email to Drew.
    await post('manager', `dispatch/members/${riley}/leave`, { version: await version(riley), leftAt: `${addDays(usDay('latest'), 10)}T12:00:00.000Z`, reason: 'Moving to another company.' });
    await post('manager', `dispatch/members/${riley}/last-day`, { version: await version(riley), lastDay: `${addDays(usDay('latest'), 12)}T12:00:00.000Z`, reason: 'Two more days agreed.' });
    await post('manager', `dispatch/members/${riley}/cancel-notice`, { version: await version(riley), reason: 'Staying after all.' });
    await post('manager', `dispatch/members/${riley}/leave`, { version: await version(riley), leftAt: usDay('latest'), reason: 'Moved to another company.', handOverTo: drew });
    const rileyTitles = await titles(riley);
    expect(rileyTitles).toEqual(expect.arrayContaining([expect.stringMatching(/^Notice given: last day /), expect.stringMatching(/^Last day changed to /), 'Notice cancelled', 'Left',
      'Their company email handed over to Drew Calloway', 'IT asked to remove access']));
    expect((await timeline(riley)).entries.find(entry => entry.title === 'Left')).toMatchObject({ category: 'AWAY', body: 'Moved to another company.' });
    expect((await timeline(riley)).entries.find(entry => entry.title.startsWith('Last day changed to'))?.by).toBeTruthy();
    // The notice and its removal keep the last day as given, not the one it was changed to.
    const given = rileyTitles.find(title => title.startsWith('Notice given: last day '))!.slice('Notice given: last day '.length);
    expect(rileyTitles).toContain(`IT removal scheduled for ${given}`);
    expect(rileyTitles).not.toContain(`Last day changed to ${given}`);
    // Morgan's use stays on Riley's History from when it began, and reaches Drew's only when Drew became the owner.
    expect(rileyTitles).toEqual(expect.arrayContaining(['Morgan Pike started using their company email']));
    const drewTitles = await titles(drew);
    expect(drewTitles).toEqual(expect.arrayContaining(['Morgan Pike now uses their company email']));
    expect(drewTitles).not.toContain('Morgan Pike started using their company email');
    expect(await titles(drew)).toEqual(expect.arrayContaining(['Now owns Riley Santos’s company email (handed over when Riley Santos left)']));
    expect(await titles(morgan)).toEqual(expect.arrayContaining(['Started using Riley Santos’s company email (shared)', 'Now uses Drew Calloway’s company email, handed over when Riley Santos left']));
    expect(JSON.stringify(await db.query(`SELECT metadata FROM dispatch_events`))).not.toMatch(/@/);
    // The rollback refuses while the new events exist.
    const runner = db.createQueryRunner();
    const { CompleteHistory1793350000000: Migration } = await import('../src/database/migrations/1793350000000-CompleteHistory');
    await expect(new Migration().down(runner)).rejects.toThrow('Refusing to roll back while team lead or shared owner history is recorded.');
    await runner.release();
  });
});
