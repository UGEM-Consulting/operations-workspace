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
import { OnboardingModule } from '../src/modules/onboarding/onboarding.module';
import { ItModule } from '../src/modules/it/it.module';
import { DispatchModule } from '../src/modules/dispatch/dispatch.module';
import { LeavingSweeper } from '../src/modules/dispatch/leaving-sweeper';
import { addDays, usDay } from '../src/modules/safety/screening-rules';
import { completeMfa, enrolForTest } from './mfa-helpers';
type Agent = ReturnType<typeof request.agent>;
type Key = 'admin' | 'manager' | 'other' | 'it';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Bringing back someone who left (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url');
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  /**
   * An approved dispatcher with their IT setup request (finished or not) and an open place in an MC: what approval and
   * IT setup leave behind. Returns the ids the tests need.
   */
  async function dispatcher(name: string, options: { setupDone?: boolean; status?: string; manager?: string } = {}) {
    const manager = options.manager ?? users.manager.id;
    const [inv] = await db.query(`INSERT INTO invitations ("managerId","tokenHash","mcName","teamLead","jobTitle","expiresAt","telegramRequired",email) VALUES ($1,$2,'Northwind Freight','Lee Lead','Dispatcher',now()+interval '7 days',false,$3) RETURNING id`,
      [manager, randomBytes(32).toString('hex'), `${name.toLowerCase()}@example.test`]);
    const fields = { firstName: 'Legal', lastName: name, preferredAmericanFirstName: name, preferredAmericanLastName: 'Fictional' };
    const [application] = await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"applicantAccessUntil","submittedAt") VALUES ($1,$2,$3,$4,3,now()+interval '7 days',$5) RETURNING id`,
      [inv.id, manager, options.status ?? 'APPROVED', fields, ['INVITED', 'DRAFT'].includes(options.status ?? '') ? null : new Date()]);
    await db.query(`INSERT INTO application_submissions ("applicationId",version,fields) VALUES ($1,2,$2)`, [application.id, fields]);
    if ((options.status ?? 'APPROVED') !== 'APPROVED') return { invitationId: inv.id as string, applicationId: application.id as string, memberId: '', setupId: '' };
    const [review] = await db.query(`INSERT INTO application_reviews ("applicationId","reviewerId","decisionType","requestedFields","previousStatus","newStatus","applicationVersion",employment) VALUES ($1,$2,'APPROVE','[]','SUBMITTED','APPROVED',3,$3) RETURNING id`,
      [application.id, manager, { mcName: 'Northwind Freight', teamLead: 'Lee Lead', jobTitle: 'Dispatcher' }]);
    const done = options.setupDone ?? true;
    const [setup] = await db.query(`INSERT INTO it_onboarding_requests ("applicationId","approvalId","managerId",profile,"companyEmail","assignedRingCentralPhoneNumber","completedAt") VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [application.id, review.id, manager, { proposedDisplayName: `${name} Fictional`, personalEmail: `${name.toLowerCase()}@example.test`, mcName: 'Northwind Freight', teamLead: 'Lee Lead', jobTitle: 'Dispatcher', workPhoneNumber: null },
        done ? `${name.toLowerCase()}.work@example.test` : null, done ? '+1 202 555 0190' : null, done ? new Date() : null]);
    for (const key of ['GOOGLE_WORKSPACE', 'DISPATCH_GROUP', 'RINGCENTRAL', 'SMS', 'CALL_RECORDING', 'BUSINESS_SOFTWARE', 'EQUIPMENT'])
      await db.query(`INSERT INTO it_onboarding_tasks ("requestId",key,status) VALUES ($1,$2,$3)`, [setup.id, key, done ? 'COMPLETED' : 'PENDING']);
    const [member] = await db.query(`INSERT INTO dispatch_members ("applicationId","firstName","lastName",status,"joinedAt") VALUES ($1,$2,'Fictional',$3,now() - interval '30 days') RETURNING id`,
      [application.id, name, done ? 'ACTIVE' : 'ONBOARDING']);
    const [mc] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ($1::varchar, lower($1::varchar)) ON CONFLICT DO NOTHING RETURNING id`, ['Northwind Freight']);
    const mcId = mc?.id ?? (await db.query(`SELECT id FROM mcs WHERE "nameKey" = 'northwind freight'`))[0].id;
    await db.query(`INSERT INTO member_assignments ("memberId","mcId","startedAt") VALUES ($1,$2,now() - interval '30 days')`, [member.id, mcId]);
    return { invitationId: inv.id as string, applicationId: application.id as string, memberId: member.id as string, setupId: setup.id as string };
  }
  const version = async (memberId: string) => (await db.query(`SELECT version FROM dispatch_members WHERE id = $1`, [memberId]))[0].version as number;
  const leave = async (memberId: string, body: Record<string, unknown> = {}, status = 201) => agents.manager.post(`/api/dispatch/members/${memberId}/leave`).set(headers)
    .send({ version: await version(memberId), leftAt: usDay('latest'), reason: 'Resigned for a job outside logistics.', ...body }).expect(status);
  const ahead = (days: number) => addDays(usDay('latest'), days);
  const act = async (memberId: string, path: string, body: Record<string, unknown>, status = 201) => agents.manager.post(`/api/dispatch/members/${memberId}/${path}`).set(headers).send({ version: await version(memberId), ...body }).expect(status);
  const alerts = async () => (await db.query(`SELECT kind FROM notification_deliveries ORDER BY "createdAt"`)).map((row: { kind: string }) => row.kind);
  /** A support assisting this dispatcher: someone who must be reassigned before they can leave. Returns the support's id. */
  const supportOf = async (dispatcherId: string) => {
    const [support] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",position,"joinedAt") VALUES ('Sky','Support','SUPPORT',now() - interval '3 days') RETURNING id`);
    await db.query(`INSERT INTO member_support_links ("supportId","dispatcherId","startedAt") VALUES ($1,$2,now() - interval '3 days')`, [support.id, dispatcherId]);
    return support.id as string;
  };
  const removalOf = async (memberId: string) => (await db.query(`SELECT *, "dueOn"::text AS "dueOn" FROM it_removal_requests WHERE "memberId" = $1 ORDER BY "cancelledAt" IS NULL DESC, "createdAt" DESC`, [memberId]))[0];

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, OnboardingModule, ItModule, DispatchModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, notification_deliveries, it_removal_requests CASCADE');
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['admin', Role.SYSTEM_ADMIN], ['manager', Role.DISPATCHER_MANAGER], ['other', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `back.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      // Administrators always use two-step verification: enrolled first, then the code after the password.
      const secret = key === 'admin' ? await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users[key].id) : null;
      const signedIn = await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password });
      expect([key, signedIn.status, signedIn.body.message ?? null]).toEqual([key, 200, null]);
      if (secret) expect((await completeMfa(agents[key], headers, db, users[key].id, secret)).status).toBe(200);
    }
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, it_removal_requests, users CASCADE'); await db.destroy(); } });

  /** IT finishes the removal as section 40 records it: the email archived (or deleted) and the RingCentral user turned off. */
  const finishRemoval = async (memberId: string, emailDone = 'ARCHIVED', doneDaysAgo = 1) => {
    const removal = await removalOf(memberId);
    await db.query(`UPDATE it_removal_tasks SET status = CASE WHEN key = 'EQUIPMENT' THEN 'NOT_NEEDED' ELSE 'COMPLETED' END, "updatedAt" = now() - make_interval(days => $2) WHERE "requestId" = $1`, [removal.id, doneDaysAgo]);
    await db.query(`UPDATE it_removal_requests SET "emailDone" = $2, "ringCentralOff" = '{USER,SMS,INBOUND_RECORDING,OUTBOUND_RECORDING}', "completedAt" = now() - make_interval(days => $3) WHERE id = $1`, [removal.id, emailDone, doneDaysAgo]);
    return removal.id as string;
  };
  const profile = async (memberId: string) => (await agents.manager.get(`/api/dispatch/members/${memberId}`).set(headers).expect(200)).body;
  const options = async (memberId: string) => (await agents.manager.get(`/api/dispatch/members/${memberId}/bring-back`).set(headers).expect(200)).body;
  const returnSetup = async (memberId: string) => (await db.query(`SELECT * FROM it_onboarding_requests WHERE "memberId" = $1 AND purpose IN ('REHIRE','RESTORE') ORDER BY "createdAt" DESC`, [memberId]))[0];
  const setupTasks = async (requestId: string) => (await db.query(`SELECT key FROM it_onboarding_tasks WHERE "requestId" = $1 ORDER BY key`, [requestId])).map((row: { key: string }) => row.key);
  /** IT works a return checklist to the end through its routes. */
  const finishSetup = async (requestId: string) => {
    let detail = (await agents.it.get(`/api/it/onboarding/${requestId}`).set(headers).expect(200)).body;
    for (const task of detail.tasks) detail = (await agents.it.patch(`/api/it/onboarding/${requestId}/tasks/${task.key}`).set(headers).send({ version: detail.request.version, status: 'COMPLETED' }).expect(200)).body;
    return detail;
  };
  /** Their last day a few days back, so a rehire today comes after it. */
  const leftDaysAgo = async (memberId: string, days: number) => {
    const at = new Date(Date.parse(`${ahead(-days)}T12:00:00Z`));
    await db.query(`UPDATE dispatch_members SET "leftAt" = $2 WHERE id = $1`, [memberId, at]);
    await db.query(`UPDATE member_assignments SET "endedAt" = $2 WHERE "memberId" = $1 AND "endedAt" IS NOT NULL`, [memberId, at]);
  };
  const shortDay = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  it('undoes a leaving within 30 days: Active again in the same MC and team, IT’s finished removal becomes a restore checklist', async () => {
    const taylor = await dispatcher('Taylor');
    await leave(taylor.memberId, { emailAction: 'ARCHIVE' });
    const removalId = await finishRemoval(taylor.memberId);
    const offered = await options(taylor.memberId);
    expect(offered).toMatchObject({ undo: { allowed: true, until: ahead(30), comesBack: { place: { mc: 'Northwind Freight', team: null, carriesOn: true }, jobTitle: null }, notBack: { drivers: [], supports: [], ledTeams: [] } },
      rehire: { allowed: true }, email: { value: 'taylor.work@example.test', was: 'ARCHIVED', restorable: true }, ringCentral: { number: '+1 202 555 0190', restorable: true } });
    expect((await profile(taylor.memberId)).bringBack).toEqual({ undoUntil: ahead(30), canUndo: true, canRehire: true, rehireWhy: null });
    await act(taylor.memberId, 'undo-leaving', { reason: '' }, 400);
    await act(taylor.memberId, 'undo-leaving', { reason: 'Taylor decided to stay.' });
    const back = await profile(taylor.memberId);
    expect(back).toMatchObject({ status: 'ACTIVE', leftAt: null, leftReason: null, current: { mc: 'Northwind Freight', endedAt: null }, returns: [expect.objectContaining({ kind: 'UNDO', reason: 'Taylor decided to stay.', by: 'Fictional manager' })], bringBack: null, removal: null });
    expect(back.history).toHaveLength(1);
    // The finished removal stays IT's record, reversed; the restore checklist brings back what it removed, with the old accounts filled in.
    expect(await db.query(`SELECT "reversedAt" IS NOT NULL AS reversed, "cancelledAt" IS NOT NULL AS cancelled FROM it_removal_requests WHERE id = $1`, [removalId])).toEqual([{ reversed: true, cancelled: true }]);
    const restore = await returnSetup(taylor.memberId);
    expect(restore).toMatchObject({ purpose: 'RESTORE', companyEmail: 'taylor.work@example.test', assignedRingCentralPhoneNumber: '+1 202 555 0190', managerId: users.manager.id,
      profile: { returning: { kind: 'UNDO', emailWas: 'ARCHIVED', by: 'Fictional manager' } } });
    expect(await setupTasks(restore.id)).toEqual(['BUSINESS_SOFTWARE', 'CALL_RECORDING', 'DISPATCH_GROUP', 'GOOGLE_WORKSPACE', 'RINGCENTRAL', 'SMS']);
    expect([...restore.restoreKeys].sort()).toEqual(['BUSINESS_SOFTWARE', 'CALL_RECORDING', 'DISPATCH_GROUP', 'GOOGLE_WORKSPACE', 'RINGCENTRAL', 'SMS']);
    expect(await alerts()).toEqual(['IT_REMOVAL_WAITING', 'IT_SETUP_WAITING']);
    // IT sees it with the setups, worded as a restore; finishing it lets the manager know and changes nothing else.
    const list = (await agents.it.get('/api/it/tasks?view=all').set(headers).expect(200)).body.items;
    expect(list.map((row: { kind: string; purpose: string | null; status: string }) => [row.kind, row.purpose, row.status])).toEqual(expect.arrayContaining([['SETUP', 'RESTORE', 'PENDING'], ['REMOVAL', null, 'COMPLETED']]));
    const detail = (await agents.it.get(`/api/it/onboarding/${restore.id}`).set(headers).expect(200)).body;
    expect(detail.tasks.find((task: { key: string }) => task.key === 'GOOGLE_WORKSPACE').description).toMatch(/^Restore their company email/);
    expect((await finishSetup(restore.id)).request.completedAt).not.toBeNull();
    expect(await db.query(`SELECT kind, "recipientId" FROM portal_notifications WHERE "requestId" = $1`, [restore.id])).toEqual([{ kind: 'IT_ONBOARDING_COMPLETED', recipientId: users.manager.id }]);
    expect((await profile(taylor.memberId)).status).toBe('ACTIVE');
    // History keeps the leaving, why it was undone, and IT's side; the event holds flags only.
    const titles = (await profile(taylor.memberId)).timeline.entries.map((entry: { title: string }) => entry.title);
    expect(titles).toEqual(expect.arrayContaining(['Left', 'Leaving undone', 'IT’s removal reversed: they came back', expect.stringMatching(/^IT asked to restore their access/)]));
    expect((await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'LEAVING_UNDONE'`))[0].metadata).toEqual({ periodBack: true, linkBack: false, itRestore: true, removalCancelled: false, setupBack: false });
    // Leaving again opens a new removal: the reversed one no longer counts as theirs.
    await leave(taylor.memberId, { emailAction: 'SUSPEND' });
    expect((await removalOf(taylor.memberId)).id).not.toBe(removalId);
  });

  it('cancels a removal still open, restores only what IT had done, and lists what doesn’t come back by itself', async () => {
    const casey = await dispatcher('Casey');
    const sky = await supportOf(casey.memberId);
    const [team] = await db.query(`INSERT INTO teams (name, "nameKey", "mcId", "leadMemberId") SELECT 'Casey team', 'casey team', "mcId", $1 FROM member_assignments WHERE "memberId" = $1 RETURNING id`, [casey.memberId]);
    await db.query(`UPDATE member_assignments SET "teamId" = $2 WHERE "memberId" = $1`, [casey.memberId, team.id]);
    const dana = await dispatcher('Dana');
    await act(sky, 'reassign', { dispatcherId: dana.memberId, startedAt: usDay('latest'), reason: 'Casey is leaving.' });
    await leave(casey.memberId);
    const removal = await removalOf(casey.memberId);
    await db.query(`UPDATE it_removal_tasks SET status = 'COMPLETED' WHERE "requestId" = $1 AND key = 'DISPATCH_GROUP'`, [removal.id]);
    expect((await options(casey.memberId)).undo.notBack).toEqual({ drivers: [], supports: [expect.objectContaining({ name: 'Sky Support', now: 'Dana Fictional' })], ledTeams: ['Casey team'], seats: [], sharing: [] });
    // Rehire waits for IT to finish removing access; Undo leaving doesn't.
    expect((await options(casey.memberId)).rehire).toMatchObject({ allowed: false, why: expect.stringMatching(/still removing/) });
    await act(casey.memberId, 'rehire', { firstDay: usDay('latest'), position: 'SUPPORT', supportsMemberId: dana.memberId, email: 'NONE', ringCentral: 'NONE', businessSoftware: false, equipment: false }, 409);
    await act(casey.memberId, 'undo-leaving', { reason: 'Marked as left by mistake.' });
    expect(await db.query(`SELECT "cancelledAt" IS NOT NULL AS cancelled, "reversedAt" FROM it_removal_requests WHERE id = $1`, [removal.id])).toEqual([{ cancelled: true, reversedAt: null }]);
    const restore = await returnSetup(casey.memberId);
    expect(await setupTasks(restore.id)).toEqual(['DISPATCH_GROUP']);
    // Their team is still there, so their place carries on, but leading it is chosen again.
    expect(await profile(casey.memberId)).toMatchObject({ status: 'ACTIVE', current: { team: 'Casey team', endedAt: null }, leadOf: null });
  });

  it('refuses an undo after 30 days or with a stale version, and gives IT nothing when nothing was removed yet', async () => {
    const lee = await dispatcher('Lee');
    await leave(lee.memberId);
    await act(lee.memberId, 'undo-leaving', { reason: 'Stale.', version: 1 }, 409);
    // Nothing done yet: the removal is cancelled and IT gets nothing to restore.
    await act(lee.memberId, 'undo-leaving', { reason: 'Changed their mind the same day.' });
    expect(await returnSetup(lee.memberId)).toBeUndefined();
    const morgan = await dispatcher('Morgan');
    await leave(morgan.memberId);
    await finishRemoval(morgan.memberId);
    const old = new Date(Date.now() - 40 * 86400_000);
    await db.query(`UPDATE dispatch_members SET "leftAt" = $2 WHERE id = $1`, [morgan.memberId, old]);
    await db.query(`UPDATE member_assignments SET "startedAt" = now() - interval '90 days', "endedAt" = $2 WHERE "memberId" = $1`, [morgan.memberId, old]);
    expect((await options(morgan.memberId)).undo).toMatchObject({ allowed: false, why: expect.stringMatching(/^Undo leaving was possible until/) });
    await act(morgan.memberId, 'undo-leaving', { reason: 'Too late.' }, 409);
  });

  it('rehires on the same record: placed again, Onboarding until IT restores or creates their accounts, then Active', async () => {
    const taylor = await dispatcher('Taylor');
    await leave(taylor.memberId, { emailAction: 'DELETE' });
    // Deleted 25 days ago: Google can't restore it any more, so the email must be new.
    const removalId = await finishRemoval(taylor.memberId, 'DELETED', 25);
    const offered = await options(taylor.memberId);
    expect(offered.email).toMatchObject({ was: 'DELETED', restorable: false, why: expect.stringMatching(/IT can no longer restore it/) });
    const [title] = await db.query(`INSERT INTO job_titles (name, "nameKey") VALUES ('Senior dispatcher', 'senior dispatcher') RETURNING id`);
    const mcId = offered.rehire.previous.mcId;
    const rehire = (body: Record<string, unknown>, status = 201) => act(taylor.memberId, 'rehire', { firstDay: ahead(7), position: 'DISPATCHER', mcId, jobTitleId: title.id, email: 'NEW', ringCentral: 'RESTORE', businessSoftware: true, equipment: false, ...body }, status);
    await rehire({ email: 'RESTORE' }, 400);
    await rehire({ firstDay: ahead(-1) }, 400);
    await rehire({ firstDay: ahead(91) }, 400);
    await rehire({ jobTitleId: undefined }, 400);
    await rehire({});
    const back = await profile(taylor.memberId);
    expect(back).toMatchObject({ status: 'ONBOARDING', position: 'DISPATCHER', leftAt: null, jobTitle: { name: 'Senior dispatcher' }, current: { mc: 'Northwind Freight', endedAt: null }, returns: [expect.objectContaining({ kind: 'REHIRE', firstDay: ahead(7) })] });
    expect(back.history).toHaveLength(2);
    expect(back.joinedAt.slice(0, 10)).toBe(ahead(7));
    const setup = await returnSetup(taylor.memberId);
    expect(setup).toMatchObject({ purpose: 'REHIRE', companyEmail: null, assignedRingCentralPhoneNumber: '+1 202 555 0190', profile: { jobTitle: 'Senior dispatcher', returning: { kind: 'REHIRE', firstDay: ahead(7), emailWas: 'DELETED' } } });
    expect(await setupTasks(setup.id)).toEqual(['BUSINESS_SOFTWARE', 'CALL_RECORDING', 'DISPATCH_GROUP', 'GOOGLE_WORKSPACE', 'RINGCENTRAL', 'SMS']);
    expect([...setup.restoreKeys].sort()).toEqual(['BUSINESS_SOFTWARE', 'CALL_RECORDING', 'DISPATCH_GROUP', 'RINGCENTRAL', 'SMS']);
    expect(await db.query(`SELECT "reversedAt" IS NOT NULL AS reversed FROM it_removal_requests WHERE id = $1`, [removalId])).toEqual([{ reversed: true }]);
    // The new email is recorded by IT as for anyone; finishing before their first day back leaves them Onboarding until it comes.
    const detail = (await agents.it.get(`/api/it/onboarding/${setup.id}`).set(headers).expect(200)).body;
    await agents.it.patch(`/api/it/onboarding/${setup.id}/contact`).set(headers).send({ version: detail.request.version, companyEmail: 'taylor.new@example.test', workPhoneVerified: false }).expect(200);
    await finishSetup(setup.id);
    expect(await profile(taylor.memberId)).toMatchObject({ status: 'ONBOARDING', accounts: { companyEmail: 'taylor.new@example.test', workPhone: '+1 202 555 0190' } });
    await app.get(LeavingSweeper).run();
    expect((await profile(taylor.memberId)).status).toBe('ONBOARDING');
    expect((await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'REHIRED'`))[0].metadata).toEqual({ position: 'DISPATCHER', itSetup: true, restored: true, assists: null });
    expect((await profile(taylor.memberId)).timeline.entries.map((entry: { title: string }) => entry.title)).toEqual(expect.arrayContaining([`Rehired, back ${shortDay(ahead(7))}`, 'Left']));
    // Their first day back comes: the last-day job makes them Active.
    await db.query(`UPDATE member_returns SET "firstDay" = $2 WHERE "memberId" = $1`, [taylor.memberId, usDay('latest')]);
    await app.get(LeavingSweeper).run();
    expect((await profile(taylor.memberId)).status).toBe('ACTIVE');
  });

  it('offers a first day back the rehire takes, shows each return’s IT checklist, and words days picked in forms as dates', async () => {
    const taylor = await dispatcher('Taylor');
    // Impossible days are refused as such, never a server error.
    for (const body of [{ firstDay: '2026-11-31', backOn: ahead(10) }, { firstDay: ahead(1), backOn: '2027-02-30' }])
      expect((await act(taylor.memberId, 'on-leave', { ...body, reason: 'Family matters.' }, 400)).body.message).toEqual(expect.arrayContaining(['Enter a real date.']));
    await leave(taylor.memberId, { emailAction: 'ARCHIVE' });
    const removalId = await finishRemoval(taylor.memberId);
    const offered = await options(taylor.memberId);
    const [title] = await db.query(`INSERT INTO job_titles (name, "nameKey") VALUES ('Dispatcher', 'dispatcher') RETURNING id`);
    const rehire = (firstDay: string, status = 201) => act(taylor.memberId, 'rehire', { firstDay, position: 'DISPATCHER', mcId: offered.rehire.previous.mcId, jobTitleId: title.id, email: 'RESTORE', ringCentral: 'NONE', businessSoftware: false, equipment: false }, status);
    // Left today: the day offered is one the rehire accepts, and any earlier day is refused.
    expect(offered.rehire.earliest >= usDay('latest')).toBe(true);
    if (offered.rehire.earliest > usDay('latest')) await rehire(usDay('latest'), 400);
    await rehire(offered.rehire.earliest);
    const back = await profile(taylor.memberId);
    expect(back.returns[0]).toMatchObject({ kind: 'REHIRE', setup: { done: 0, total: expect.any(Number), completedAt: null, cancelledAt: null } });
    await finishSetup((await returnSetup(taylor.memberId)).id);
    expect((await profile(taylor.memberId)).returns[0].setup.completedAt).not.toBeNull();
    // A day picked in a form (the period's start) is a date with no time; History sorts it after that day's clicks.
    const entries: { title: string; at: string; dateOnly?: boolean }[] = (await profile(taylor.memberId)).timeline.entries;
    expect(entries.find(entry => /^Started again/.test(entry.title))).toMatchObject({ dateOnly: true });
    expect(entries.find(entry => entry.title.startsWith('Rehired'))?.dateOnly).toBeUndefined();
    // A move later on their first day back is a move, and its day (one millisecond after the period it ends) still shows as a date.
    const [open] = await db.query(`SELECT id, "mcId", "startedAt" FROM member_assignments WHERE "memberId" = $1 AND "endedAt" IS NULL`, [taylor.memberId]);
    const moved = new Date(new Date(open.startedAt).getTime() + 1);
    await db.query(`UPDATE member_assignments SET "endedAt" = $2 WHERE id = $1`, [open.id, open.startedAt]);
    await db.query(`INSERT INTO member_assignments ("memberId","mcId","startedAt") VALUES ($1,$2,$3)`, [taylor.memberId, open.mcId, moved]);
    const after: { title: string; dateOnly?: boolean }[] = (await profile(taylor.memberId)).timeline.entries;
    expect(after.filter(entry => /^Started again/.test(entry.title))).toHaveLength(1);
    expect(after.find(entry => /^Moved to/.test(entry.title))).toMatchObject({ dateOnly: true });
    expect(removalId).toBeTruthy();
  });

  it('rehires a support with nothing asked of IT: Active on their first day back', async () => {
    const dana = await dispatcher('Dana');
    const sky = await supportOf(dana.memberId);
    await leave(sky);
    expect((await options(sky)).rehire).toMatchObject({ allowed: true, previous: { position: 'SUPPORT', supportsMemberId: dana.memberId } });
    await act(sky, 'rehire', { firstDay: ahead(3), position: 'UPDATER', supportsMemberId: dana.memberId, email: 'NONE', ringCentral: 'NONE', businessSoftware: false, equipment: false });
    expect(await profile(sky)).toMatchObject({ status: 'ONBOARDING', supportType: 'UPDATER', supportOf: { dispatcher: 'Dana Fictional' } });
    expect(await returnSetup(sky)).toBeUndefined();
    // The last-day job makes them Active once the day comes.
    await db.query(`UPDATE member_returns SET "firstDay" = $2 WHERE "memberId" = $1`, [sky, usDay('latest')]);
    await app.get(LeavingSweeper).run();
    expect((await profile(sky)).status).toBe('ACTIVE');
  });

  it('retires the old email and number a rehire doesn’t get back, so they stop counting as theirs', async () => {
    const taylor = await dispatcher('Taylor');
    await leave(taylor.memberId, { emailAction: 'ARCHIVE' });
    await finishRemoval(taylor.memberId);
    await leftDaysAgo(taylor.memberId, 2);
    const [title] = await db.query(`INSERT INTO job_titles (name, "nameKey") VALUES ('Dispatcher', 'dispatcher') RETURNING id`);
    const { rehire: { previous } } = await options(taylor.memberId);
    await act(taylor.memberId, 'rehire', { firstDay: ahead(0), position: 'DISPATCHER', mcId: previous.mcId, jobTitleId: title.id, email: 'NEW', ringCentral: 'NONE', businessSoftware: false, equipment: false });
    // Kept on the old setup for IT, never deleted; read by nothing else.
    expect(await db.query(`SELECT "companyEmail", "retiredCompanyEmail", "assignedRingCentralPhoneNumber", "retiredRingCentralNumber", "accountsRetiredAt" IS NOT NULL AS retired FROM it_onboarding_requests WHERE id = $1`, [taylor.setupId]))
      .toEqual([{ companyEmail: null, retiredCompanyEmail: 'taylor.work@example.test', assignedRingCentralPhoneNumber: null, retiredRingCentralNumber: '+1 202 555 0190', retired: true }]);
    expect((await agents.it.get(`/api/it/onboarding/${taylor.setupId}`).set(headers).expect(200)).body.request).toMatchObject({ companyEmail: null, retiredCompanyEmail: 'taylor.work@example.test' });
    expect((await profile(taylor.memberId)).accounts).toMatchObject({ companyEmail: null, workPhone: null });
    // Leaving again before IT records a new email: nothing old for IT to remove a second time.
    await leave(taylor.memberId);
    expect((await removalOf(taylor.memberId)).profile).toMatchObject({ companyEmail: null, ringCentralNumber: null });
  });

  it('offers to restore the email and number on their record when IT never removed their access', async () => {
    // Someone added from a file as Left, with accounts a manager recorded and IT never asked to close them.
    const [member] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",status,"joinedAt","leftAt") VALUES ('Rowan','Fictional','LEFT',now() - interval '400 days',now() - interval '60 days') RETURNING id`);
    const [mc] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Lakeside Carriers','lakeside carriers') RETURNING id`);
    await db.query(`INSERT INTO member_assignments ("memberId","mcId","startedAt","endedAt") VALUES ($1,$2,now() - interval '400 days',now() - interval '60 days')`, [member.id, mc.id]);
    await db.query(`INSERT INTO existing_member_records ("memberId","addedBy","companyEmail","ringCentralNumber","ringCentralExtension") VALUES ($1,$2,'rowan.work@example.test','+1 202 555 0177','177')`, [member.id, users.manager.id]);
    const offered = await options(member.id);
    expect(offered.removal).toBeNull();
    expect(offered.email).toMatchObject({ value: 'rowan.work@example.test', restorable: true, notClosed: true });
    expect(offered.ringCentral).toMatchObject({ number: '+1 202 555 0177', extension: '177', restorable: true, notClosed: true });
    const [title] = await db.query(`INSERT INTO job_titles (name, "nameKey") VALUES ('Dispatcher', 'dispatcher') RETURNING id`);
    const rehire = { firstDay: ahead(0), position: 'DISPATCHER', mcId: mc.id, jobTitleId: title.id, businessSoftware: false, equipment: false };
    await act(member.id, 'rehire', { ...rehire, email: 'RESTORE', ringCentral: 'RESTORE' });
    const setup = await returnSetup(member.id);
    expect(setup).toMatchObject({ purpose: 'REHIRE', companyEmail: 'rowan.work@example.test', assignedRingCentralPhoneNumber: '+1 202 555 0177', ringCentralExtension: '177' });
    expect(setup.restoreKeys).toEqual(expect.arrayContaining(['GOOGLE_WORKSPACE', 'RINGCENTRAL', 'SMS', 'CALL_RECORDING']));
    expect(setup.profile.returning.notClosed).toEqual(['EMAIL', 'RINGCENTRAL']);
    // IT is told to check each account, SMS and call recording included, rather than assume it closed them.
    const tasks = (await agents.it.get(`/api/it/onboarding/${setup.id}`).set(headers).expect(200)).body.tasks as { key: string; description: string }[];
    expect(tasks.find(task => task.key === 'GOOGLE_WORKSPACE')!.description).toMatch(/^Their email was never closed through the workspace/);
    expect(tasks.find(task => task.key === 'RINGCENTRAL')!.description).toMatch(/^Their RingCentral user was never turned off/);
    for (const key of ['SMS', 'CALL_RECORDING']) expect(tasks.find(task => task.key === key)!.description).toMatch(/never turned off through the workspace/);
    expect((await profile(member.id)).accounts).toMatchObject({ companyEmail: 'rowan.work@example.test' });
    expect(await db.query(`SELECT 1 FROM it_account_requests WHERE "memberId" = $1`, [member.id])).toHaveLength(0);
  });

  it('asks IT to close an account it never closed when a rehire gets a new one or none', async () => {
    const [member] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",status,"joinedAt","leftAt") VALUES ('Rowan','Fictional','LEFT',now() - interval '400 days',now() - interval '60 days') RETURNING id`);
    const [mc] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Lakeside Carriers','lakeside carriers') RETURNING id`);
    await db.query(`INSERT INTO member_assignments ("memberId","mcId","startedAt","endedAt") VALUES ($1,$2,now() - interval '400 days',now() - interval '60 days')`, [member.id, mc.id]);
    await db.query(`INSERT INTO existing_member_records ("memberId","addedBy","companyEmail","ringCentralNumber","ringCentralExtension") VALUES ($1,$2,'rowan.work@example.test','+1 202 555 0177','177')`, [member.id, users.manager.id]);
    const [title] = await db.query(`INSERT INTO job_titles (name, "nameKey") VALUES ('Dispatcher', 'dispatcher') RETURNING id`);
    await act(member.id, 'rehire', { firstDay: ahead(0), position: 'DISPATCHER', mcId: mc.id, jobTitleId: title.id, email: 'NEW', closeEmailAction: 'ARCHIVE', ringCentral: 'NONE', businessSoftware: false, equipment: false });
    // Retired from their main accounts, and kept as their account at the MC they left while IT closes it.
    expect((await profile(member.id)).accounts?.companyEmail ?? null).toBeNull();
    const [account] = await db.query(`SELECT * FROM member_company_accounts WHERE "memberId" = $1`, [member.id]);
    expect(account).toMatchObject({ mcId: mc.id, companyEmail: 'rowan.work@example.test', ringCentralNumber: '+1 202 555 0177', ringCentralExtension: '177', status: 'ACTIVE', position: 'DISPATCHER' });
    const [request] = await db.query(`SELECT * FROM it_account_requests WHERE "memberId" = $1`, [member.id]);
    expect(request).toMatchObject({ kind: 'CLOSE', accountId: account.id, managerId: users.manager.id, emailAction: 'ARCHIVE', emailAfter: 'SUSPEND' });
    const keys = (await db.query(`SELECT key FROM it_account_tasks WHERE "requestId" = $1 ORDER BY key`, [request.id])).map((row: { key: string }) => row.key);
    // IT closes it as any account at another company (account-requests.integration covers finishing one).
    expect(keys).toEqual(['CLOSE_EMAIL', 'CLOSE_NUMBER', 'SHARED_PASSWORDS']);
    expect((await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'REHIRED' AND "memberId" = $1`, [member.id]))[0].metadata).toMatchObject({ closeAsked: true });
  });

  /** Rowan, added from a file as Left at Lakeside Carriers with an email and number a manager recorded and IT never closed. */
  const leftFromFile = async () => {
    const [member] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",status,"joinedAt","leftAt") VALUES ('Rowan','Fictional','LEFT',now() - interval '400 days',now() - interval '60 days') RETURNING id`);
    const [mc] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Lakeside Carriers','lakeside carriers') RETURNING id`);
    await db.query(`INSERT INTO member_assignments ("memberId","mcId","startedAt","endedAt") VALUES ($1,$2,now() - interval '400 days',now() - interval '60 days')`, [member.id, mc.id]);
    await db.query(`INSERT INTO existing_member_records ("memberId","addedBy","companyEmail","ringCentralNumber","ringCentralExtension") VALUES ($1,$2,'rowan.work@example.test','+1 202 555 0177','177')`, [member.id, users.manager.id]);
    const [title] = await db.query(`INSERT INTO job_titles (name, "nameKey") VALUES ('Dispatcher', 'dispatcher') RETURNING id`);
    return { memberId: member.id as string, mcId: mc.id as string, rehire: { firstDay: ahead(0), position: 'DISPATCHER', mcId: mc.id, jobTitleId: title.id, email: 'NEW', closeEmailAction: 'ARCHIVE', ringCentral: 'NONE', businessSoftware: false, equipment: false } };
  };
  const closeKeys = async (memberId: string) => (await db.query(`SELECT t.key FROM it_account_tasks t JOIN it_account_requests r ON r.id = t."requestId" WHERE r."memberId" = $1 ORDER BY t.key`, [memberId])).map((row: { key: string }) => row.key);

  it('keeps a support’s old account at the MC of the dispatcher they helped, not a made-up company', async () => {
    const dana = await dispatcher('Dana');
    const sky = await supportOf(dana.memberId);
    await db.query(`UPDATE dispatch_members SET status = 'LEFT', "leftAt" = now() - interval '1 day' WHERE id = $1`, [sky]);
    await db.query(`UPDATE member_support_links SET "endedAt" = now() - interval '1 day' WHERE "supportId" = $1`, [sky]);
    await db.query(`INSERT INTO existing_member_records ("memberId","addedBy","companyEmail") VALUES ($1,$2,'sky.work@example.test')`, [sky, users.manager.id]);
    await act(sky, 'rehire', { firstDay: ahead(0), position: 'SUPPORT', supportsMemberId: dana.memberId, email: 'NONE', ringCentral: 'NONE', businessSoftware: false, equipment: false });
    const [account] = await db.query(`SELECT a."companyName", m.name AS mc, a.position FROM member_company_accounts a LEFT JOIN mcs m ON m.id = a."mcId" WHERE a."memberId" = $1`, [sky]);
    expect(account).toEqual({ companyName: null, mc: 'Northwind Freight', position: 'SUPPORT' });
  });

  it('keeps an old email that still signs in to a load board seat, and asks IT to close only the number', async () => {
    const rowan = await leftFromFile();
    const dana = await dispatcher('Dana');
    const [dat] = await db.query(`INSERT INTO load_board_accounts (provider, name, "nameKey") VALUES ('DAT', 'Lakeside DAT', 'lakeside dat') RETURNING id`);
    await db.query(`INSERT INTO member_load_board_seats ("memberId","accountId","signInEmail","startedAt") VALUES ($1,$2,'rowan.work@example.test',now() - interval '5 days')`, [dana.memberId, dat.id]);
    const body = (await act(rowan.memberId, 'rehire', rowan.rehire)).body;
    expect(body.closeAsked).toBe(true);
    expect(await db.query(`SELECT "companyEmail", "ringCentralNumber", status FROM member_company_accounts WHERE "memberId" = $1 ORDER BY status`, [rowan.memberId])).toEqual([
      { companyEmail: null, ringCentralNumber: '+1 202 555 0177', status: 'ACTIVE' },
      { companyEmail: 'rowan.work@example.test', ringCentralNumber: null, status: 'KEPT_FOR_LOAD_BOARDS' }]);
    expect(await closeKeys(rowan.memberId)).toEqual(['CLOSE_NUMBER']);
  });

  it('leaves an old email already on one of their accounts at another company where it is, instead of failing the rehire', async () => {
    const rowan = await leftFromFile();
    await db.query(`INSERT INTO member_company_accounts ("memberId","companyName","companyEmail",status,"createdBy") VALUES ($1,'Harbor Logistics','rowan.work@example.test','KEPT_FOR_LOAD_BOARDS',$2)`, [rowan.memberId, users.manager.id]);
    await act(rowan.memberId, 'rehire', rowan.rehire);
    expect(await db.query(`SELECT "companyEmail", "ringCentralNumber", status FROM member_company_accounts WHERE "memberId" = $1 ORDER BY "createdAt"`, [rowan.memberId])).toEqual([
      { companyEmail: 'rowan.work@example.test', ringCentralNumber: null, status: 'KEPT_FOR_LOAD_BOARDS' },
      { companyEmail: null, ringCentralNumber: '+1 202 555 0177', status: 'ACTIVE' }]);
    expect(await closeKeys(rowan.memberId)).toEqual(['CLOSE_NUMBER']);
  });

  it('reads IT’s setup before the manager’s record, and lets a new email replace one that is someone else’s now', async () => {
    const taylor = await dispatcher('Taylor');
    // IT's setup has the number without an extension; the manager's record has an older email and another line's extension.
    await db.query(`INSERT INTO existing_member_records ("memberId","addedBy","companyEmail","ringCentralNumber","ringCentralExtension") VALUES ($1,$2,'taylor.old@example.test','+1 202 555 0100','190')`, [taylor.memberId, users.manager.id]);
    await db.query(`UPDATE dispatch_members SET status = 'LEFT', "leftAt" = now() - interval '10 days' WHERE id = $1`, [taylor.memberId]);
    await db.query(`UPDATE member_assignments SET "endedAt" = now() - interval '10 days' WHERE "memberId" = $1`, [taylor.memberId]);
    let offered = await options(taylor.memberId);
    expect(offered.email).toMatchObject({ value: 'taylor.work@example.test', restorable: true, notClosed: true });
    // The extension comes with its number, never another line's.
    expect(offered.ringCentral).toMatchObject({ number: '+1 202 555 0190', extension: null, notClosed: true });
    await db.query(`UPDATE existing_member_records SET "ringCentralNumber" = '+1 202 555 0190' WHERE "memberId" = $1`, [taylor.memberId]);
    expect((await options(taylor.memberId)).ringCentral).toMatchObject({ number: '+1 202 555 0190', extension: '190' });
    // Their email went to someone else meanwhile: it isn't theirs to restore, and a new one doesn't need IT to close it.
    const sam = await dispatcher('Sam');
    await db.query(`UPDATE it_onboarding_requests SET "companyEmail" = 'taylor.work@example.test', "assignedRingCentralPhoneNumber" = '+1 202 555 0191' WHERE id = $1`, [sam.setupId]);
    offered = await options(taylor.memberId);
    expect(offered.email).toMatchObject({ restorable: false, why: expect.stringMatching(/taylor\.work@example\.test is someone else’s now \(Sam Fictional\)/) });
    expect((await act(taylor.memberId, 'rehire', { firstDay: ahead(0), position: 'DISPATCHER', mcId: offered.rehire.previous.mcId, jobTitleId: (await db.query(`INSERT INTO job_titles (name, "nameKey") VALUES ('Dispatcher', 'dispatcher') RETURNING id`))[0].id,
      email: 'RESTORE', ringCentral: 'RESTORE', businessSoftware: false, equipment: false }, 400)).body.message).toMatch(/someone else’s now/);
    await act(taylor.memberId, 'rehire', { firstDay: ahead(0), position: 'DISPATCHER', mcId: offered.rehire.previous.mcId, jobTitleId: (await db.query(`SELECT id FROM job_titles WHERE "nameKey" = 'dispatcher'`))[0].id,
      email: 'NEW', ringCentral: 'RESTORE', businessSoftware: false, equipment: false });
    expect((await returnSetup(taylor.memberId)).profile.returning.notClosed).toEqual(['RINGCENTRAL']);
    // Sam's email isn't Taylor's to close.
    expect(await db.query(`SELECT 1 FROM it_account_requests WHERE "memberId" = $1`, [taylor.memberId])).toHaveLength(0);
  });

  it('asks IT to close an IT-setup number a rehire doesn’t get back, with no manager’s record and no removal', async () => {
    const taylor = await dispatcher('Taylor');
    await db.query(`UPDATE dispatch_members SET status = 'LEFT', "leftAt" = now() - interval '10 days' WHERE id = $1`, [taylor.memberId]);
    await db.query(`UPDATE member_assignments SET "endedAt" = now() - interval '10 days' WHERE "memberId" = $1`, [taylor.memberId]);
    const offered = await options(taylor.memberId);
    const [title] = await db.query(`INSERT INTO job_titles (name, "nameKey") VALUES ('Dispatcher', 'dispatcher') RETURNING id`);
    await act(taylor.memberId, 'rehire', { firstDay: ahead(0), position: 'DISPATCHER', mcId: offered.rehire.previous.mcId, jobTitleId: title.id, email: 'RESTORE', ringCentral: 'NONE', businessSoftware: false, equipment: false });
    const [request] = await db.query(`SELECT r.kind, a."ringCentralNumber", a."companyEmail" FROM it_account_requests r JOIN member_company_accounts a ON a.id = r."accountId" WHERE r."memberId" = $1`, [taylor.memberId]);
    expect(request).toMatchObject({ kind: 'CLOSE', ringCentralNumber: '+1 202 555 0190', companyEmail: null });
  });

  it('undoes a leaving that interrupted a rehire: the rehire checklist carries on with what IT had removed added to it', async () => {
    const taylor = await dispatcher('Taylor');
    await leave(taylor.memberId);
    await finishRemoval(taylor.memberId);
    await leftDaysAgo(taylor.memberId, 2);
    const [title] = await db.query(`INSERT INTO job_titles (name, "nameKey") VALUES ('Dispatcher', 'dispatcher') RETURNING id`);
    const { rehire: { previous } } = await options(taylor.memberId);
    await act(taylor.memberId, 'rehire', { firstDay: ahead(0), position: 'DISPATCHER', mcId: previous.mcId, jobTitleId: title.id, email: 'RESTORE', ringCentral: 'RESTORE', businessSoftware: false, equipment: false });
    const rehire = await returnSetup(taylor.memberId);
    // Marked as left again before IT finished; IT took them out of the Dispatch group and marked equipment Not needed.
    await leave(taylor.memberId);
    const second = await removalOf(taylor.memberId);
    await db.query(`UPDATE it_removal_tasks SET status = CASE key WHEN 'EQUIPMENT' THEN 'NOT_NEEDED' ELSE 'COMPLETED' END WHERE "requestId" = $1 AND key IN ('DISPATCH_GROUP','EQUIPMENT')`, [second.id]);
    await act(taylor.memberId, 'undo-leaving', { reason: 'Marked as left by mistake.' });
    const open = await db.query(`SELECT id FROM it_onboarding_requests WHERE "memberId" = $1 AND purpose IN ('REHIRE','RESTORE') AND "completedAt" IS NULL AND "cancelledAt" IS NULL`, [taylor.memberId]);
    expect(open).toEqual([{ id: rehire.id }]);
    const tasks = await setupTasks(rehire.id);
    expect(tasks).toContain('DISPATCH_GROUP');
    // Equipment IT marked Not needed is never given back.
    expect(tasks).not.toContain('EQUIPMENT');
    expect((await profile(taylor.memberId)).status).toBe('ONBOARDING');
  });

  it('brings back every setup the leaving cancelled, and never leaves a support stuck in Onboarding', async () => {
    const casey = await dispatcher('Casey', { setupDone: false });
    const [restore] = await db.query(`INSERT INTO it_onboarding_requests (purpose, "memberId", "managerId", "requestedBy", profile) VALUES ('RESTORE', $1, $2, $2, '{}') RETURNING id`, [casey.memberId, users.manager.id]);
    await leave(casey.memberId);
    expect(await db.query(`SELECT id FROM it_onboarding_requests WHERE id = ANY($1) AND "cancelledAt" IS NOT NULL`, [[casey.setupId, restore.id]])).toHaveLength(2);
    await act(casey.memberId, 'undo-leaving', { reason: 'Still starting.' });
    expect(await db.query(`SELECT id FROM it_onboarding_requests WHERE id = ANY($1) AND "cancelledAt" IS NULL`, [[casey.setupId, restore.id]])).toHaveLength(2);
    expect((await profile(casey.memberId)).status).toBe('ONBOARDING');
    // A support whose own setup comes back is Active again: finishing a support's setup activates nobody.
    const dana = await dispatcher('Dana');
    const sky = await supportOf(dana.memberId);
    await agents.manager.post(`/api/dispatch/members/${sky}/it-setup`).set(headers).send({ items: ['EQUIPMENT'] }).expect(201);
    await leave(sky);
    await act(sky, 'undo-leaving', { reason: 'Stayed.' });
    expect((await profile(sky)).status).toBe('ACTIVE');
  });

  it('counts a deleted email’s 20 days from when IT recorded Deleted, not from a later save', async () => {
    const taylor = await dispatcher('Taylor');
    await leave(taylor.memberId, { emailAction: 'DELETE' });
    const removalId = await finishRemoval(taylor.memberId, 'DELETED', 1);
    await db.query(`INSERT INTO it_removal_activity ("requestId", "actorId", event, metadata, "createdAt") VALUES ($1, $2, 'TASK_UPDATED', '{"key":"GOOGLE_WORKSPACE","emailDone":"DELETED"}', now() - interval '25 days')`, [removalId, users.it.id]);
    expect((await options(taylor.memberId)).email).toMatchObject({ was: 'DELETED', deletedOn: ahead(-25), restorable: false });
  });

  it('corrects a rehired person’s start date for this stay only, after the day they left', async () => {
    const lee = await dispatcher('Lee');
    await db.query(`INSERT INTO existing_member_records ("memberId","addedBy","startDateKnown","periodDateKnown") VALUES ($1,$2,false,false)`, [lee.memberId, users.manager.id]);
    await leave(lee.memberId);
    await finishRemoval(lee.memberId);
    const left = new Date(Date.parse(`${ahead(-10)}T12:00:00Z`));
    await db.query(`UPDATE dispatch_members SET "leftAt" = $2 WHERE id = $1`, [lee.memberId, left]);
    await db.query(`UPDATE member_assignments SET "endedAt" = $2 WHERE "memberId" = $1`, [lee.memberId, left]);
    const [first] = await db.query(`SELECT id, "startedAt" FROM member_assignments WHERE "memberId" = $1`, [lee.memberId]);
    const [title] = await db.query(`INSERT INTO job_titles (name, "nameKey") VALUES ('Dispatcher', 'dispatcher') RETURNING id`);
    const { rehire: { previous } } = await options(lee.memberId);
    await act(lee.memberId, 'rehire', { firstDay: ahead(0), position: 'DISPATCHER', mcId: previous.mcId, jobTitleId: title.id, email: 'NONE', ringCentral: 'NONE', businessSoftware: false, equipment: false });
    await act(lee.memberId, 'start-date', { startedOn: ahead(-20), reason: 'Before they left.' }, 400);
    await act(lee.memberId, 'start-date', { startedOn: ahead(-3), reason: 'They came back earlier.' });
    expect((await db.query(`SELECT "startedAt" FROM member_assignments WHERE id = $1`, [first.id]))[0].startedAt).toEqual(first.startedAt);
    expect((await profile(lee.memberId)).joinedAt.slice(0, 10)).toBe(ahead(-3));
  });

  it('refuses a rollback while anyone was brought back', async () => {
    const lee = await dispatcher('Lee');
    await leave(lee.memberId);
    await act(lee.memberId, 'undo-leaving', { reason: 'Mistake.' });
    const runner = db.createQueryRunner();
    const { BringBack1793380000000: Migration } = await import('../src/database/migrations/1793380000000-BringBack');
    await expect(new Migration().down(runner)).rejects.toThrow('Refusing to roll back while undone leavings');
    await runner.release();
  });
});
