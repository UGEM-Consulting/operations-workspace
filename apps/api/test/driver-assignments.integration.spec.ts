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
import { DispatchModule } from '../src/modules/dispatch/dispatch.module';
import { addDays, usDay } from '../src/modules/safety/screening-rules';
type Agent = ReturnType<typeof request.agent>;
type Key = 'manager' | 'lead' | 'safety';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Assigning cleared drivers to dispatch (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url');
  const users = {} as Record<Key, User>, agents = {} as Record<Key, Agent>;
  const today = () => usDay('earliest');
  const one = async <T = { id: string }>(sql: string, params: unknown[]) => (await db.query(sql, params))[0] as T;
  const mc = (name: string, mcNumber: string) => one(`INSERT INTO mcs (name, "nameKey", "mcNumber") VALUES ($1::varchar, lower($1::varchar), $2) RETURNING id`, [name, mcNumber]);
  /** A dispatcher record working in a team from February; position and status as given. */
  async function member(first: string, teamId: string | null, mcId: string | null, status = 'ACTIVE', position = 'DISPATCHER') {
    const row = await one(`INSERT INTO dispatch_members ("firstName", "lastName", position, status, "joinedAt") VALUES ($1, 'Fictional', $2, $3, '2026-02-01T12:00:00Z') RETURNING id, version`, [first, position, status]);
    await db.query(`INSERT INTO member_assignments ("memberId", "mcId", "teamId", "startedAt") VALUES ($1, $2, $3, '2026-02-01T12:00:00Z')`, [row.id, mcId, teamId]);
    return row as { id: string; version: number };
  }
  const team = (name: string, mcId: string, leadId: string | null = null) => one(`INSERT INTO teams (name, "nameKey", "mcId", "leadMemberId") VALUES ($1::varchar, lower($1::varchar), $2, $3) RETURNING id`, [name, mcId, leadId]);
  /** A driver Safety cleared two days ago (fictional). */
  const cleared = (first: string, phone: string) => one(`INSERT INTO drivers ("firstName", "lastName", phone, "phoneKey", "driverType", "licenseType", status, "clearedAt", notes)
    VALUES ($1, 'Driver', $2, $2, 'OWNER_OPERATOR', 'CDL_A', 'CLEARED', now() - interval '2 days', 'Safety-only note') RETURNING id, version`, [first, phone]) as Promise<{ id: string; version: number }>;
  const assign = (agent: Agent, path: 'dispatch' | 'team', id: string, body: Record<string, unknown>) => agent.post(`/api/${path}/drivers/${id}/assign`).set(headers).send(body);
  const list = async (agent: Agent, path: 'dispatch' | 'team') => (await agent.get(`/api/${path}/drivers`).set(headers).expect(200)).body;

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600 });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, DispatchModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  // Fixtures: Northwind Freight with the Red team (led by Lee, with Taylor) and the Blue team (Jordan); Lakeside with Casey.
  let northwind: string, lakeside: string, red: string, blue: string, lee: { id: string; version: number }, taylor: { id: string; version: number }, jordan: { id: string; version: number }, casey: { id: string; version: number };
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, member_support_links, promotion_requests, drivers CASCADE');
    northwind = (await mc('Northwind Freight', '698741')).id; lakeside = (await mc('Lakeside Carriers', '812345')).id;
    red = (await team('Red team', northwind)).id; blue = (await team('Blue team', northwind)).id;
    lee = await member('Lee', red, northwind); taylor = await member('Taylor', red, northwind); jordan = await member('Jordan', blue, northwind);
    const lakeTeam = (await team('Lake team', lakeside)).id; casey = await member('Casey', lakeTeam, lakeside);
    await db.query(`UPDATE teams SET "leadMemberId" = $1 WHERE id = $2`, [lee.id, red]);
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['manager', Role.DISPATCHER_MANAGER], ['lead', Role.TEAM_LEAD], ['safety', Role.SAFETY_STAFF]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `assign.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    }
    await db.query(`UPDATE dispatch_members SET "accountUserId" = $1 WHERE id = $2`, [users.lead.id, lee.id]);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE drivers, mcs, job_titles, dispatch_members, teams CASCADE'); await db.query(`DELETE FROM users WHERE email LIKE 'assign.%'`); await db.destroy(); } });

  it('lists cleared drivers for Dispatch with only the name, phone, type, truck and Cleared status', async () => {
    const sam = await cleared('Sam', '5550102600');
    await one(`INSERT INTO drivers ("firstName", "lastName", phone, "phoneKey", "driverType", status) VALUES ('Still', 'Approved', '5550109999', '5550109999', 'COMPANY', 'APPROVED') RETURNING id`, []);
    const body = await list(agents.manager, 'dispatch');
    expect(body.items.map((row: { id: string }) => row.id)).toEqual([sam.id]);
    expect(Object.keys(body.items[0]).sort()).toEqual(['assignment', 'clearedAt', 'clearedBy', 'driverType', 'firstName', 'id', 'lastName', 'licenseType', 'onHold', 'phone', 'version']);
    expect(JSON.stringify(body)).not.toContain('Safety-only note');
    // Options: active dispatchers in open teams, grouped by MC.
    const options = (await agents.manager.get('/api/dispatch/drivers/options').set(headers).expect(200)).body;
    expect(options.mcs.map((row: { name: string; dispatchers: { name: string }[] }) => [row.name, row.dispatchers.map(person => person.name)]))
      .toEqual([['Lakeside Carriers', ['Casey Fictional']], ['Northwind Freight', ['Jordan Fictional', 'Lee Fictional', 'Taylor Fictional']]]);
    await agents.safety.get('/api/dispatch/drivers').set(headers).expect(403);
    await agents.lead.get('/api/dispatch/drivers').set(headers).expect(403);
    expect((await agents.manager.get('/api/auth/me').set(headers).expect(200)).body.navigation.map((item: { key: string }) => item.key)).toContain('dispatchdrivers');
    expect((await agents.lead.get('/api/auth/me').set(headers).expect(200)).body.navigation.map((item: { key: string }) => item.key)).toEqual(['myteam', 'teamdrivers', 'security']);
  });

  it('assigns a cleared driver to an MC and a dispatcher in a team under it, keeping changes as history', async () => {
    const sam = await cleared('Sam', '5550102600');
    // The dispatcher must work in a team under the chosen MC, be active and a dispatcher.
    await assign(agents.manager, 'dispatch', sam.id, { version: sam.version, mcId: lakeside, memberId: taylor.id, startsOn: today() }).expect(400);
    const onboarding = await member('Robin', red, northwind, 'ONBOARDING');
    await assign(agents.manager, 'dispatch', sam.id, { version: sam.version, mcId: northwind, memberId: onboarding.id, startsOn: today() }).expect(400);
    const support = await member('Support', red, northwind, 'ACTIVE', 'SUPPORT');
    await assign(agents.manager, 'dispatch', sam.id, { version: sam.version, mcId: northwind, memberId: support.id, startsOn: today() }).expect(400);
    // Not before Safety cleared the driver (allowing the same day), and the version must be current.
    await assign(agents.manager, 'dispatch', sam.id, { version: sam.version, mcId: northwind, memberId: taylor.id, startsOn: '2026-01-02' }).expect(400);
    await assign(agents.manager, 'dispatch', sam.id, { version: sam.version + 1, mcId: northwind, memberId: taylor.id, startsOn: today() }).expect(409);
    const first = (await assign(agents.manager, 'dispatch', sam.id, { version: sam.version, mcId: northwind, memberId: taylor.id, startsOn: today(), truck: '233' }).expect(201)).body;
    let body = await list(agents.manager, 'dispatch');
    expect(body.items[0].assignment).toMatchObject({ mc: 'Northwind Freight', dispatcher: 'Taylor Fictional', team: 'Red team', truck: '233' });
    // A change needs a reason and something different; the earlier assignment ends and stays.
    await assign(agents.manager, 'dispatch', sam.id, { version: first.version, mcId: northwind, memberId: taylor.id, startsOn: today(), truck: '233', reason: 'Same' }).expect(400);
    await assign(agents.manager, 'dispatch', sam.id, { version: first.version, mcId: lakeside, memberId: casey.id, startsOn: today() }).expect(400);
    await assign(agents.manager, 'dispatch', sam.id, { version: first.version, mcId: lakeside, memberId: casey.id, startsOn: today(), reason: 'Moving to Lakeside lanes' }).expect(201);
    body = await list(agents.manager, 'dispatch');
    expect(body.items[0].assignment).toMatchObject({ mc: 'Lakeside Carriers', dispatcher: 'Casey Fictional', truck: null });
    const history = await db.query(`SELECT "memberId", "endedAt" IS NULL AS open, reason FROM driver_assignments WHERE "driverId" = $1 ORDER BY "createdAt"`, [sam.id]);
    expect(history).toEqual([{ memberId: taylor.id, open: false, reason: null }, { memberId: casey.id, open: true, reason: 'Moving to Lakeside lanes' }]);
    expect((await db.query(`SELECT event, metadata FROM driver_events WHERE "driverId" = $1 ORDER BY "createdAt"`, [sam.id])).map((row: { metadata: unknown }) => row.metadata))
      .toEqual([{ first: true, truck: true }, { first: false, truck: false }]);
    // Only cleared drivers.
    const approved = await one<{ id: string }>(`INSERT INTO drivers ("firstName", "lastName", phone, "phoneKey", "driverType", status) VALUES ('Not', 'Cleared', '5550108888', '5550108888', 'COMPANY', 'APPROVED') RETURNING id`, []);
    await assign(agents.manager, 'dispatch', approved.id, { version: 1, mcId: northwind, memberId: taylor.id, startsOn: today() }).expect(409);
  });

  it('assigns drivers to an independent dispatcher (an MC with no team), but never to someone with no MC or to a team lead outside their team', async () => {
    const indy = await member('Indy', null, northwind), nomc = await member('Nomc', null, null);
    const sam = await cleared('Sam', '5550102600');
    const options = (await agents.manager.get('/api/dispatch/drivers/options').set(headers).expect(200)).body.mcs;
    expect(options.find((row: { name: string }) => row.name === 'Northwind Freight').dispatchers).toContainEqual({ id: indy.id, name: 'Indy Fictional', teamId: null, team: null });
    expect(JSON.stringify(options)).not.toContain(nomc.id);
    // Independent under Northwind, so not under Lakeside; a team lead can't reach them.
    await assign(agents.manager, 'dispatch', sam.id, { version: sam.version, mcId: lakeside, memberId: indy.id, startsOn: today() }).expect(400);
    await assign(agents.manager, 'dispatch', sam.id, { version: sam.version, mcId: northwind, memberId: nomc.id, startsOn: today() }).expect(400);
    await assign(agents.lead, 'team', sam.id, { version: sam.version, mcId: northwind, memberId: indy.id, startsOn: today() }).expect(400);
    await assign(agents.manager, 'dispatch', sam.id, { version: sam.version, mcId: northwind, memberId: indy.id, startsOn: today() }).expect(201);
    expect((await list(agents.manager, 'dispatch')).items[0].assignment).toMatchObject({ mc: 'Northwind Freight', dispatcher: 'Indy Fictional', team: null });
  });

  it('refuses to assign a driver Safety put on hold, without saying why, until Safety lifts it', async () => {
    const sam = await cleared('Sam', '5550102600');
    const first = (await assign(agents.manager, 'dispatch', sam.id, { version: sam.version, mcId: northwind, memberId: taylor.id, startsOn: today() }).expect(201)).body;
    const recordTest = (result: string, daysAgo: number) => db.query(`INSERT INTO driver_tests ("driverId", kind, reason, "testedOn", result) VALUES ($1, 'DRUG', 'RANDOM', current_date - $2::int, $3)`, [sam.id, daysAgo, result]);
    // A refused test puts the driver on hold: Dispatch sees only that. Their dispatcher can still hand them over.
    await recordTest('REFUSED', 1);
    const row = (await list(agents.manager, 'dispatch')).items[0];
    expect(row).toMatchObject({ onHold: true, assignment: { dispatcher: 'Taylor Fictional' } });
    expect(JSON.stringify(row)).not.toMatch(/REFUSED|DRUG/);
    const handed = (await assign(agents.manager, 'dispatch', sam.id, { version: first.version, mcId: northwind, memberId: jordan.id, startsOn: today(), reason: 'Swap' }).expect(201)).body;
    expect(handed.version).toBe(first.version + 1);
    await assign(agents.manager, 'dispatch', sam.id, { version: handed.version, mcId: northwind, memberId: taylor.id, startsOn: today(), reason: 'Back' }).expect(201);
    // A later negative test lifts it; a Not qualified yearly review puts them back on hold, for team leads too.
    await recordTest('NEGATIVE', 0);
    expect((await list(agents.manager, 'dispatch')).items[0].onHold).toBe(false);
    await db.query(`INSERT INTO driver_annual_reviews ("driverId", "reviewedOn", outcome, note) VALUES ($1, current_date, 'NOT_QUALIFIED', 'Fictional')`, [sam.id]);
    expect((await list(agents.lead, 'team')).items.find((item: { id: string }) => item.id === sam.id).onHold).toBe(true);
    // An expired license or medical card holds them too, until a newer checked one is on file: a new scan nobody has
    // checked yet lifts nothing.
    await db.query(`INSERT INTO driver_annual_reviews ("driverId", "reviewedOn", outcome) VALUES ($1, current_date, 'QUALIFIED')`, [sam.id]);
    expect((await list(agents.manager, 'dispatch')).items[0].onHold).toBe(false);
    const scan = (expiresOn: string | null, checked: boolean) => db.query(`INSERT INTO driver_documents (id, "driverId", kind, "pageCount", sha256, "byteSize", "expiresOn", "createdAt", "verifiedAt")
      VALUES (gen_random_uuid(), $1, 'MEDICAL_CARD', 1, repeat('a', 64), 10, $2, clock_timestamp(), CASE WHEN $3::boolean THEN now() END) RETURNING id`, [sam.id, expiresOn, checked]);
    const [old] = await scan(addDays(usDay('earliest'), -2), true);
    expect((await list(agents.manager, 'dispatch')).items[0].onHold).toBe(true);
    await db.query(`UPDATE driver_documents SET "replacedAt" = now() WHERE id = $1`, [old.id]);
    const [unchecked] = await scan(null, false);
    expect((await list(agents.manager, 'dispatch')).items[0].onHold).toBe(true);
    await db.query(`UPDATE driver_documents SET "expiresOn" = $2, "verifiedAt" = now() WHERE id = $1`, [unchecked.id, addDays(usDay('latest'), 300)]);
    expect((await list(agents.manager, 'dispatch')).items[0].onHold).toBe(false);
    // Nobody new takes on a driver who is on hold.
    const held = await cleared('Held', '5550102601') as { id: string; version: number };
    await db.query(`INSERT INTO driver_tests ("driverId", kind, reason, "testedOn", result) VALUES ($1, 'ALCOHOL', 'RANDOM', current_date, 'NOT_NEGATIVE')`, [held.id]);
    expect((await assign(agents.manager, 'dispatch', held.id, { version: held.version, mcId: northwind, memberId: taylor.id, startsOn: today() }).expect(409)).body.message).toMatch(/on hold/);
  });

  it('keeps a dispatcher with drivers from leaving or moving to another MC until their drivers are reassigned', async () => {
    const sam = await cleared('Sam', '5550102600');
    await assign(agents.manager, 'dispatch', sam.id, { version: sam.version, mcId: northwind, memberId: jordan.id, startsOn: today() }).expect(201);
    expect((await agents.manager.post(`/api/dispatch/members/${jordan.id}/leave`).set(headers).send({ version: jordan.version, leftAt: today(), reason: 'Left' }).expect(409)).body.message).toMatch(/still has drivers/);
    expect((await agents.manager.post(`/api/dispatch/members/${jordan.id}/move`).set(headers).send({ version: jordan.version, mcId: lakeside, startedAt: today(), reason: 'Lakeside' }).expect(409)).body.message).toMatch(/Reassign their drivers first/);
    // Another team under the same MC is fine: the driver stays with them.
    await agents.manager.post(`/api/dispatch/members/${jordan.id}/move`).set(headers).send({ version: jordan.version, mcId: northwind, teamId: red, startedAt: today(), reason: 'Red team' }).expect(201);
    expect((await list(agents.manager, 'dispatch')).items[0].assignment).toMatchObject({ dispatcher: 'Jordan Fictional', team: 'Red team' });
  });

  it('lets a driver stay on an MC archived since they were placed, and places nobody new there', async () => {
    const sam = await cleared('Sam', '5550102600'), alex = await cleared('Alex', '5550102700');
    const options = async () => (await agents.manager.get('/api/dispatch/drivers/options').set(headers).expect(200)).body.mcs.map((row: { name: string; archived: boolean }) => [row.name, row.archived]);
    const placed = (await assign(agents.manager, 'dispatch', sam.id, { version: sam.version, mcId: northwind, memberId: taylor.id, startsOn: today() }).expect(201)).body;
    await db.query(`UPDATE mcs SET "archivedAt" = now() WHERE id = $1`, [northwind]);
    expect(await options()).toEqual([['Lakeside Carriers', false], ['Northwind Freight', true]]);
    await assign(agents.manager, 'dispatch', alex.id, { version: alex.version, mcId: northwind, memberId: taylor.id, startsOn: today() }).expect(400);
    const changed = (await assign(agents.manager, 'dispatch', sam.id, { version: placed.version, mcId: northwind, memberId: taylor.id, startsOn: today(), truck: '233', reason: 'New truck' }).expect(201)).body;
    // Once the driver moves away, the MC is out of the options and they can't go back.
    const moved = (await assign(agents.manager, 'dispatch', sam.id, { version: changed.version, mcId: lakeside, memberId: casey.id, startsOn: today(), reason: 'MC closed' }).expect(201)).body;
    expect(await options()).toEqual([['Lakeside Carriers', false]]);
    await assign(agents.manager, 'dispatch', sam.id, { version: moved.version, mcId: northwind, memberId: taylor.id, startsOn: today(), reason: 'Back' }).expect(400);
  });

  it('lets a team lead assign only to dispatchers in their own team, and change only drivers working with it', async () => {
    const sam = await cleared('Sam', '5550102600'), alex = await cleared('Alex', '5550102700');
    // Their options are their team only; they see every driver waiting and the ones in their team.
    const options = (await agents.lead.get('/api/team/drivers/options').set(headers).expect(200)).body;
    expect(options.mcs.map((row: { name: string; dispatchers: { name: string }[] }) => [row.name, row.dispatchers.map(person => person.name)])).toEqual([['Northwind Freight', ['Lee Fictional', 'Taylor Fictional']]]);
    expect((await assign(agents.lead, 'team', sam.id, { version: sam.version, mcId: northwind, memberId: jordan.id, startsOn: today() }).expect(400)).body.message).toBe('Choose an active dispatcher in your team.');
    await assign(agents.lead, 'team', sam.id, { version: sam.version, mcId: northwind, memberId: taylor.id, startsOn: today() }).expect(201);
    // A driver a manager placed with another team is out of reach and out of their list.
    const placed = (await assign(agents.manager, 'dispatch', alex.id, { version: alex.version, mcId: northwind, memberId: jordan.id, startsOn: today() }).expect(201)).body;
    expect((await assign(agents.lead, 'team', alex.id, { version: placed.version, mcId: northwind, memberId: taylor.id, startsOn: today(), reason: 'Mine now' }).expect(404)).body.message).toBe('This driver works with another team.');
    expect((await list(agents.lead, 'team')).items.map((row: { firstName: string }) => row.firstName)).toEqual(['Sam']);
    await agents.manager.get('/api/team/drivers').set(headers).expect(403);
    // Once their record no longer leads a team, the routes refuse.
    await db.query(`UPDATE teams SET "leadMemberId" = NULL WHERE id = $1`, [red]);
    await agents.lead.get('/api/team/drivers').set(headers).expect(403);
    await assign(agents.lead, 'team', alex.id, { version: placed.version, mcId: northwind, memberId: taylor.id, startsOn: today(), reason: 'x' }).expect(403);
  });
});
