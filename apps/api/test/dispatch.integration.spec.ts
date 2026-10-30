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
import { ListsModule } from '../src/modules/lists/lists.module';
import { DispatchModule } from '../src/modules/dispatch/dispatch.module';
import { activateMember, createMemberForApproval, createSupportForApproval } from '../src/modules/dispatch/create-member';
import { DispatcherApplication } from '../src/modules/onboarding/entities';
type Agent = ReturnType<typeof request.agent>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Teams and dispatch members (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url');
  const users: Record<'manager' | 'it', User> = {} as never, agents: Record<'manager' | 'it', Agent> = {} as never;
  const latest = async () => (await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name as string;
  // An approved application with a submitted revision and the manager-confirmed assignment text.
  async function approved(names: [string, string], employment: { mcName: string; teamLead: string; jobTitle: string }, status = 'APPROVED') {
    const [inv] = await db.query(`INSERT INTO invitations ("managerId","tokenHash","mcName","teamLead","jobTitle","expiresAt","telegramRequired") VALUES ($1,$2,$3,$4,$5,now()+interval '7 days',false) RETURNING id`,
      [users.manager.id, randomBytes(32).toString('hex'), employment.mcName, employment.teamLead, employment.jobTitle]);
    const fields = { firstName: 'Legal', lastName: 'Name', preferredAmericanFirstName: names[0], preferredAmericanLastName: names[1] };
    const [app] = await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"applicantAccessUntil","submittedAt") VALUES ($1,$2,$3,$4,3,now()+interval '7 days',now()) RETURNING id`, [inv.id, users.manager.id, status, fields]);
    await db.query(`INSERT INTO application_submissions ("applicationId",version,fields) VALUES ($1,2,$2)`, [app.id, fields]);
    return app.id as string;
  }
  const mc = async (name: string) => (await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ($1::varchar,lower($1::varchar)) RETURNING id`, [name]))[0].id as string;
  const members = async () => (await agents.manager.get('/api/dispatch/members').set(headers).expect(200)).body.items as { id: string; firstName: string; lastName: string; mc: string | null; teamId: string | null; team: string | null; lead: boolean; version: number; jobTitle: string | null; status: string; position: string; dispatcher: string | null }[];
  const byName = async (first: string) => (await members()).find(item => item.firstName === first)!;

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600 });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, ListsModule, DispatchModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, list_events, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, member_support_links CASCADE');
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: 'Staff', email: `dispatch.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    }
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, job_titles, dispatch_events CASCADE'); await db.destroy(); } });

  it('turns approved applications into members, teams per MC and team lead, and finds the lead by name', async () => {
    await db.query('TRUNCATE dispatch_events, member_contacts, member_support_links'); await db.query(`TRUNCATE drivers CASCADE; TRUNCATE driver_sessions, driver_challenges`); await db.undoLastMigration(); await db.query(`TRUNCATE drivers CASCADE; TRUNCATE driver_sessions, driver_challenges`); await db.undoLastMigration(); await db.query(`TRUNCATE drivers CASCADE; DELETE FROM users WHERE role::text LIKE 'SAFETY_%'`); await db.undoLastMigration(); await db.query(`UPDATE dispatch_members SET "accountUserId" = NULL; TRUNCATE promotion_requests; DELETE FROM dispatch_events WHERE event LIKE 'PROMOTION_%'; DELETE FROM users WHERE role::text = 'TEAM_LEAD'`); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); expect(await latest()).toBe('ManagedLists1792810000000');
    try { await backfilled(); } finally { await db.runMigrations(); }
  });
  async function backfilled() {
    const northwind = await mc('Northwind Freight'); await mc('Lakeside Carriers');
    await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Dispatcher','dispatcher')`);
    await approved(['Lee', 'Lead'], { mcName: 'Northwind Freight', teamLead: 'Lee Lead', jobTitle: 'Dispatcher' });
    await approved(['Sam', 'Rivera'], { mcName: 'northwind  freight', teamLead: ' lee LEAD ', jobTitle: 'dispatcher' });
    await approved(['Casey', 'Morgan'], { mcName: 'Lakeside Carriers', teamLead: 'Lee Lead', jobTitle: 'Senior dispatcher' });
    await approved(['Indy', 'Pendent'], { mcName: 'Independent', teamLead: 'Independent', jobTitle: 'Dispatcher' });
    await approved(['Not', 'Approved'], { mcName: 'Northwind Freight', teamLead: 'Lee Lead', jobTitle: 'Dispatcher' }, 'SUBMITTED');
    await db.runMigrations(); expect(await latest()).toBe('DriverDocuments1792880000000');

    const list = await members();
    expect(list.map(item => [`${item.firstName} ${item.lastName}`, item.mc, item.team, item.lead, item.jobTitle])).toEqual([
      ['Casey Morgan', 'Lakeside Carriers', 'Lee Lead team (Lakeside Carriers)', false, null],
      ['Indy Pendent', null, null, false, 'Dispatcher'],
      ['Lee Lead', 'Northwind Freight', 'Lee Lead team (Northwind Freight)', true, 'Dispatcher'],
      ['Sam Rivera', 'Northwind Freight', 'Lee Lead team (Northwind Freight)', false, 'Dispatcher']]);
    const teams = (await agents.manager.get('/api/dispatch/teams').set(headers).expect(200)).body;
    expect(teams.items.map((team: { name: string; mc: { id: string }; lead: { name: string } | null; members: number }) => [team.name, team.mc.id === northwind, team.lead?.name ?? null, team.members]))
      .toEqual([['Lee Lead team (Lakeside Carriers)', false, null, 1], ['Lee Lead team (Northwind Freight)', true, 'Lee Lead', 2]]);
    // Automatic rows write no events, so the backfill can still be rolled back and rebuilt.
    expect(await db.query('SELECT count(*)::integer AS n FROM dispatch_events')).toEqual([{ n: 0 }]);
  }
  it('keeps the schema after the backfill test', async () => { expect(await latest()).toBe('DriverDocuments1792880000000'); });

  it('places a newly approved dispatcher by the confirmed assignment, inside the approval transaction', async () => {
    const northwind = await mc('Northwind Freight');
    const team = (await agents.manager.post('/api/dispatch/teams').set(headers).send({ name: 'Avery Lead team', mcId: northwind }).expect(201)).body;
    const id = await approved(['Jordan', 'Fictional'], { mcName: 'Northwind Freight', teamLead: 'Avery Lead', jobTitle: 'Unlisted title' });
    const application = await db.getRepository(DispatcherApplication).findOneByOrFail({ id });
    await db.transaction(em => createMemberForApproval(em, application, { preferredAmericanFirstName: 'Jordan', preferredAmericanLastName: 'Fictional', firstName: 'Legal' },
      { mcName: 'NORTHWIND freight', teamLead: 'avery lead', jobTitle: 'Unlisted title' }, new Date('2026-10-20T15:00:00Z')));
    const member = await byName('Jordan');
    expect(member).toMatchObject({ lastName: 'Fictional', mc: 'Northwind Freight', team: 'Avery Lead team', jobTitle: null, lead: false });
    expect((await agents.manager.get(`/api/dispatch/members/${member.id}`).set(headers).expect(200)).body).toMatchObject({ applicationId: id, current: { teamId: team.id, reason: 'Joined after onboarding was approved.' } });
    await expect(db.transaction(em => createMemberForApproval(em, application, {}, { mcName: '', teamLead: '', jobTitle: '' }, new Date()))).rejects.toThrow();
    // A team the backfill named with its MC ("Quinn Lead team (Northwind Freight)") still matches the team lead text.
    const suffixed = (await agents.manager.post('/api/dispatch/teams').set(headers).send({ name: 'Quinn Lead team (Northwind Freight)', mcId: northwind }).expect(201)).body;
    const second = await approved(['Robin', 'Fictional'], { mcName: 'Northwind Freight', teamLead: 'Quinn Lead', jobTitle: 'Dispatcher' });
    await db.transaction(async em => createMemberForApproval(em, await em.getRepository(DispatcherApplication).findOneByOrFail({ id: second }), { preferredAmericanFirstName: 'Robin', preferredAmericanLastName: 'Fictional' },
      { mcName: 'Northwind Freight', teamLead: 'Quinn Lead', jobTitle: 'Dispatcher' }, new Date('2026-10-21T15:00:00Z')));
    expect((await byName('Robin')).teamId).toBe(suffixed.id);
  });

  it('moves dispatchers between MCs and teams as history, keeps team leads inside their team and records changes without values', async () => {
    const northwind = await mc('Northwind Freight'), lakeside = await mc('Lakeside Carriers');
    const red = (await agents.manager.post('/api/dispatch/teams').set(headers).send({ name: 'Red team', mcId: northwind }).expect(201)).body;
    const blue = (await agents.manager.post('/api/dispatch/teams').set(headers).send({ name: 'Blue team', mcId: lakeside }).expect(201)).body;
    expect((await agents.manager.post('/api/dispatch/teams').set(headers).send({ name: 'RED  TEAM', mcId: lakeside }).expect(409)).body.message).toBe('A team with this name already exists.');
    const app = await approved(['Taylor', 'Brooks'], { mcName: 'Independent', teamLead: 'Independent', jobTitle: 'Dispatcher' });
    const application = await db.getRepository(DispatcherApplication).findOneByOrFail({ id: app });
    await db.transaction(em => createMemberForApproval(em, application, { preferredAmericanFirstName: 'Taylor', preferredAmericanLastName: 'Brooks' }, { mcName: 'Independent', teamLead: 'Independent', jobTitle: 'Dispatcher' }, new Date('2026-01-05T12:00:00Z')));
    // Onboarding until IT completes setup; only then can they lead a team.
    expect(await byName('Taylor')).toMatchObject({ status: 'ONBOARDING' });
    await db.transaction(em => activateMember(em, app));
    let taylor = await byName('Taylor');

    // A lead must be a dispatcher in the team.
    await agents.manager.patch(`/api/dispatch/teams/${red.id}`).set(headers).send({ version: 1, leadMemberId: taylor.id }).expect(400);
    await agents.manager.post(`/api/dispatch/members/${taylor.id}/move`).set(headers).send({ version: 2, mcId: northwind, teamId: blue.id, startedAt: '2026-02-01', reason: 'Joined a team' }).expect(400);
    await agents.manager.post(`/api/dispatch/members/${taylor.id}/move`).set(headers).send({ version: 2, mcId: northwind, teamId: red.id, startedAt: '2025-12-01', reason: 'Too early' }).expect(400);
    await agents.manager.post(`/api/dispatch/members/${taylor.id}/move`).set(headers).send({ version: 2, mcId: northwind, teamId: red.id, startedAt: '2099-01-01', reason: 'Future' }).expect(400);
    await agents.manager.post(`/api/dispatch/members/${taylor.id}/move`).set(headers).send({ version: 2, mcId: northwind, teamId: red.id, startedAt: '2026-02-01', reason: 'Joined a team' }).expect(201);
    await agents.manager.post(`/api/dispatch/members/${taylor.id}/move`).set(headers).send({ version: 1, mcId: lakeside, teamId: blue.id, startedAt: '2026-03-01', reason: 'Stale' }).expect(409);
    await agents.manager.patch(`/api/dispatch/teams/${red.id}`).set(headers).send({ version: 1, leadMemberId: taylor.id }).expect(200);
    taylor = await byName('Taylor');
    expect(taylor).toMatchObject({ team: 'Red team', lead: true, version: 3 });
    // A team with dispatchers keeps its MC and can't be archived.
    expect((await agents.manager.patch(`/api/dispatch/teams/${red.id}`).set(headers).send({ version: 2, archived: true }).expect(409)).body.message).toMatch(/no dispatchers/);
    await agents.manager.patch(`/api/dispatch/teams/${red.id}`).set(headers).send({ version: 2, mcId: lakeside }).expect(409);

    // Moving to another MC ends the lead role and keeps the earlier rows.
    await agents.manager.post(`/api/dispatch/members/${taylor.id}/move`).set(headers).send({ version: 3, mcId: lakeside, teamId: blue.id, startedAt: '2026-06-01', reason: 'Lakeside needed more dispatchers' }).expect(201);
    const profile = (await agents.manager.get(`/api/dispatch/members/${taylor.id}`).set(headers).expect(200)).body;
    expect(profile.history.map((row: { mc: string | null; team: string | null; endedAt: string | null; reason: string; movedBy: string | null }) => [row.mc, row.team, row.endedAt?.slice(0, 10) ?? null, row.reason, row.movedBy])).toEqual([
      ['Lakeside Carriers', 'Blue team', null, 'Lakeside needed more dispatchers', 'Fictional Staff'],
      ['Northwind Freight', 'Red team', '2026-06-01', 'Joined a team', 'Fictional Staff'],
      [null, null, '2026-02-01', 'Joined after onboarding was approved.', null]]);
    expect(profile.leadOf).toBeNull();
    expect((await agents.manager.get('/api/dispatch/teams').set(headers).expect(200)).body.items.find((team: { id: string }) => team.id === red.id)).toMatchObject({ lead: null, members: 0, version: 3 });
    await agents.manager.patch(`/api/dispatch/teams/${red.id}`).set(headers).send({ version: 3, archived: true }).expect(200);

    // Leaving closes the assignment; the record stays and can't be moved again.
    await agents.manager.post(`/api/dispatch/members/${taylor.id}/leave`).set(headers).send({ version: 4, leftAt: '2026-09-30', reason: 'Resigned' }).expect(201);
    expect((await agents.manager.get('/api/dispatch/members?status=LEFT').set(headers).expect(200)).body).toMatchObject({ items: [{ id: taylor.id, status: 'LEFT' }], counts: { active: 0, left: 1 } });
    await agents.manager.post(`/api/dispatch/members/${taylor.id}/move`).set(headers).send({ version: 5, mcId: null, startedAt: '2026-10-01', reason: 'Back' }).expect(409);

    const events = await db.query(`SELECT event, metadata FROM dispatch_events ORDER BY "createdAt", event`);
    expect(events.map((row: { event: string }) => row.event)).toEqual(['TEAM_CREATED', 'TEAM_CREATED', 'MEMBER_MOVED', 'TEAM_UPDATED', 'MEMBER_MOVED', 'TEAM_ARCHIVED', 'MEMBER_LEFT']);
    expect(JSON.stringify(events)).not.toMatch(/Taylor|Brooks|Resigned|Lakeside|Red team/);
  });

  it('shows every manager the approved application details, and keeps added emails and phone numbers with who added and removed them', async () => {
    const id = await approved(['Jordan', 'Fictional'], { mcName: 'Independent', teamLead: 'Independent', jobTitle: 'Dispatcher' });
    await db.query(`UPDATE invitations SET email = 'jordan.personal@example.test' WHERE id = (SELECT "invitationId" FROM dispatcher_applications WHERE id = $1)`, [id]);
    await db.query(`UPDATE application_submissions SET fields = fields || '{"personalPhoneNumber":"+1 202 555 0147","telegram":"jordan_fictional"}'::jsonb WHERE "applicationId" = $1`, [id]);
    const application = await db.getRepository(DispatcherApplication).findOneByOrFail({ id });
    await db.transaction(em => createMemberForApproval(em, application, { preferredAmericanFirstName: 'Jordan', preferredAmericanLastName: 'Fictional' }, { mcName: 'Independent', teamLead: 'Independent', jobTitle: 'Dispatcher' }, new Date()));
    const member = await byName('Jordan');
    const detail = (await agents.manager.get(`/api/dispatch/members/${member.id}`).set(headers).expect(200)).body;
    expect(detail).toMatchObject({ status: 'ONBOARDING', canOpenApplication: true, photo: false, documents: [], contacts: [], accounts: null,
      details: { legalFirstName: 'Legal', legalLastName: 'Name', preferredAmericanFirstName: 'Jordan', personalEmail: 'jordan.personal@example.test', personalPhoneNumber: '+1 202 555 0147', telegram: 'jordan_fictional' } });

    const add = (body: Record<string, unknown>) => agents.manager.post(`/api/dispatch/members/${member.id}/contacts`).set(headers).send(body);
    await add({ kind: 'EMAIL', value: 'Jordan.Second@Example.test', label: 'Second email' }).expect(201);
    expect((await add({ kind: 'EMAIL', value: 'jordan.second@example.test' }).expect(409)).body.message).toBe('This email is already on the record.');
    await add({ kind: 'EMAIL', value: 'not-an-email' }).expect(400);
    await add({ kind: 'PHONE', value: '12' }).expect(400);
    const phone = (await add({ kind: 'PHONE', value: '+1 (469) 555-0181', label: 'Home' }).expect(201)).body;
    await agents.it.post(`/api/dispatch/members/${member.id}/contacts`).set(headers).send({ kind: 'PHONE', value: '+1 469 555 0182' }).expect(403);
    expect((await agents.manager.get(`/api/dispatch/members/${member.id}`).set(headers).expect(200)).body.contacts.map((contact: { kind: string; value: string; label: string | null; addedBy: string }) => [contact.kind, contact.value, contact.label, contact.addedBy]))
      .toEqual([['EMAIL', 'jordan.second@example.test', 'Second email', 'Fictional Staff'], ['PHONE', '+1 (469) 555-0181', 'Home', 'Fictional Staff']]);
    await agents.manager.post(`/api/dispatch/members/${member.id}/contacts/${phone.id}/remove`).set(headers).send({}).expect(201);
    await agents.manager.post(`/api/dispatch/members/${member.id}/contacts/${phone.id}/remove`).set(headers).send({}).expect(404);
    expect((await agents.manager.get(`/api/dispatch/members/${member.id}`).set(headers).expect(200)).body.contacts).toHaveLength(1);
    // The removed number is kept with who removed it; events record the kind of contact, never its value.
    expect(await db.query('SELECT "removedBy" FROM member_contacts WHERE id = $1', [phone.id])).toEqual([{ removedBy: users.manager.id }]);
    const events = await db.query(`SELECT event, metadata FROM dispatch_events WHERE "memberId" = $1 ORDER BY "createdAt"`, [member.id]);
    expect(events.map((row: { event: string }) => row.event)).toEqual(['CONTACT_ADDED', 'CONTACT_ADDED', 'CONTACT_REMOVED']);
    expect(JSON.stringify(events)).not.toMatch(/jordan|469|Home/i);
  });

  it('keeps a support with one dispatcher at a time: changes are history, Move is refused, leaving ends the link', async () => {
    const northwind = await mc('Northwind Freight');
    const red = (await agents.manager.post('/api/dispatch/teams').set(headers).send({ name: 'Red team', mcId: northwind }).expect(201)).body;
    const make = async (first: string, kind: 'DISPATCHER' | 'SUPPORT', dispatcherId?: string) => {
      const app = await approved([first, 'Fictional'], { mcName: 'Northwind Freight', teamLead: 'Red team', jobTitle: 'Dispatcher' });
      const application = await db.getRepository(DispatcherApplication).findOneByOrFail({ id: app });
      const fields = { preferredAmericanFirstName: first, preferredAmericanLastName: 'Fictional' };
      await db.transaction(async em => { if (kind === 'SUPPORT') await createSupportForApproval(em, application, fields, dispatcherId!, new Date('2026-03-01T20:00:00Z')); else await createMemberForApproval(em, application, fields, { mcName: 'Northwind Freight', teamLead: 'Red team', jobTitle: 'Dispatcher' }, new Date('2026-02-01T12:00:00Z')); });
      return byName(first);
    };
    const avery = await make('Avery', 'DISPATCHER'), blake = await make('Blake', 'DISPATCHER');
    const sky = await make('Sky', 'SUPPORT', avery.id);
    // The database keeps microseconds (an approval's time); a same-day change must still end after it started.
    await db.query("UPDATE member_support_links SET \"startedAt\" = '2026-03-01 20:00:00.000400+00' WHERE \"supportId\" = $1", [sky.id]);
    // A support works where their dispatcher works.
    expect(await byName('Sky')).toMatchObject({ position: 'SUPPORT', status: 'ACTIVE', mc: 'Northwind Freight', team: 'Red team', teamId: red.id, dispatcher: 'Avery Fictional' });
    expect((await agents.manager.get(`/api/dispatch/members/${avery.id}`).set(headers).expect(200)).body.supports.map((row: { name: string }) => row.name)).toEqual(['Sky Fictional']);
    await agents.manager.post(`/api/dispatch/members/${sky.id}/move`).set(headers).send({ version: 1, mcId: null, startedAt: '2026-04-01', reason: 'Try' }).expect(400);
    await agents.manager.post(`/api/dispatch/members/${sky.id}/reassign`).set(headers).send({ version: 1, dispatcherId: avery.id, startedAt: '2026-04-01', reason: 'Same' }).expect(400);
    await agents.manager.post(`/api/dispatch/members/${sky.id}/reassign`).set(headers).send({ version: 1, dispatcherId: sky.id, startedAt: '2026-04-01', reason: 'Self' }).expect(400);
    await agents.manager.post(`/api/dispatch/members/${avery.id}/reassign`).set(headers).send({ version: 1, dispatcherId: blake.id, startedAt: '2026-04-01', reason: 'Not a support' }).expect(400);
    await agents.manager.post(`/api/dispatch/members/${sky.id}/reassign`).set(headers).send({ version: 1, dispatcherId: blake.id, startedAt: '2026-03-01', reason: 'Blake needs help' }).expect(201);
    // Changed the same day the support started: the new link starts when the old one did, not earlier.
    const profile = (await agents.manager.get(`/api/dispatch/members/${sky.id}`).set(headers).expect(200)).body;
    expect(profile.supportOf.startedAt).toBe('2026-03-01T20:00:00.001Z');
    expect(profile.supportOf).toMatchObject({ dispatcherId: blake.id, dispatcher: 'Blake Fictional', team: 'Red team' });
    expect(profile.supportHistory.map((row: { dispatcher: string; endedAt: string | null; changedBy: string | null }) => [row.dispatcher, row.endedAt?.slice(0, 10) ?? null, row.changedBy]))
      .toEqual([['Blake Fictional', null, 'Fictional Staff'], ['Avery Fictional', '2026-03-01', null]]);
    await agents.manager.post(`/api/dispatch/members/${sky.id}/leave`).set(headers).send({ version: 2, leftAt: '2026-05-01', reason: 'Resigned' }).expect(201);
    expect(await db.query('SELECT count(*)::integer AS n FROM member_support_links WHERE "supportId" = $1 AND "endedAt" IS NULL', [sky.id])).toEqual([{ n: 0 }]);
    expect((await agents.manager.get(`/api/dispatch/members/${blake.id}`).set(headers).expect(200)).body.supports).toEqual([]);
  });

  it('keeps teams and dispatchers to dispatcher managers and administrators, and refuses to roll back after changes', async () => {
    await agents.it.get('/api/dispatch/members').set(headers).expect(403);
    await agents.it.get('/api/dispatch/teams').set(headers).expect(403);
    await agents.manager.post('/api/dispatch/teams').set(headers).send({ name: 'Orphan', mcId: '00000000-0000-4000-8000-000000000000' }).expect(400);
    await agents.manager.post('/api/dispatch/teams').set(headers).send({ name: 'Kept team', mcId: await mc('Kept Carrier') }).expect(201);
    await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration(); await db.undoLastMigration();
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard dispatch team changes');
    expect(await latest()).toBe('DispatchTeams1792820000000');
    await db.runMigrations();
  });
});
