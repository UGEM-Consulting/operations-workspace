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
import { ReviewService } from '../src/modules/onboarding/review.service';
import { addDays, usDay } from '../src/modules/safety/screening-rules';
import { completeMfa, enrolForTest } from './mfa-helpers';
type Agent = ReturnType<typeof request.agent>;
type Key = 'admin' | 'manager' | 'other' | 'it';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Dispatcher offboarding and manager hand-over (disposable PostgreSQL)', () => {
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
    .send({ version: await version(memberId), leftAt: new Date().toISOString().slice(0, 10), reason: 'Resigned for a job outside logistics.', ...body }).expect(status);
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
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `offboarding.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      // Administrators always use two-step verification: enrolled first, then the code after the password.
      const secret = key === 'admin' ? await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users[key].id) : null;
      const signedIn = await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password });
      expect([key, signedIn.status, signedIn.body.message ?? null]).toEqual([key, 200, null]);
      if (secret) expect((await completeMfa(agents[key], headers, db, users[key].id, secret)).status).toBe(200);
    }
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, it_removal_requests, users CASCADE'); await db.destroy(); } });

  it('opens an IT removal checklist when a dispatcher with IT setup leaves, keeps why, and alerts IT', async () => {
    const taylor = await dispatcher('Taylor');
    await leave(taylor.memberId, { emailAfter: 'FORWARD' });
    const removal = await removalOf(taylor.memberId);
    expect(removal).toMatchObject({ setupRequestId: taylor.setupId, managerId: users.manager.id, emailAfter: 'FORWARD', forwardTo: users.manager.id, completedAt: null,
      profile: { displayName: 'Taylor Fictional', companyEmail: 'taylor.work@example.test', ringCentralNumber: '+1 202 555 0190', mcName: 'Northwind Freight', teamName: null } });
    expect((await db.query(`SELECT key, status FROM it_removal_tasks WHERE "requestId" = $1 ORDER BY key`, [removal.id])).map((row: { key: string }) => row.key))
      .toEqual(['BUSINESS_SOFTWARE', 'DISPATCH_GROUP', 'EQUIPMENT', 'GOOGLE_WORKSPACE', 'RINGCENTRAL', 'SHARED_PASSWORDS']);
    // Telegram alert for every IT specialist (skipped here: no bot), naming no one.
    expect(await db.query(`SELECT kind, "recipientId", "referenceId", status FROM notification_deliveries`)).toEqual([{ kind: 'IT_REMOVAL_WAITING', recipientId: users.it.id, referenceId: removal.id, status: 'SKIPPED' }]);
    const member = (await agents.manager.get(`/api/dispatch/members/${taylor.memberId}`).set(headers).expect(200)).body;
    expect(member).toMatchObject({ status: 'LEFT', leftReason: 'Resigned for a job outside logistics.', leftBy: 'Fictional manager', removal: { id: removal.id, done: 0, total: 6, emailAfter: 'FORWARD' } });
    // The leaving event holds no reason or email choice.
    expect((await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'MEMBER_LEFT'`))[0].metadata).toEqual({ leadCleared: false, reasonGiven: true, itRemoval: true, signInOff: false });
  });

  it('cancels unfinished IT setup, skips forwarding without a mailbox, and opens nothing for someone without IT setup', async () => {
    const casey = await dispatcher('Casey', { setupDone: false });
    await leave(casey.memberId, { emailAfter: 'FORWARD' });
    expect((await removalOf(casey.memberId))).toMatchObject({ emailAfter: 'SUSPEND', forwardTo: null, profile: { companyEmail: null, setUpAt: null } });
    expect((await db.query(`SELECT "cancelledAt" IS NOT NULL AS cancelled FROM it_onboarding_requests WHERE id = $1`, [casey.setupId]))[0].cancelled).toBe(true);
    // The cancelled setup leaves IT's queue and can't be changed; the removal takes its place.
    const tasks = (await agents.it.get('/api/it/tasks').set(headers).expect(200)).body;
    expect(tasks.items.map((row: { kind: string; name: string }) => [row.kind, row.name])).toEqual([['REMOVAL', 'Casey Fictional']]);
    const setup = (await agents.it.get(`/api/it/onboarding/${casey.setupId}`).set(headers).expect(200)).body;
    await agents.it.patch(`/api/it/onboarding/${casey.setupId}/tasks/SMS`).set(headers).send({ version: setup.request.version, status: 'IN_PROGRESS' }).expect(409);
    // Someone who never had IT setup (a support, or a record with no application) gets no removal.
    const [support] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",position,"joinedAt") VALUES ('Sky','Support','SUPPORT',now() - interval '3 days') RETURNING id`);
    await leave(support.id);
    expect(await removalOf(support.id)).toBeUndefined();
  });

  it('turns a leaving team lead’s workspace sign-in off and ends their sessions', async () => {
    const lee = await dispatcher('Lee');
    const lead = await db.getRepository(User).save({ firstName: 'Lee', lastName: 'Lead', email: 'offboarding.lead@example.test', role: Role.TEAM_LEAD, status: UserStatus.ACTIVE, passwordHash: await hashPassword(password) });
    await db.query(`UPDATE dispatch_members SET "accountUserId" = $1 WHERE id = $2`, [lead.id, lee.memberId]);
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').set(headers).send({ email: lead.email, password }).expect(200);
    await leave(lee.memberId);
    expect((await db.getRepository(User).findOneByOrFail({ id: lead.id })).status).toBe(UserStatus.INACTIVE);
    await agent.get('/api/auth/me').set(headers).expect(401);
    expect((await db.query(`SELECT type, metadata FROM staff_security_events WHERE "userId" = $1`, [lead.id]))).toEqual([{ type: 'USER_STATUS_CHANGED', metadata: { fields: ['status'], sessionsRevoked: true, reason: 'member-left' } }]);
  });

  it('works through the removal: the number’s fate before RingCentral is done, then a portal notice for the manager', async () => {
    const taylor = await dispatcher('Taylor');
    await leave(taylor.memberId);
    const removal = await removalOf(taylor.memberId);
    let detail = (await agents.it.get(`/api/it/removals/${removal.id}`).set(headers).expect(200)).body;
    const task = (key: string, body: Record<string, unknown>) => agents.it.patch(`/api/it/removals/${removal.id}/tasks/${key}`).set(headers).send({ version: detail.request.version, ...body });
    await agents.manager.get(`/api/it/removals/${removal.id}`).set(headers).expect(403);
    await task('RINGCENTRAL', { status: 'COMPLETED' }).expect(400);
    await task('SHARED_PASSWORDS', { status: 'NOT_NEEDED' }).expect(400);
    await task('GOOGLE_WORKSPACE', { status: 'COMPLETED', numberOutcome: 'KEPT' }).expect(400);
    await task('BUSINESS_SOFTWARE', { status: 'BLOCKED' }).expect(400);
    for (const [key, body] of [['RINGCENTRAL', { status: 'COMPLETED', numberOutcome: 'KEPT' }], ['GOOGLE_WORKSPACE', { status: 'COMPLETED' }], ['DISPATCH_GROUP', { status: 'COMPLETED' }],
      ['BUSINESS_SOFTWARE', { status: 'COMPLETED', notes: 'Load board and TMS access removed.' }], ['SHARED_PASSWORDS', { status: 'COMPLETED' }]] as const) detail = (await task(key, body).expect(200)).body;
    expect(detail.request).toMatchObject({ status: 'IN_PROGRESS', numberOutcome: 'KEPT', completedAt: null });
    await agents.it.patch(`/api/it/removals/${removal.id}/tasks/EQUIPMENT`).set(headers).send({ version: detail.request.version - 1, status: 'NOT_NEEDED' }).expect(409);
    detail = (await task('EQUIPMENT', { status: 'NOT_NEEDED' }).expect(200)).body;
    expect(detail.request.status).toBe('COMPLETED');
    await task('EQUIPMENT', { status: 'COMPLETED' }).expect(409);
    const notices = (await agents.manager.get('/api/notifications').set(headers).expect(200)).body;
    expect(notices.items.map((item: Record<string, unknown>) => [item.kind, item.memberId, item.applicationId, item.displayName])).toEqual([['IT_REMOVAL_COMPLETED', taylor.memberId, null, 'Taylor Fictional']]);
    expect((await agents.manager.get(`/api/dispatch/members/${taylor.memberId}`).set(headers).expect(200)).body.removal).toMatchObject({ done: 6, total: 6, numberOutcome: 'KEPT' });
    expect((await db.query(`SELECT metadata FROM it_removal_activity WHERE event = 'TASK_UPDATED' AND metadata->>'key' = 'BUSINESS_SOFTWARE'`))[0].metadata).toEqual({ key: 'BUSINESS_SOFTWARE', previousStatus: 'PENDING', newStatus: 'COMPLETED' });
  });

  it('lists setups and removals together, removals due first, with the counts for each view', async () => {
    await dispatcher('Alex', { setupDone: false });
    const taylor = await dispatcher('Taylor');
    await leave(taylor.memberId);
    const list = (await agents.it.get('/api/it/tasks?view=open').set(headers).expect(200)).body;
    expect(list.items.map((row: { kind: string; name: string; done: number; total: number }) => [row.kind, row.name, row.done, row.total])).toEqual([['REMOVAL', 'Taylor Fictional', 0, 6], ['SETUP', 'Alex Fictional', 0, 7]]);
    expect(list.stats).toMatchObject({ open: 2, setup: 1, removal: 1, finished: 1, removalsDue: 1, setupsWaiting: 1, blocked: 0 });
    expect((await agents.it.get('/api/it/tasks?view=finished').set(headers).expect(200)).body.items.map((row: { name: string }) => row.name)).toEqual(['Taylor Fictional']);
    expect((await agents.it.get('/api/it/tasks?view=removal&search=nobody').set(headers).expect(200)).body.total).toBe(0);
    await agents.it.get('/api/it/tasks?view=sideways').set(headers).expect(400);
    await agents.manager.get('/api/it/tasks').set(headers).expect(403);
  });

  it('hands an application to another manager: theirs from then on, with the note on the history', async () => {
    const sam = await dispatcher('Sam', { setupDone: false });
    const change = (agent: Agent, body: Record<string, unknown>) => agent.post(`/api/onboarding/applications/${sam.applicationId}/manager`).set(headers).send(body);
    await change(agents.other, { managerId: users.other.id }).expect(404);
    await change(agents.manager, { managerId: users.manager.id }).expect(400);
    await change(agents.manager, { managerId: users.it.id }).expect(400);
    await change(agents.manager, { managerId: users.other.id, note: 'I’m out next week.' }).expect(201);
    await agents.manager.get(`/api/onboarding/applications/${sam.applicationId}`).set(headers).expect(404);
    const detail = (await agents.other.get(`/api/onboarding/applications/${sam.applicationId}`).set(headers).expect(200)).body;
    expect(detail.responsibleManager).toMatchObject({ id: users.other.id });
    expect(detail.managerChanges.map((row: Record<string, unknown>) => [row.reason, row.from, row.to, row.by, row.note])).toEqual([['CHANGED', 'Fictional manager', 'Fictional other', 'Fictional manager', 'I’m out next week.']]);
    expect(detail.managerOptions.map((row: { id: string }) => row.id).sort()).toEqual([users.admin.id, users.manager.id].sort());
    // The invitation and the unfinished IT setup move with it, so the setup notice reaches the new manager.
    expect((await db.query(`SELECT "managerId" FROM invitations WHERE id = $1`, [sam.invitationId]))[0].managerId).toBe(users.other.id);
    expect((await db.query(`SELECT "managerId" FROM it_onboarding_requests WHERE id = $1`, [sam.setupId]))[0].managerId).toBe(users.other.id);
    expect((await db.query(`SELECT event FROM application_activity WHERE "invitationId" = $1`, [sam.invitationId])).map((row: { event: string }) => row.event)).toEqual(['MANAGER_CHANGED']);
    // An administrator may hand over anyone's application.
    await change(agents.admin, { managerId: users.manager.id }).expect(201);
  });

  it('lets an administrator create an invitation another manager is responsible for; a manager only their own', async () => {
    const created = (await agents.admin.post('/api/onboarding/invitations').set(headers).send({ managerId: users.manager.id }).expect(201)).body;
    expect((await db.query(`SELECT i."managerId", a."assignedManagerId" FROM invitations i JOIN dispatcher_applications a ON a."invitationId" = i.id WHERE i.id = $1`, [created.id]))[0])
      .toEqual({ managerId: users.manager.id, assignedManagerId: users.manager.id });
    expect((await agents.manager.get('/api/onboarding/invitations').set(headers).expect(200)).body.map((row: { id: string }) => row.id)).toEqual([created.id]);
    await agents.manager.post('/api/onboarding/invitations').set(headers).send({ managerId: users.other.id }).expect(403);
    await agents.manager.post('/api/onboarding/invitations').set(headers).send({ managerId: users.manager.id }).expect(201);
    await agents.admin.post('/api/onboarding/invitations').set(headers).send({ managerId: users.it.id }).expect(400);
  });

  it('asks who takes over a manager’s open records before deactivating them, then moves them all together', async () => {
    await dispatcher('Unused', { status: 'INVITED' });
    // A revoked or expired invitation isn't open: it stays with them for the record.
    const revoked = await dispatcher('Revoked', { status: 'INVITED' });
    await db.query(`UPDATE invitations SET "revokedAt" = now() WHERE id = $1`, [revoked.invitationId]);
    await dispatcher('Draft', { status: 'DRAFT' });
    await dispatcher('Waiting', { status: 'CHANGES_REQUESTED' });
    const setup = await dispatcher('Setup', { setupDone: false });
    const finished = await dispatcher('Finished');
    await dispatcher('Rejected', { status: 'REJECTED' });
    expect((await agents.admin.get(`/api/users/${users.manager.id}/open-records`).set(headers).expect(200)).body).toEqual({ invitations: 1, applications: 1, changes: 1, itSetup: 1, removals: 0, total: 4 });
    await agents.manager.get(`/api/users/${users.manager.id}/open-records`).set(headers).expect(403);
    const refused = await agents.admin.patch(`/api/users/${users.manager.id}`).set(headers).send({ status: 'INACTIVE' }).expect(409);
    expect(refused.body.openRecords).toEqual({ invitations: 1, applications: 1, changes: 1, itSetup: 1, removals: 0, total: 4 });
    expect((await db.getRepository(User).findOneByOrFail({ id: users.manager.id })).status).toBe(UserStatus.ACTIVE);
    await agents.admin.patch(`/api/users/${users.manager.id}`).set(headers).send({ status: 'INACTIVE', handOverTo: users.manager.id }).expect(400);
    await agents.admin.patch(`/api/users/${users.manager.id}`).set(headers).send({ status: 'INACTIVE', handOverTo: users.it.id }).expect(400);
    const saved = (await agents.admin.patch(`/api/users/${users.manager.id}`).set(headers).send({ status: 'INACTIVE', handOverTo: users.other.id }).expect(200)).body;
    expect(saved).toMatchObject({ status: 'INACTIVE', handedOver: 4 });
    const owners = await db.query(`SELECT a.fields->>'lastName' AS name, a."assignedManagerId" = $1 AS moved FROM dispatcher_applications a ORDER BY 1`, [users.other.id]);
    expect(owners).toEqual([{ name: 'Draft', moved: true }, { name: 'Finished', moved: false }, { name: 'Rejected', moved: false }, { name: 'Revoked', moved: false }, { name: 'Setup', moved: true }, { name: 'Unused', moved: true }, { name: 'Waiting', moved: true }]);
    expect((await db.query(`SELECT "managerId" FROM it_onboarding_requests WHERE id = $1`, [setup.setupId]))[0].managerId).toBe(users.other.id);
    expect((await db.query(`SELECT "managerId" FROM it_onboarding_requests WHERE id = $1`, [finished.setupId]))[0].managerId).toBe(users.manager.id);
    expect((await db.query(`SELECT reason, note, "actorId" FROM application_manager_changes`)).every((row: { reason: string; note: string | null; actorId: string }) => row.reason === 'HANDED_OVER' && row.note === null && row.actorId === users.admin.id)).toBe(true);
    // Nothing open is left, so another change needs no hand-over.
    await agents.admin.patch(`/api/users/${users.other.id}`).set(headers).send({ role: 'IT_SPECIALIST' }).expect(409);
  });

  it('hands over open removals: the notice and forwarding follow, and IT is told only if forwarding was already started', async () => {
    const started = await dispatcher('Started'), untouched = await dispatcher('Untouched'), done = await dispatcher('Done');
    for (const person of [started, untouched, done]) await leave(person.memberId, { emailAfter: 'FORWARD' });
    const [startedRemoval, untouchedRemoval, doneRemoval] = await Promise.all([started, untouched, done].map(person => removalOf(person.memberId)));
    await agents.it.patch(`/api/it/removals/${startedRemoval.id}/tasks/GOOGLE_WORKSPACE`).set(headers).send({ version: startedRemoval.version, status: 'COMPLETED' }).expect(200);
    await db.query(`UPDATE it_removal_requests SET "completedAt" = now(), "numberOutcome" = 'KEPT' WHERE id = $1`, [doneRemoval.id]);
    expect((await agents.admin.get(`/api/users/${users.manager.id}/open-records`).set(headers).expect(200)).body).toEqual({ invitations: 0, applications: 0, changes: 0, itSetup: 0, removals: 2, total: 2 });
    await agents.admin.patch(`/api/users/${users.manager.id}`).set(headers).send({ status: 'INACTIVE' }).expect(409);
    expect((await agents.admin.patch(`/api/users/${users.manager.id}`).set(headers).send({ status: 'INACTIVE', handOverTo: users.other.id }).expect(200)).body.handedOver).toBe(2);
    const detail = (await agents.it.get(`/api/it/removals/${startedRemoval.id}`).set(headers).expect(200)).body;
    expect(detail.request).toMatchObject({ managerId: users.other.id, forwardTo: users.other.id, createdBy: users.manager.id, forwardToName: 'Fictional other', recordedByName: 'Fictional manager', version: startedRemoval.version + 2 });
    expect(detail.activity.at(-1)).toMatchObject({ event: 'MANAGER_HANDED_OVER', actorId: users.admin.id, metadata: { forwardChanged: true, forwardingStarted: true } });
    expect((await agents.it.get(`/api/it/removals/${untouchedRemoval.id}`).set(headers).expect(200)).body.activity.at(-1).metadata).toEqual({ forwardChanged: true, forwardingStarted: false });
    // A finished removal stays as it was.
    expect(await removalOf(done.memberId)).toMatchObject({ managerId: users.manager.id, forwardTo: users.manager.id });
    // The completion notice reaches whoever took over.
    let version = detail.request.version;
    for (const [key, body] of [['DISPATCH_GROUP', { status: 'COMPLETED' }], ['RINGCENTRAL', { status: 'COMPLETED', numberOutcome: 'KEPT' }], ['BUSINESS_SOFTWARE', { status: 'COMPLETED' }], ['SHARED_PASSWORDS', { status: 'COMPLETED' }], ['EQUIPMENT', { status: 'NOT_NEEDED' }]] as const)
      version = (await agents.it.patch(`/api/it/removals/${startedRemoval.id}/tasks/${key}`).set(headers).send({ version, ...body }).expect(200)).body.request.version;
    expect((await db.query(`SELECT "recipientId" FROM portal_notifications WHERE "removalId" = $1`, [startedRemoval.id]))[0].recipientId).toBe(users.other.id);
  });

  it('refuses to make a manager being deactivated responsible: the check waits for the account change', async () => {
    const waiting = await dispatcher('Waiting', { status: 'SUBMITTED' });
    const runner = db.createQueryRunner(); await runner.connect(); await runner.startTransaction();
    await runner.query(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [users.other.id]);
    const change = agents.manager.post(`/api/onboarding/applications/${waiting.applicationId}/manager`).set(headers).send({ managerId: users.other.id }).then(response => response.status);
    await new Promise(resolve => setTimeout(resolve, 200));
    await runner.commitTransaction(); await runner.release();
    expect(await change).toBe(400);
    expect((await db.query(`SELECT "assignedManagerId" FROM dispatcher_applications WHERE id = $1`, [waiting.applicationId]))[0].assignedManagerId).toBe(users.manager.id);
  });

  it('says a team lead’s sign-in is off when a later last day keeps them here', async () => {
    const lee = await dispatcher('Lee');
    await supportOf(lee.memberId);
    const lead = await db.getRepository(User).save({ firstName: 'Lee', lastName: 'Lead', email: 'offboarding.lead@example.test', role: Role.TEAM_LEAD, status: UserStatus.ACTIVE, passwordHash: await hashPassword(password) });
    await db.query(`UPDATE dispatch_members SET "accountUserId" = $1 WHERE id = $2`, [lead.id, lee.memberId]);
    const profile = async () => (await agents.manager.get(`/api/dispatch/members/${lee.memberId}`).set(headers).expect(200)).body;
    await leave(lee.memberId, { leftAt: ahead(12) });
    expect((await profile()).signInOff).toBe(false);
    await db.query(`UPDATE member_notices SET "lastDay" = '${addDays(usDay('earliest'), -2)}'`);
    await app.get(LeavingSweeper).run();
    await act(lee.memberId, 'last-day', { lastDay: ahead(14), reason: 'Staying two more weeks.' });
    expect(await profile()).toMatchObject({ signInOff: true, notice: { passed: false } });
    // Nothing turns it back on by itself; once an administrator does, the warning goes.
    expect((await db.getRepository(User).findOneByOrFail({ id: lead.id })).status).toBe(UserStatus.INACTIVE);
    await db.getRepository(User).update(lead.id, { status: UserStatus.ACTIVE });
    expect((await profile()).signInOff).toBe(false);
  });

  it('refuses a promotion request for a support on notice and leaves leaving dispatchers out of the support choices', async () => {
    const lee = await dispatcher('Lee'), other = await dispatcher('Other');
    const support = await supportOf(lee.memberId);
    const [team] = await db.query(`INSERT INTO teams (name,"nameKey","mcId","leadMemberId") SELECT 'Lee team','lee team',id,$1 FROM mcs LIMIT 1 RETURNING id`, [lee.memberId]);
    await db.query(`UPDATE member_assignments SET "teamId" = $1 WHERE "memberId" = $2`, [team.id, lee.memberId]);
    const leadUser = await db.getRepository(User).save({ firstName: 'Lee', lastName: 'Lead', email: 'offboarding.lead@example.test', role: Role.TEAM_LEAD, status: UserStatus.ACTIVE, passwordHash: await hashPassword(password) });
    await db.query(`UPDATE dispatch_members SET "accountUserId" = $1 WHERE id = $2`, [leadUser.id, lee.memberId]);
    const leadAgent = request.agent(app.getHttpServer());
    await leadAgent.post('/api/auth/login').set(headers).send({ email: leadUser.email, password }).expect(200);
    await act(support, 'leave', { leftAt: ahead(5), reason: 'Moving away.' });
    const refused = await leadAgent.post('/api/team/promotions').set(headers).send({ supportId: support, reason: 'Ready to dispatch.' }).expect(409);
    expect(refused.body.message).toMatch(/leaving/);
    await leave(other.memberId, { leftAt: ahead(5) });
    const options = (await app.get(ReviewService).dispatcherOptions(null) as { id: string }[]).map(option => option.id);
    expect(options).toContain(lee.memberId); expect(options).not.toContain(other.memberId);
    // One already picked stays listed, marked, so the manager can see why it needs changing.
    expect(await app.get(ReviewService).dispatcherOptions(other.memberId)).toContainEqual(expect.objectContaining({ id: other.memberId, leaving: true }));
  });

  it('tells the manager on the application when IT setup was cancelled because the dispatcher left', async () => {
    const setup = await dispatcher('Setup', { setupDone: false });
    const view = async () => (await agents.manager.get(`/api/onboarding/applications/${setup.applicationId}`).set(headers).expect(200)).body.itOnboarding;
    expect((await view()).cancelledAt).toBeNull();
    await leave(setup.memberId);
    expect((await view()).cancelledAt).toEqual(expect.any(String));
  });

  it('records notice for a future last day: still Active, their people stay, and IT can plan but not finish', async () => {
    const taylor = await dispatcher('Taylor');
    const support = await supportOf(taylor.memberId);
    const lastDay = ahead(12);
    await leave(taylor.memberId, { leftAt: ahead(91) }, 400);
    await leave(taylor.memberId, { leftAt: lastDay, emailAfter: 'FORWARD' });
    await leave(taylor.memberId, { leftAt: ahead(5) }, 409);
    const member = (await agents.manager.get(`/api/dispatch/members/${taylor.memberId}`).set(headers).expect(200)).body;
    expect(member).toMatchObject({ status: 'ACTIVE', leftAt: null, notice: { lastDay, passed: false, recordedBy: 'Fictional manager' }, removal: { dueOn: lastDay, scheduled: true, done: 0, total: 6 } });
    expect(member.supports.map((row: { id: string }) => row.id)).toEqual([support]);
    expect(await alerts()).toEqual(['IT_REMOVAL_SCHEDULED']);
    const row = (await agents.manager.get('/api/dispatch/members').set(headers).expect(200)).body.items.find((item: { id: string }) => item.id === taylor.memberId);
    expect(row).toMatchObject({ status: 'ACTIVE', lastDay, lastDayPassed: false, driversToReassign: 0, supportsToReassign: 1, itRemoval: 'SCHEDULED' });
    // Nobody new is placed with someone leaving.
    await agents.manager.post(`/api/dispatch/members/${support}/reassign`).set(headers).send({ version: await version(support), dispatcherId: taylor.memberId, startedAt: usDay('earliest'), reason: 'Testing.' }).expect(400);
    // IT plans; nothing can be completed yet.
    const removal = await removalOf(taylor.memberId);
    let detail = (await agents.it.get(`/api/it/removals/${removal.id}`).set(headers).expect(200)).body;
    expect(detail.request.scheduled).toBe(true);
    const task = (key: string, body: Record<string, unknown>) => agents.it.patch(`/api/it/removals/${removal.id}/tasks/${key}`).set(headers).send({ version: detail.request.version, ...body });
    await task('GOOGLE_WORKSPACE', { status: 'COMPLETED' }).expect(400);
    await task('EQUIPMENT', { status: 'NOT_NEEDED' }).expect(400);
    detail = (await task('BUSINESS_SOFTWARE', { status: 'IN_PROGRESS', notes: 'Planning for the last day.' }).expect(200)).body;
    const list = (await agents.it.get('/api/it/tasks?view=scheduled').set(headers).expect(200)).body;
    expect(list.items.map((item: { name: string; scheduled: boolean; dueOn: string }) => [item.name, item.scheduled, item.dueOn])).toEqual([['Taylor Fictional', true, lastDay]]);
    expect(list.stats).toMatchObject({ scheduled: 1, nextScheduled: lastDay, removal: 0, removalsDue: 0 });
    expect((await agents.it.get('/api/it/tasks?view=removal').set(headers).expect(200)).body.total).toBe(0);
    expect((await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'NOTICE_RECORDED'`))[0].metadata).toEqual({ itRemoval: true });
  });

  it('refuses a future last day during IT setup, but not for a support', async () => {
    const casey = await dispatcher('Casey', { setupDone: false });
    await leave(casey.memberId, { leftAt: ahead(5) }, 400);
    const [support] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",position,"joinedAt") VALUES ('Sky','Support','SUPPORT',now() - interval '3 days') RETURNING id`);
    await leave(support.id, { leftAt: ahead(5) });
    expect(await removalOf(support.id)).toBeUndefined();
    await act(support.id, 'remove-access', { reason: 'No accounts.' }, 400);
  });

  it('moves the last day with the checklist, and cancels a notice only while IT hasn’t started', async () => {
    const taylor = await dispatcher('Taylor');
    await leave(taylor.memberId, { leftAt: ahead(12) });
    await act(taylor.memberId, 'last-day', { lastDay: ahead(-1), reason: 'Earlier.' }, 400);
    await act(taylor.memberId, 'last-day', { lastDay: ahead(12), reason: 'The same.' }, 400);
    await act(taylor.memberId, 'last-day', { lastDay: ahead(19), reason: 'Handing over loads.' });
    const removal = await removalOf(taylor.memberId);
    expect(removal.dueOn).toBe(ahead(19));
    await act(taylor.memberId, 'cancel-notice', { reason: 'Accepted a counteroffer.' });
    const member = (await agents.manager.get(`/api/dispatch/members/${taylor.memberId}`).set(headers).expect(200)).body;
    expect(member).toMatchObject({ status: 'ACTIVE', notice: null, removal: null });
    expect(member.noticeHistory).toMatchObject([{ reason: 'Resigned for a job outside logistics.', cancelledBy: 'Fictional manager', cancelReason: 'Accepted a counteroffer.', changes: [{ from: ahead(12), to: ahead(19), reason: 'Handing over loads.' }] }]);
    expect((await agents.it.get('/api/it/tasks?view=scheduled').set(headers).expect(200)).body.total).toBe(0);
    await agents.it.patch(`/api/it/removals/${removal.id}/tasks/SMS`).set(headers).send({ version: removal.version + 1, status: 'IN_PROGRESS' }).expect(404);
    const again = (await agents.it.get(`/api/it/removals/${removal.id}`).set(headers).expect(200)).body;
    await agents.it.patch(`/api/it/removals/${removal.id}/tasks/EQUIPMENT`).set(headers).send({ version: again.request.version, status: 'IN_PROGRESS' }).expect(409);
    await act(taylor.memberId, 'cancel-notice', { reason: 'Twice.' }, 409);
    // A second notice is a new one; once IT has started, it can't be cancelled from here.
    await leave(taylor.memberId, { leftAt: ahead(30) });
    const open = (await db.query(`SELECT id, version FROM it_removal_requests WHERE "memberId" = $1 AND "cancelledAt" IS NULL`, [taylor.memberId]))[0];
    expect(open.id).not.toBe(removal.id);
    await agents.it.patch(`/api/it/removals/${open.id}/tasks/DISPATCH_GROUP`).set(headers).send({ version: open.version, status: 'IN_PROGRESS' }).expect(200);
    await act(taylor.memberId, 'cancel-notice', { reason: 'Too late.' }, 409);
  });

  it('removes access now on request: due today, IT alerted, a team lead’s sign-in off, without waiting for reassignment', async () => {
    const lee = await dispatcher('Lee');
    await supportOf(lee.memberId);
    const lead = await db.getRepository(User).save({ firstName: 'Lee', lastName: 'Lead', email: 'offboarding.lead@example.test', role: Role.TEAM_LEAD, status: UserStatus.ACTIVE, passwordHash: await hashPassword(password) });
    await db.query(`UPDATE dispatch_members SET "accountUserId" = $1 WHERE id = $2`, [lead.id, lee.memberId]);
    await leave(lee.memberId, { leftAt: ahead(12) });
    expect((await db.getRepository(User).findOneByOrFail({ id: lead.id })).status).toBe(UserStatus.ACTIVE);
    await act(lee.memberId, 'remove-access', { reason: 'Asked to stop work immediately.' });
    expect((await db.getRepository(User).findOneByOrFail({ id: lead.id })).status).toBe(UserStatus.INACTIVE);
    const removal = await removalOf(lee.memberId);
    expect(removal).toMatchObject({ dueOn: usDay('latest'), removeNowReason: 'Asked to stop work immediately.' });
    expect(await alerts()).toEqual(['IT_REMOVAL_SCHEDULED', 'IT_REMOVAL_NOW']);
    await act(lee.memberId, 'remove-access', { reason: 'Twice.' }, 409);
    await act(lee.memberId, 'cancel-notice', { reason: 'Too late.' }, 409);
    // The last day stays, and IT can finish now.
    expect((await agents.manager.get(`/api/dispatch/members/${lee.memberId}`).set(headers).expect(200)).body).toMatchObject({ status: 'ACTIVE', notice: { lastDay: ahead(12) }, removal: { scheduled: false } });
    await agents.it.patch(`/api/it/removals/${removal.id}/tasks/GOOGLE_WORKSPACE`).set(headers).send({ version: removal.version, status: 'COMPLETED' }).expect(200);
    expect((await agents.it.get('/api/it/tasks?view=removal').set(headers).expect(200)).body.total).toBe(1);
  });

  it('runs the last day: alerts IT once, waits for reassignment to mark them as left, and dates it their last day', async () => {
    const taylor = await dispatcher('Taylor');
    const support = await supportOf(taylor.memberId);
    const lead = await db.getRepository(User).save({ firstName: 'Taylor', lastName: 'Lead', email: 'offboarding.lead@example.test', role: Role.TEAM_LEAD, status: UserStatus.ACTIVE, passwordHash: await hashPassword(password) });
    await db.query(`UPDATE dispatch_members SET "accountUserId" = $1 WHERE id = $2`, [lead.id, taylor.memberId]);
    await leave(taylor.memberId, { leftAt: ahead(12) });
    const sweeper = app.get(LeavingSweeper);
    // Not yet: nothing happens.
    expect(await sweeper.run()).toEqual({ alerted: 0, left: 0, failed: 0 });
    // The day has begun in the US: IT is alerted once; they aren't gone until the day has ended everywhere.
    await db.query(`UPDATE member_notices SET "lastDay" = $1; UPDATE it_removal_requests SET "dueOn" = $1`.replace(/\$1/g, `'${usDay('latest')}'`));
    expect(await sweeper.run()).toEqual({ alerted: 1, left: 0, failed: 0 });
    expect(await sweeper.run()).toEqual({ alerted: 0, left: 0, failed: 0 });
    expect(await alerts()).toEqual(['IT_REMOVAL_SCHEDULED', 'IT_REMOVAL_DUE']);
    expect((await db.getRepository(User).findOneByOrFail({ id: lead.id })).status).toBe(UserStatus.ACTIVE);
    // The day has passed with a support still assigned: the record waits, the sign-in doesn't.
    const past = addDays(usDay('earliest'), -2);
    await db.query(`UPDATE member_notices SET "lastDay" = '${past}'`);
    expect(await sweeper.run()).toEqual({ alerted: 0, left: 0, failed: 0 });
    expect((await db.getRepository(User).findOneByOrFail({ id: lead.id })).status).toBe(UserStatus.INACTIVE);
    expect((await agents.manager.get(`/api/dispatch/members/${taylor.memberId}`).set(headers).expect(200)).body).toMatchObject({ status: 'ACTIVE', notice: { passed: true } });
    await act(taylor.memberId, 'cancel-notice', { reason: 'Too late.' }, 409);
    // Reassigned: the next run marks them as left, dated their last day, with the reason given.
    await db.query(`UPDATE member_support_links SET "endedAt" = now() WHERE "supportId" = $1`, [support]);
    expect(await sweeper.run()).toEqual({ alerted: 0, left: 1, failed: 0 });
    const member = (await agents.manager.get(`/api/dispatch/members/${taylor.memberId}`).set(headers).expect(200)).body;
    expect(member).toMatchObject({ status: 'LEFT', leftReason: 'Resigned for a job outside logistics.', notice: null, leftBy: 'Fictional manager' });
    expect(member.leftAt.slice(0, 10)).toBe(past);
    expect((await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'MEMBER_LEFT'`))[0].metadata).toMatchObject({ itRemoval: true });
    expect(await sweeper.run()).toEqual({ alerted: 0, left: 0, failed: 0 });
  });

  it('refuses to roll back while offboarding or hand-over history exists', async () => {
    const taylor = await dispatcher('Taylor');
    await leave(taylor.memberId);
    await db.undoLastMigration(); // WholeTeamSupports, with none here
    await db.undoLastMigration(); // AccountDetails, with none here
    await db.undoLastMigration(); // SupportTypes, with none here
    await db.undoLastMigration(); // DocumentAmericanName, with none here
    await db.undoLastMigration(); // MissingDetails, with none here
    await db.undoLastMigration(); // DocumentFields, with none placed here
    await db.undoLastMigration(); // ExistingDispatchers, with none added here
    expect((await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name).toBe('DispatcherOffboarding1792950000000');
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard dispatcher offboarding or manager hand-over history');
    await db.query(`DELETE FROM portal_notifications WHERE "removalId" IS NOT NULL; DELETE FROM notification_deliveries WHERE kind LIKE 'IT_REMOVAL%'; DELETE FROM member_notices; DELETE FROM it_removal_activity; DELETE FROM it_removal_tasks; DELETE FROM it_removal_requests; DELETE FROM application_manager_changes; UPDATE it_onboarding_requests SET "cancelledAt" = NULL; UPDATE dispatch_members SET "leftReason" = NULL`);
    try { await db.undoLastMigration(); expect((await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name).toBe('DriverHistory1792940000000'); }
    finally { await db.runMigrations(); }
  });
});
