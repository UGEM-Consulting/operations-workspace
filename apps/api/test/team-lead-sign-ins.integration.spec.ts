import { addDays, usDay } from '../src/modules/safety/screening-rules';
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
import { ItModule } from '../src/modules/it/it.module';
import { DispatchModule } from '../src/modules/dispatch/dispatch.module';
import { completeMfa, enrolForTest } from './mfa-helpers';
type Agent = ReturnType<typeof request.agent>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Team lead sign-ins and team pages (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url');
  const users: Record<'admin' | 'manager' | 'it', User> = {} as never, agents: Record<'admin' | 'manager' | 'it', Agent> = {} as never;
  let mcId = '', teamId = '';
  /** A dispatcher added by hand, in the team, with what a manager recorded (company email optional). */
  async function dispatcher(first: string, companyEmail: string | null, personalEmail = `${first.toLowerCase()}.home@example.test`) {
    const [member] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",status,"joinedAt") VALUES ($1,'Fictional','ACTIVE',now() - interval '90 days') RETURNING id`, [first]);
    await db.query(`INSERT INTO member_assignments ("memberId","mcId","teamId","startedAt") VALUES ($1,$2,$3,now() - interval '90 days')`, [member.id, mcId, teamId]);
    await db.query(`INSERT INTO existing_member_records ("memberId","addedBy","companyEmail","personalEmail") VALUES ($1,$2,$3,$4)`, [member.id, users.manager.id, companyEmail, personalEmail]);
    return member.id as string;
  }
  const team = async () => (await agents.manager.get(`/api/dispatch/teams/${teamId}`).set(headers).expect(200)).body;
  const lead = async (memberId: string | null) => {
    const { version } = await team();
    return agents.manager.patch(`/api/dispatch/teams/${teamId}`).set(headers).send({ version, leadMemberId: memberId }).expect(200);
  };
  const open = async () => (await db.query(`SELECT id, "memberId", kind FROM team_lead_sign_ins WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL ORDER BY kind DESC, "createdAt"`)) as { id: string; memberId: string; kind: string }[];
  const complete = (id: string, body: Record<string, unknown> = {}, agent: 'it' | 'admin' | 'manager' = 'it') => agents[agent].post(`/api/it/sign-ins/${id}`).set(headers).send(body);

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, ItModule, DispatchModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, team_lead_sign_ins CASCADE');
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['admin', Role.SYSTEM_ADMIN], ['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `signins.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      const secret = key === 'admin' ? await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users[key].id) : null;
      expect((await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password })).status).toBe(200);
      if (secret) expect((await completeMfa(agents[key], headers, db, users[key].id, secret)).status).toBe(200);
    }
    [{ id: mcId }] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Test Freight','test freight') RETURNING id`);
    [{ id: teamId }] = await db.query(`INSERT INTO teams (name,"nameKey","mcId") VALUES ('Test Team','test team',$1) RETURNING id`, [mcId]);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, users CASCADE'); await db.destroy(); } });

  it('asks IT to create a new lead’s sign-in with their company email, and lists it only for pages that know sign-ins', async () => {
    const jordan = await dispatcher('Jordan', 'jordan.work@example.test');
    await lead(jordan);
    const [request] = await open();
    expect(request).toMatchObject({ memberId: jordan, kind: 'CREATE' });
    // An older page asks without the flag and never meets a row it can't read.
    expect((await agents.it.get('/api/it/tasks').set(headers).expect(200)).body.items).toEqual([]);
    const listed = (await agents.it.get('/api/it/tasks?view=signin&signIns=1').set(headers).expect(200)).body;
    expect(listed.items).toEqual([expect.objectContaining({ kind: 'SIGN_IN', id: request.id, signIn: 'CREATE', name: 'Jordan Fictional', email: 'jordan.work@example.test', team: 'Test Team', mc: 'Test Freight', status: 'PENDING' })]);
    expect(listed.stats.signIns).toBe(1);
    expect((await agents.manager.get(`/api/dispatch/members/${jordan}`).set(headers).expect(200)).body.signIn).toEqual({ status: 'WAITING', request: 'CREATE' });
    // Only IT and administrators act on it, and an email can't be swapped for the recorded one.
    await complete(request.id, {}, 'manager').expect(403);
    await complete(request.id, { companyEmail: 'someone.else@example.test' }).expect(400);
    const done = (await complete(request.id).expect(201)).body;
    expect(done).toMatchObject({ kind: 'CREATE', email: 'jordan.work@example.test', name: 'Jordan Fictional' });
    expect(done.generatedPassword).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
    const account = await db.getRepository(User).findOneByOrFail({ email: 'jordan.work@example.test' });
    expect(account).toMatchObject({ role: Role.TEAM_LEAD, status: UserStatus.ACTIVE, mustChangePassword: true, firstName: 'Jordan' });
    expect((await db.query(`SELECT "accountUserId" FROM dispatch_members WHERE id = $1`, [jordan]))[0].accountUserId).toBe(account.id);
    const events = await db.query(`SELECT type, metadata FROM staff_security_events WHERE "userId" = $1`, [account.id]);
    expect(events).toEqual([{ type: 'USER_CREATED', metadata: expect.objectContaining({ reason: 'team-lead-sign-in' }) }]);
    expect(JSON.stringify(events)).not.toContain('jordan.work');
    expect(await open()).toEqual([]);
    await complete(request.id).expect(409);
    expect((await agents.manager.get(`/api/dispatch/members/${jordan}`).set(headers).expect(200)).body.signIn).toEqual({ status: 'ACTIVE', request: null });
  });

  it('takes the company email from IT when none is recorded, refusing a personal one or one another account uses', async () => {
    const riley = await dispatcher('Riley', null);
    await lead(riley);
    const [request] = await open();
    expect((await complete(request.id).expect(400)).body.message).toContain('Add their company email first');
    expect((await complete(request.id, { companyEmail: 'riley.home@example.test' }).expect(400)).body.message).toContain('personal email');
    expect((await complete(request.id, { companyEmail: 'signins.manager@example.test' }).expect(409)).body.message).toContain('already signs in');
    // Another dispatcher's company email, even without an account, is theirs.
    await dispatcher('Sam', 'sam.work@example.test');
    expect((await complete(request.id, { companyEmail: 'sam.work@example.test' }).expect(409)).body.message).toContain('already has this company email');
    const { version } = (await db.query(`SELECT version FROM dispatch_members WHERE id = $1`, [riley]))[0];
    await complete(request.id, { companyEmail: 'Riley.Work@example.test' }).expect(201);
    expect((await db.query(`SELECT "companyEmail" FROM existing_member_records WHERE "memberId" = $1`, [riley]))[0].companyEmail).toBe('riley.work@example.test');
    // A manager with the record open from before has to reload, so their save can't wipe the email.
    await agents.manager.patch(`/api/dispatch/members/${riley}/existing`).set(headers).send({ version, companyEmail: '' }).expect(409);
  });

  it('waits for a dispatch change holding the dispatcher’s record instead of failing', async () => {
    const jordan = await dispatcher('Jordan', 'jordan.work@example.test');
    await lead(jordan);
    const [request] = await open();
    // A dispatch change in progress: the dispatcher's record is locked, and then their open request.
    const change = db.createQueryRunner();
    await change.connect(); await change.startTransaction();
    try {
      await change.query(`SELECT id FROM dispatch_members WHERE id = $1 FOR UPDATE`, [jordan]);
      const click = complete(request.id).then(response => response);
      for (let tries = 0; !(await db.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%dispatch_members%'`)).length; tries++) {
        if (tries > 100) throw new Error('IT never waited for the dispatcher record');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await change.query(`SELECT id FROM team_lead_sign_ins WHERE id = $1 FOR UPDATE`, [request.id]);
      await change.commitTransaction();
      expect((await click).status).toBe(201);
    } finally { if (change.isTransactionActive) await change.rollbackTransaction(); await change.release(); }
  });

  it('turns off a lead who stays on, turns them back on when they lead again, and follows changed minds', async () => {
    const jordan = await dispatcher('Jordan', 'jordan.work@example.test'), riley = await dispatcher('Riley', 'riley.work@example.test');
    await lead(jordan);
    await complete((await open())[0].id).expect(201);
    await lead(riley);
    expect((await open()).map(row => [row.memberId, row.kind])).toEqual([[jordan, 'TURN_OFF'], [riley, 'CREATE']]);
    const off = (await open()).find(row => row.kind === 'TURN_OFF')!;
    const turnedOff = (await complete(off.id).expect(201)).body;
    expect(turnedOff.generatedPassword).toBeUndefined();
    expect((await db.getRepository(User).findOneByOrFail({ email: 'jordan.work@example.test' })).status).toBe(UserStatus.INACTIVE);
    // Jordan leads again before Riley's sign-in was made: Riley's request is cancelled and Jordan's old account comes back.
    await lead(jordan);
    const [again] = await open();
    expect(await open()).toHaveLength(1);
    expect(again).toMatchObject({ memberId: jordan, kind: 'TURN_ON' });
    const back = (await complete(again.id).expect(201)).body;
    expect(back.generatedPassword).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
    const account = await db.getRepository(User).findOneByOrFail({ email: 'jordan.work@example.test' });
    expect(account).toMatchObject({ status: UserStatus.ACTIVE, mustChangePassword: true });
    expect(await db.getRepository(User).countBy({ role: Role.TEAM_LEAD })).toBe(1);
    // A request that no longer matches is refused and replaced.
    await lead(riley);
    const stale = (await open()).find(row => row.memberId === riley)!;
    await lead(null);
    await complete(stale.id).expect(409);
    expect((await open()).map(row => [row.memberId, row.kind])).toEqual([[jordan, 'TURN_OFF']]);
  });

  it('keeps a team lead’s Staff accounts email to their company email and closes a waiting request', async () => {
    const jordan = await dispatcher('Jordan', 'jordan.work@example.test');
    await lead(jordan);
    const body = { firstName: 'Jordan', lastName: 'Fictional', role: Role.TEAM_LEAD, memberId: jordan };
    expect((await agents.admin.post('/api/users').set(headers).send({ ...body, email: 'jordan.home@example.test' }).expect(400)).body.message).toContain('jordan.work@example.test');
    await agents.admin.post('/api/users').set(headers).send({ ...body, email: 'jordan.work@example.test' }).expect(201);
    expect(await open()).toEqual([]);
    const casey = await dispatcher('Casey', null);
    expect((await agents.admin.post('/api/users').set(headers).send({ ...body, firstName: 'Casey', email: 'casey.work@example.test', memberId: casey }).expect(400)).body.message).toContain('Record their company email');
  });

  it('cancels Turn back on when an administrator turns the account on, and keeps a corrected request after a stale click', async () => {
    const jordan = await dispatcher('Jordan', 'jordan.work@example.test'), riley = await dispatcher('Riley', 'riley.work@example.test');
    await lead(jordan);
    await complete((await open())[0].id).expect(201);
    await lead(riley);
    await complete((await open()).find(row => row.kind === 'TURN_OFF')!.id).expect(201);
    await lead(jordan);
    expect((await open()).map(row => [row.memberId, row.kind])).toEqual([[jordan, 'TURN_ON']]);
    // The administrator turns Jordan's account on in Staff accounts: IT's request is answered, so it goes.
    const account = await db.getRepository(User).findOneByOrFail({ email: 'jordan.work@example.test' });
    await agents.admin.patch(`/api/users/${account.id}`).set(headers).send({ status: UserStatus.ACTIVE }).expect(200);
    expect(await open()).toEqual([]);
    // A request that went stale without anyone asking (the team archived directly here) is corrected and kept after the 409.
    await lead(riley);
    const stale = (await open()).find(row => row.memberId === riley)!;
    await db.query(`UPDATE teams SET "leadMemberId" = NULL WHERE id = $1`, [teamId]);
    expect((await complete(stale.id).expect(409)).body.message).toBe('This changed since it was asked. Reload IT tasks.');
    expect((await open()).map(row => [row.memberId, row.kind])).toEqual([[jordan, 'TURN_OFF']]);
  });

  it('turns an account back on only under their company email now, and never edits a finished IT setup', async () => {
    const jordan = await dispatcher('Jordan', 'jordan.work@example.test'), riley = await dispatcher('Riley', 'riley.work@example.test');
    await lead(jordan);
    await complete((await open())[0].id).expect(201);
    await lead(riley);
    await complete((await open()).find(row => row.kind === 'TURN_OFF')!.id).expect(201);
    await db.query(`UPDATE existing_member_records SET "companyEmail" = 'jordan.new@example.test' WHERE "memberId" = $1`, [jordan]);
    await lead(jordan);
    const [again] = await open();
    expect((await complete(again.id).expect(409)).body.message).toContain('jordan.new@example.test');
    const old = await db.getRepository(User).findOneByOrFail({ email: 'jordan.work@example.test' });
    expect(old.status).toBe(UserStatus.INACTIVE);
    // An administrator can't bring it back under the old email in Staff accounts either.
    expect((await agents.admin.patch(`/api/users/${old.id}`).set(headers).send({ status: UserStatus.ACTIVE }).expect(400)).body.message).toContain('jordan.new@example.test');
    // Someone with no record of their own and no company email: IT can't add it here, and nothing else is touched.
    const [casey] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",status,"joinedAt") VALUES ('Casey','Fictional','ACTIVE',now()) RETURNING id`);
    await db.query(`INSERT INTO member_assignments ("memberId","mcId","teamId","startedAt") VALUES ($1,$2,$3,now())`, [casey.id, mcId, teamId]);
    await lead(casey.id);
    const create = (await open()).find(row => row.memberId === casey.id)!;
    expect((await complete(create.id, { companyEmail: 'casey.work@example.test' }).expect(400)).body.message).toContain('can’t be added here');
    // A company email IT adds to a record by hand is in its history, by field name only.
    const rowan = await dispatcher('Rowan', null);
    await lead(rowan);
    await complete((await open()).find(row => row.memberId === rowan)!.id, { companyEmail: 'rowan.work@example.test' }).expect(201);
    const events = await db.query(`SELECT metadata FROM dispatch_events WHERE "memberId" = $1 AND event = 'EXISTING_UPDATED'`, [rowan]);
    expect(events).toEqual([{ metadata: { fields: ['companyEmail'], reason: 'team-lead-sign-in' } }]);
  });

  it('cancels a waiting request when the lead leaves, and asks for nothing during a notice', async () => {
    const jordan = await dispatcher('Jordan', 'jordan.work@example.test');
    await lead(jordan);
    const member = async () => (await db.query(`SELECT version FROM dispatch_members WHERE id = $1`, [jordan]))[0].version as number;
    await agents.manager.post(`/api/dispatch/members/${jordan}/leave`).set(headers).send({ version: await member(), leftAt: addDays(usDay('latest'), 10), reason: 'Moving away.' }).expect(201);
    expect(await open()).toEqual([]);
  });

  it('shows a team as it’s built: dispatchers with drivers and photos, and who assists them or the whole team', async () => {
    const jordan = await dispatcher('Jordan', 'jordan.work@example.test'), riley = await dispatcher('Riley', null);
    const [sky] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",position,"supportType","joinedAt") VALUES ('Sky','Fictional','SUPPORT','UPDATER',now()) RETURNING id`);
    const [alex] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",position,"joinedAt") VALUES ('Alex','Fictional','SUPPORT',now()) RETURNING id`);
    await db.query(`INSERT INTO member_support_links ("supportId","dispatcherId","startedAt") VALUES ($1,$2,now())`, [sky.id, riley]);
    await db.query(`INSERT INTO member_support_links ("supportId","teamId","startedAt") VALUES ($1,$2,now())`, [alex.id, teamId]);
    await lead(jordan);
    const detail = await team();
    expect(detail).toMatchObject({ id: teamId, name: 'Test Team', leadId: jordan, archived: false, mc: { id: mcId, name: 'Test Freight' } });
    expect(detail.dispatchers.map((row: { firstName: string; drivers: number; photo: boolean; companyEmail: string | null; accountStatus: string | null }) => [row.firstName, row.drivers, row.photo, row.companyEmail, row.accountStatus]))
      .toEqual([['Jordan', 0, false, 'jordan.work@example.test', null], ['Riley', 0, false, null, null]]);
    expect(detail.helpers.map((row: { firstName: string; supportType: string; dispatcherId: string | null; teamId: string | null }) => [row.firstName, row.supportType, row.dispatcherId, row.teamId]))
      .toEqual([['Alex', 'SUPPORT', null, teamId], ['Sky', 'UPDATER', riley, null]]);
    const listed = (await agents.manager.get('/api/dispatch/teams').set(headers).expect(200)).body.items;
    expect(listed[0]).toMatchObject({ members: 2, wholeTeam: 1, helpers: 2 });
    await agents.it.get(`/api/dispatch/teams/${teamId}`).set(headers).expect(403);
    await agents.manager.get(`/api/dispatch/teams/${randomUUID()}`).set(headers).expect(404);
  });

  it('refuses a rollback once IT handled a sign-in', async () => {
    const jordan = await dispatcher('Jordan', 'jordan.work@example.test');
    await lead(jordan);
    await complete((await open())[0].id).expect(201);
    const runner = db.createQueryRunner();
    const { TeamLeadSignIns1793030000000: Migration } = await import('../src/database/migrations/1793030000000-TeamLeadSignIns');
    await expect(new Migration().down(runner)).rejects.toThrow('Cannot discard team lead sign-ins');
    await runner.release();
  });
});
