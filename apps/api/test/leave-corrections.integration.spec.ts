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
import { CompanyAccountsModule } from '../src/modules/company-accounts/company-accounts.module';
import { LeaveService } from '../src/modules/dispatch/leave.service';
import { refuseSecondApplication } from '../src/modules/onboarding/already-here';
import { addDays, usDay } from '../src/modules/safety/screening-rules';
import { completeMfa, enrolForTest } from './mfa-helpers';
type Agent = ReturnType<typeof request.agent>;
type Key = 'admin' | 'manager' | 'it';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Leave, corrections and the already-here check (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url');
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  const fieldsFor = (name: string, phone: string) => ({ firstName: 'Legal', lastName: name, preferredAmericanFirstName: name, preferredAmericanLastName: 'Fictional', personalPhoneNumber: phone,
    mcName: 'Northwind Freight', teamLead: 'Independent', jobTitle: 'Dispatcher' });
  /** An approved dispatcher with finished IT setup (a company email and number) and a place under the MC. */
  async function dispatcher(name: string, options: { phone?: string; status?: 'ACTIVE' | 'LEFT' } = {}) {
    const email = `${name.toLowerCase()}@example.test`, fields = fieldsFor(name, options.phone ?? '+1 202 555 0101');
    const [inv] = await db.query(`INSERT INTO invitations ("managerId","tokenHash","mcName","teamLead","jobTitle","expiresAt","telegramRequired",email,"consumedAt") VALUES ($1,$2,'Northwind Freight','Independent','Dispatcher',now()+interval '7 days',false,$3,now()) RETURNING id`,
      [users.manager.id, randomBytes(32).toString('hex'), email]);
    const [application] = await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"applicantAccessUntil","submittedAt") VALUES ($1,$2,'APPROVED',$3,3,now()+interval '7 days',now()) RETURNING id`, [inv.id, users.manager.id, fields]);
    await db.query(`INSERT INTO application_submissions ("applicationId",version,fields) VALUES ($1,1,$2)`, [application.id, fields]);
    const [review] = await db.query(`INSERT INTO application_reviews ("applicationId","reviewerId","decisionType","requestedFields","previousStatus","newStatus","applicationVersion",employment) VALUES ($1,$2,'APPROVE','[]','SUBMITTED','APPROVED',3,$3) RETURNING id`,
      [application.id, users.manager.id, { mcName: 'Northwind Freight', teamLead: 'Independent', jobTitle: 'Dispatcher' }]);
    const [setup] = await db.query(`INSERT INTO it_onboarding_requests ("applicationId","approvalId","managerId",profile,"companyEmail","assignedRingCentralPhoneNumber","completedAt") VALUES ($1,$2,$3,$4,$5,'+1 202 555 0190',now()) RETURNING id`,
      [application.id, review.id, users.manager.id, { proposedDisplayName: `${name} Fictional`, personalEmail: email, mcName: 'Northwind Freight', teamLead: 'Independent', jobTitle: 'Dispatcher' }, `${name.toLowerCase()}.work@example.test`]);
    for (const key of ['GOOGLE_WORKSPACE', 'DISPATCH_GROUP', 'RINGCENTRAL', 'SMS', 'CALL_RECORDING', 'BUSINESS_SOFTWARE', 'EQUIPMENT']) await db.query(`INSERT INTO it_onboarding_tasks ("requestId",key,status) VALUES ($1,$2,'COMPLETED')`, [setup.id, key]);
    const [member] = await db.query(`INSERT INTO dispatch_members ("applicationId","firstName","lastName",status,"joinedAt","leftAt") VALUES ($1,$2,'Fictional',$3,now() - interval '30 days',$4) RETURNING id`,
      [application.id, name, options.status ?? 'ACTIVE', options.status === 'LEFT' ? new Date(Date.now() - 86400000) : null]);
    await db.query(`INSERT INTO member_assignments ("memberId","mcId","startedAt","endedAt") VALUES ($1,$2,now() - interval '30 days',$3)`, [member.id, await mcId(), options.status === 'LEFT' ? new Date(Date.now() - 86400000) : null]);
    return { applicationId: application.id as string, memberId: member.id as string, setupId: setup.id as string };
  }
  async function mcId() {
    await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Northwind Freight','northwind freight') ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Dispatcher','dispatcher') ON CONFLICT DO NOTHING`);
    return (await db.query(`SELECT id FROM mcs WHERE "nameKey" = 'northwind freight'`))[0].id as string;
  }
  /** A submitted application waiting for a decision, claimed with this email. */
  async function submitted(name: string, email: string, phone: string) {
    const fields = fieldsFor(name, phone);
    const [inv] = await db.query(`INSERT INTO invitations ("managerId","tokenHash","expiresAt","telegramRequired",email,"consumedAt") VALUES ($1,$2,now()+interval '7 days',false,$3,now()) RETURNING id`, [users.manager.id, randomBytes(32).toString('hex'), email]);
    const [application] = await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"applicantAccessUntil","submittedAt") VALUES ($1,$2,'SUBMITTED',$3,2,now()+interval '7 days',now()) RETURNING id`, [inv.id, users.manager.id, fields]);
    await db.query(`INSERT INTO application_submissions ("applicationId",version,fields) VALUES ($1,1,$2)`, [application.id, fields]);
    await mcId();
    return { applicationId: application.id as string, invitationId: inv.id as string };
  }
  const approve = (applicationId: string, extra: Record<string, unknown> = {}) => agents.manager.post(`/api/onboarding/applications/${applicationId}/reviews`).set(headers)
    .send({ version: 2, decisionType: 'APPROVE', requestedFields: [], confirmed: true, employmentConfirmed: true, employment: { mcName: 'Northwind Freight', teamLead: 'Independent', jobTitle: 'Dispatcher' }, ...extra });
  const version = async (memberId: string) => (await db.query(`SELECT version FROM dispatch_members WHERE id = $1`, [memberId]))[0].version as number;
  const act = async (agent: Agent, memberId: string, path: string, body: Record<string, unknown>, status = 201) =>
    agent.post(`/api/dispatch/members/${memberId}/${path}`).set(headers).send({ version: await version(memberId), ...body }).expect(status);
  const alerts = async () => (await db.query(`SELECT kind FROM notification_deliveries ORDER BY "createdAt"`)).map((row: { kind: string }) => row.kind);

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, OnboardingModule, ItModule, DispatchModule, CompanyAccountsModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, notification_deliveries, it_removal_requests, member_leaves CASCADE');
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['admin', Role.SYSTEM_ADMIN], ['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `leave.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      const secret = key === 'admin' ? await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users[key].id) : null;
      const signedIn = await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password });
      expect([key, signedIn.status, signedIn.body.message ?? null]).toEqual([key, 200, null]);
      if (secret) expect((await completeMfa(agents[key], headers, db, users[key].id, secret)).status).toBe(200);
    }
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, it_removal_requests, member_leaves, users CASCADE'); await db.destroy(); } });

  describe('already here (section 37)', () => {
    it('refuses approval when the email belongs to someone working here, and shows the match', async () => {
      const riley = await dispatcher('Riley');
      const { applicationId, invitationId } = await submitted('Sam', 'riley@example.test', '+1 303 555 0177');
      const detail = (await agents.manager.get(`/api/onboarding/applications/${applicationId}`).set(headers).expect(200)).body;
      expect(detail.alreadyHere).toEqual([expect.objectContaining({ on: 'EMAIL', kind: 'MEMBER', memberId: riley.memberId, name: 'Riley Fictional', status: 'ACTIVE' })]);
      const invitations = (await agents.manager.get('/api/onboarding/invitations').set(headers).expect(200)).body;
      expect(invitations.find((row: { id: string }) => row.id === invitationId).alreadyHere).toMatchObject({ name: 'Riley Fictional', status: 'ACTIVE' });
      expect((await approve(applicationId, { differentPerson: true }).expect(400)).body.message).toContain('belongs to Riley Fictional, who works here now');
    });
    it('asks for “a different person” when only the phone matches, and links someone coming back to the record they left', async () => {
      await dispatcher('Riley', { phone: '(202) 555-0101' });
      const sam = await submitted('Sam', 'sam@example.test', '+1 202 555 0101');
      expect((await approve(sam.applicationId).expect(400)).body.message).toContain('Their phone matches Riley Fictional');
      await approve(sam.applicationId, { differentPerson: true }).expect(201);
      const jesse = await dispatcher('Jesse', { status: 'LEFT', phone: '+1 404 555 0100' });
      const back = await submitted('Jesse', 'jesse@example.test', '+1 404 555 0100');
      const detail = (await agents.manager.get(`/api/onboarding/applications/${back.applicationId}`).set(headers).expect(200)).body;
      expect(detail.alreadyHere.map((row: { on: string; status: string }) => [row.on, row.status])).toEqual([['EMAIL', 'LEFT'], ['PHONE', 'LEFT']]);
      await approve(back.applicationId, { returningMemberId: jesse.memberId }).expect(201);
      const [record] = await db.query(`SELECT id FROM dispatch_members WHERE "previousMemberId" = $1`, [jesse.memberId]);
      const page = (await agents.manager.get(`/api/dispatch/members/${record.id}`).set(headers).expect(200)).body;
      expect(page.previousRecord).toMatchObject({ id: jesse.memberId, name: 'Jesse Fictional' });
      expect((await agents.manager.get(`/api/dispatch/members/${jesse.memberId}`).set(headers).expect(200)).body.laterRecord).toMatchObject({ id: record.id });
    });
    it('stops a second open application with the same email at verification', async () => {
      const first = await submitted('Sam', 'sam@example.test', '+1 202 555 0111');
      const [other] = await db.query(`INSERT INTO invitations ("managerId","tokenHash","expiresAt","telegramRequired") VALUES ($1,$2,now()+interval '7 days',false) RETURNING id`, [users.manager.id, randomBytes(32).toString('hex')]);
      await expect(refuseSecondApplication(db, 'SAM@example.test', other.id)).rejects.toThrow('You already have an application in progress with this email.');
      // Waiting for review still counts after the applicant's own access ended.
      await db.query(`UPDATE dispatcher_applications SET "applicantAccessUntil" = now() - interval '1 day' WHERE id = $1`, [first.applicationId]);
      await expect(refuseSecondApplication(db, 'sam@example.test', other.id)).rejects.toThrow('You already have an application in progress');
      // Rejected (or expired) applications are closed: they can try again.
      await db.query(`UPDATE dispatcher_applications SET status = 'REJECTED' WHERE id = $1`, [first.applicationId]);
      await expect(refuseSecondApplication(db, 'sam@example.test', other.id)).resolves.toBeUndefined();
    });
  });

  describe('corrections (section 36)', () => {
    it('lets an administrator correct details without touching the application, and IT’s open setup follows', async () => {
      const riley = await dispatcher('Riley');
      await db.query(`UPDATE it_onboarding_requests SET "completedAt" = NULL WHERE id = $1`, [riley.setupId]);
      const body = { reason: 'Typos in the application, confirmed by phone.', legalLastName: 'Santos', personalEmail: 'Riley.Home@example.test', preferredAmericanFirstName: 'Rylee' };
      await act(agents.manager, riley.memberId, 'correct', body, 403);
      await act(agents.admin, riley.memberId, 'correct', body);
      const page = (await agents.manager.get(`/api/dispatch/members/${riley.memberId}`).set(headers).expect(200)).body;
      expect(page).toMatchObject({ firstName: 'Rylee', details: { legalLastName: 'Santos', personalEmail: 'riley.home@example.test', preferredAmericanFirstName: 'Rylee', legalFirstName: 'Legal' },
        correctedFields: { legalLastName: { by: 'Fictional admin' }, personalEmail: { by: 'Fictional admin' } } });
      expect(page.corrections[0].changes).toEqual(expect.arrayContaining([{ field: 'legalLastName', from: 'Riley', to: 'Santos' }, { field: 'personalEmail', from: 'riley@example.test', to: 'riley.home@example.test' }]));
      // The application and its submitted revision keep what was sent; the event holds field names only.
      expect((await db.query(`SELECT fields->>'lastName' AS last FROM application_submissions WHERE "applicationId" = $1`, [riley.applicationId]))[0].last).toBe('Riley');
      expect((await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'DETAILS_CORRECTED'`))[0].metadata).toEqual({ fields: ['legalLastName', 'preferredAmericanFirstName', 'personalEmail'] });
      expect((await db.query(`SELECT profile FROM it_onboarding_requests WHERE id = $1`, [riley.setupId]))[0].profile).toMatchObject({ legalLastName: 'Santos', personalEmail: 'riley.home@example.test', proposedDisplayName: 'Rylee Fictional' });
      // A change IT doesn't see (Telegram) leaves the setup's version alone, so IT isn't asked to reload.
      const setupVersion = async () => (await db.query(`SELECT version FROM it_onboarding_requests WHERE id = $1`, [riley.setupId]))[0].version as number;
      const before = await setupVersion();
      await act(agents.admin, riley.memberId, 'correct', { reason: 'Their handle changed.', telegram: '@rylee_fictional' });
      expect(await setupVersion()).toBe(before);
      await act(agents.admin, riley.memberId, 'correct', { reason: 'Again.', legalLastName: 'Santos' }, 400);
      await act(agents.admin, riley.memberId, 'correct', { reason: 'Hand name.', firstName: 'Riley' }, 400);
    });
    it('never finds or exports an application answer an administrator cleared', async () => {
      const riley = await dispatcher('Riley');
      await db.query(`UPDATE application_submissions SET fields = fields || '{"telegram": "@riley_old"}' WHERE "applicationId" = $1`, [riley.applicationId]);
      const search = async () => (await agents.manager.get('/api/dispatch/members?page=1&status=ALL&search=riley_old').set(headers).expect(200)).body.items;
      const exported = async () => (await agents.manager.post('/api/dispatch/members/export').set(headers).send({ status: 'ALL' }).expect(201)).body.items[0].telegram;
      expect((await search()).map((row: { matched: unknown }) => row.matched)).toEqual([{ label: 'Telegram', value: '@riley_old' }]);
      expect(await exported()).toBe('@riley_old');
      // Cleared: the correction holds the key with no value, and the application's answer stays out of search and export.
      await db.query(`UPDATE dispatch_members SET "correctedDetails" = '{"telegram": null}' WHERE id = $1`, [riley.memberId]);
      expect(await search()).toEqual([]);
      expect(await exported()).toBeNull();
    });
    it('corrects the name of someone added by hand', async () => {
      const [member] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName","joinedAt") VALUES ('Riley','Santo',now()) RETURNING id`);
      await db.query(`INSERT INTO existing_member_records ("memberId","addedBy") VALUES ($1,$2)`, [member.id, users.manager.id]);
      await act(agents.admin, member.id, 'correct', { reason: 'The file had a typo.', personalEmail: 'x@example.test' }, 400);
      await act(agents.admin, member.id, 'correct', { reason: 'The file had a typo.', lastName: 'Santos' });
      expect((await db.query(`SELECT "lastName" FROM dispatch_members WHERE id = $1`, [member.id]))[0].lastName).toBe('Santos');
    });
    it('refuses someone else’s email, finds a corrected phone, and renames an open leave checklist', async () => {
      const riley = await dispatcher('Riley'), casey = await dispatcher('Casey', { phone: '+1 303 555 0144' });
      expect((await act(agents.admin, riley.memberId, 'correct', { reason: 'Wrong email.', personalEmail: 'casey@example.test' }, 409)).body.message).toContain('belongs to Casey Fictional');
      const open = await submitted('Sam', 'sam@example.test', '+1 404 555 0123');
      await act(agents.admin, riley.memberId, 'correct', { reason: 'Wrong email.', personalEmail: 'sam@example.test' }, 409);
      // A corrected phone replaces the application's: the old one no longer matches, the new one does.
      await act(agents.admin, casey.memberId, 'correct', { reason: 'New phone.', personalPhoneNumber: '(404) 555-0123' });
      const detail = (await agents.manager.get(`/api/onboarding/applications/${open.applicationId}`).set(headers).expect(200)).body;
      expect(detail.alreadyHere).toEqual([expect.objectContaining({ on: 'PHONE', memberId: casey.memberId })]);
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: usDay('latest'), backOn: addDays(usDay('latest'), 9), reason: 'Vacation.' });
      await act(agents.admin, riley.memberId, 'correct', { reason: 'Spelling.', preferredAmericanFirstName: 'Rylee' });
      expect(await db.query(`SELECT profile->>'displayName' AS name FROM it_leave_requests`)).toEqual([{ name: 'Rylee Fictional' }]);
      expect((await db.query(`SELECT event FROM it_leave_activity ORDER BY "createdAt" DESC LIMIT 1`))[0].event).toBe('DETAILS_CORRECTED');
    });
  });

  describe('changing a name (section 45)', () => {
    const otherNames = async (memberId: string) => db.query(`SELECT o.name, o."mcId", o."companyName", o.note FROM member_other_names o WHERE o."memberId" = $1 ORDER BY o."createdAt"`, [memberId]);
    it('lets a dispatch manager give a new name, keeping the old one as an other name; a fix keeps nothing', async () => {
      const riley = await dispatcher('Riley'), northwind = await mcId();
      await db.query(`UPDATE it_onboarding_requests SET "completedAt" = NULL WHERE id = $1`, [riley.setupId]);
      await act(agents.it, riley.memberId, 'name', { kind: 'NEW', firstName: 'Casey', lastName: 'Brooks', mcId: northwind, reason: 'Goes by a new name.' }, 403);
      await act(agents.manager, riley.memberId, 'name', { kind: 'NEW', firstName: 'Riley', lastName: 'Fictional', reason: 'Same.' }, 400);
      await act(agents.manager, riley.memberId, 'name', { kind: 'NEW', firstName: 'Casey', lastName: 'Brooks', mcId: northwind, reason: 'Goes by a new name.' });
      const page = (await agents.manager.get(`/api/dispatch/members/${riley.memberId}`).set(headers).expect(200)).body;
      expect(page).toMatchObject({ firstName: 'Casey', lastName: 'Brooks', details: { preferredAmericanFirstName: 'Casey', preferredAmericanLastName: 'Brooks', legalLastName: 'Riley' } });
      expect(await otherNames(riley.memberId)).toEqual([expect.objectContaining({ name: 'Riley Fictional', mcId: northwind, companyName: null, note: expect.stringMatching(/^Their name until /) })]);
      // The application keeps what was sent; IT's open setup follows; History says what it was, never the names.
      expect((await db.query(`SELECT fields->>'preferredAmericanFirstName' AS first FROM application_submissions WHERE "applicationId" = $1`, [riley.applicationId]))[0].first).toBe('Riley');
      expect((await db.query(`SELECT profile->>'proposedDisplayName' AS name FROM it_onboarding_requests WHERE id = $1`, [riley.setupId]))[0].name).toBe('Casey Brooks');
      expect(page.timeline.entries.find((entry: { title: string }) => entry.title.startsWith('Name changed'))).toMatchObject({ title: 'Name changed', body: 'Goes by a new name. The earlier name is kept as an other name.' });
      // A fix of the spelling replaces it and keeps nothing; a new name differing only in spelling is refused.
      await act(agents.manager, riley.memberId, 'name', { kind: 'NEW', firstName: 'casey', lastName: 'brooks', reason: 'Lower case.' }, 400);
      await act(agents.admin, riley.memberId, 'name', { kind: 'FIX', firstName: 'Kasey', lastName: 'Brooks', reason: 'Spelled with a K on their ID.' });
      expect(await otherNames(riley.memberId)).toHaveLength(1);
      expect((await db.query(`SELECT kind FROM member_detail_corrections ORDER BY "createdAt"`)).map((row: { kind: string }) => row.kind)).toEqual(['NEW_NAME', 'NAME_FIX']);
    });
    it('keeps no more than 10 other names, leaves a new name out of “Corrected by”, and renames a team lead’s sign-in', async () => {
      const riley = await dispatcher('Riley'), northwind = await mcId();
      const [lead] = await db.query(`INSERT INTO users ("firstName","lastName",email,role,status,"passwordHash") VALUES ('Riley','Fictional','riley.lead@example.test','TEAM_LEAD','ACTIVE','x') RETURNING id`);
      await db.query(`UPDATE dispatch_members SET "accountUserId" = $1 WHERE id = $2`, [lead.id, riley.memberId]);
      await act(agents.manager, riley.memberId, 'name', { kind: 'NEW', firstName: 'Casey', lastName: 'Brooks', mcId: northwind, reason: 'New name.' });
      expect((await db.query(`SELECT "firstName", "lastName" FROM users WHERE id = $1`, [lead.id]))[0]).toEqual({ firstName: 'Casey', lastName: 'Brooks' });
      expect((await db.query(`SELECT metadata FROM staff_security_events WHERE "userId" = $1 AND type = 'USER_NAME_CHANGED'`, [lead.id]))[0].metadata).toEqual({ fields: ['firstName', 'lastName'], reason: 'member-renamed' });
      const page = (await agents.manager.get(`/api/dispatch/members/${riley.memberId}`).set(headers).expect(200)).body;
      expect(page.correctedFields).toEqual({});
      expect(page.corrections[0].changes).toEqual([{ field: 'preferredAmericanFirstName', from: 'Riley', to: 'Casey' }, { field: 'preferredAmericanLastName', from: 'Fictional', to: 'Brooks' }]);
      for (let index = 0; index < 9; index += 1) await db.query(`INSERT INTO member_other_names ("memberId", name, "addedBy") VALUES ($1, $2, $3)`, [riley.memberId, `Name ${String.fromCharCode(65 + index)}`, users.manager.id]);
      expect((await act(agents.manager, riley.memberId, 'name', { kind: 'NEW', firstName: 'Drew', lastName: 'Brooks', reason: 'Another.' }, 409)).body.message).toContain('10 other names');
      // A fix keeps no other name, so it still works.
      await act(agents.manager, riley.memberId, 'name', { kind: 'FIX', firstName: 'Kasey', lastName: 'Brooks', reason: 'Spelling.' });
    });
    it('takes a name they used before out of their other names, and words a reason that ends in “!”', async () => {
      const riley = await dispatcher('Riley'), northwind = await mcId();
      await db.query(`INSERT INTO member_other_names ("memberId", name, "addedBy") VALUES ($1, 'Casey Brooks', $2)`, [riley.memberId, users.manager.id]);
      await act(agents.manager, riley.memberId, 'name', { kind: 'NEW', firstName: 'Casey', lastName: 'Brooks', mcId: northwind, reason: 'Back to the name they used!' });
      expect((await otherNames(riley.memberId)).map((row: { name: string }) => row.name)).toEqual(['Riley Fictional']);
      const history = (await agents.manager.get(`/api/dispatch/members/${riley.memberId}`).set(headers).expect(200)).body.timeline.entries;
      expect(history.find((entry: { title: string }) => entry.title === 'Name changed').body).toBe('Back to the name they used! The earlier name is kept as an other name.');
    });
    it('keeps a support’s old name at the MC of whoever they helped on the day the change starts', async () => {
      const dana = await dispatcher('Dana'), evan = await dispatcher('Evan'), northwind = await mcId();
      const [lakeside] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Lakeside Carriers','lakeside carriers') RETURNING id`);
      const [kai] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",position,"joinedAt") VALUES ('Kai','Morgan','SUPPORT',now() - interval '30 days') RETURNING id`);
      await db.query(`INSERT INTO member_support_links ("supportId","dispatcherId","startedAt") VALUES ($1,$2,now() - interval '30 days')`, [kai.id, dana.memberId]);
      // Dana moves to Lakeside today; Kai's change of dispatcher is backdated to yesterday, while Dana was still at Northwind.
      await act(agents.manager, dana.memberId, 'move', { mcId: lakeside.id, teamId: null, startedAt: usDay('latest'), reason: 'Lakeside needed help.' });
      await act(agents.manager, kai.id, 'reassign', { dispatcherId: evan.memberId, startedAt: addDays(usDay('latest'), -1), reason: 'Evan needs help.', newName: { firstName: 'Kai', lastName: 'Moreno' } });
      expect(await otherNames(kai.id)).toEqual([expect.objectContaining({ name: 'Kai Morgan', mcId: northwind })]);
    });
    it('renames someone added by hand, with the old name at another company, and refuses someone who left', async () => {
      const [member] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName","joinedAt") VALUES ('Drew','Calloway',now()) RETURNING id`);
      await db.query(`INSERT INTO existing_member_records ("memberId","addedBy") VALUES ($1,$2)`, [member.id, users.manager.id]);
      await act(agents.manager, member.id, 'name', { kind: 'NEW', firstName: 'Drew', lastName: 'Collins', companyName: 'Lakeside Logistics', reason: 'Uses a new name now.' });
      expect((await db.query(`SELECT "firstName", "lastName" FROM dispatch_members WHERE id = $1`, [member.id]))[0]).toEqual({ firstName: 'Drew', lastName: 'Collins' });
      expect(await otherNames(member.id)).toEqual([expect.objectContaining({ name: 'Drew Calloway', mcId: null, companyName: 'Lakeside Logistics' })]);
      const gone = await dispatcher('Sky', { status: 'LEFT' });
      await act(agents.manager, gone.memberId, 'name', { kind: 'NEW', firstName: 'Sky', lastName: 'Rivers', reason: 'New name.' }, 409);
    });
    it('gives a new name with a move to another MC, before IT is asked for accounts there', async () => {
      const riley = await dispatcher('Riley'), northwind = await mcId();
      const [lakeside] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Lakeside Carriers','lakeside carriers') RETURNING id`);
      const move = (body: Record<string, unknown>, status = 201) => act(agents.manager, riley.memberId, 'move', { teamId: null, startedAt: usDay('latest'), reason: 'Lakeside needed help.', ...body }, status);
      await move({ mcId: northwind, teamId: null, newName: { firstName: 'Casey', lastName: 'Brooks' } }, 400);
      expect((await move({ mcId: lakeside.id, newName: { firstName: 'riley', lastName: 'fictional' } }, 400)).body.message).toContain('Answer No');
      // Already listed at the MC they leave: not added twice, and IT still learns the name before.
      await db.query(`INSERT INTO member_other_names ("memberId", name, "mcId", "addedBy") VALUES ($1, 'Riley Fictional', $2, $3)`, [riley.memberId, northwind, users.manager.id]);
      await move({ mcId: lakeside.id, accounts: 'NEW', newName: { firstName: 'Casey', lastName: 'Brooks' } });
      expect((await db.query(`SELECT "firstName", "lastName" FROM dispatch_members WHERE id = $1`, [riley.memberId]))[0]).toEqual({ firstName: 'Casey', lastName: 'Brooks' });
      expect(await otherNames(riley.memberId)).toEqual([expect.objectContaining({ name: 'Riley Fictional', mcId: northwind, note: null })]);
      const [request] = await db.query(`SELECT id, profile->>'displayName' AS name FROM it_account_requests`);
      expect(request.name).toBe('Casey Brooks');
      expect((await agents.it.get(`/api/it/accounts/${request.id}`).set(headers).expect(200)).body.request.formerName).toBe('Riley Fictional');
      expect(await db.query(`SELECT kind, context FROM member_detail_corrections`)).toEqual([{ kind: 'NEW_NAME', context: 'MOVE' }]);
      const history = (await agents.manager.get(`/api/dispatch/members/${riley.memberId}`).set(headers).expect(200)).body.timeline.entries;
      expect(history.find((entry: { title: string }) => entry.title.startsWith('Name changed')).body).toBe('Lakeside needed help. The earlier name was already listed as an other name.');
    });
  });

  describe('drivers while their dispatcher is away (section 34)', () => {
    const today = () => usDay('latest');
    let phone = 5550170000;
    /** A cleared driver working with this dispatcher since ten days ago. */
    async function driver(first: string, memberId: string) {
      phone += 1;
      const [row] = await db.query(`INSERT INTO drivers ("firstName", "lastName", phone, "phoneKey", "driverType", "licenseType", status, "clearedAt") VALUES ($1, 'Driver', $2, $2, 'COMPANY', 'CDL_A', 'CLEARED', now() - interval '20 days') RETURNING id`, [first, String(phone)]);
      await db.query(`INSERT INTO driver_assignments ("driverId", "mcId", "memberId", truck, "startedAt") VALUES ($1, $2, $3, '214', now() - interval '10 days')`, [row.id, await mcId(), memberId]);
      return row.id as string;
    }
    const withDriver = async (driverId: string) => (await db.query(`SELECT "memberId" FROM driver_assignments WHERE "driverId" = $1 AND "endedAt" IS NULL`, [driverId]))[0]?.memberId;
    const options = async (memberId: string) => (await agents.manager.get(`/api/dispatch/members/${memberId}/cover-options`).set(headers).expect(200)).body;
    beforeEach(async () => { await db.query('TRUNCATE drivers CASCADE'); });

    it('covers their drivers from the first day away and brings them back, except one reassigned for good', async () => {
      const riley = await dispatcher('Riley'), casey = await dispatcher('Casey'), jordan = await dispatcher('Jordan');
      const marcus = await driver('Marcus', riley.memberId), lena = await driver('Lena', riley.memberId), tomas = await driver('Tomas', riley.memberId);
      const offered = await options(riley.memberId);
      expect(offered.drivers.map((row: { name: string }) => row.name)).toEqual(['Lena Driver', 'Marcus Driver', 'Tomas Driver']);
      expect(offered.dispatchers.map((row: { id: string }) => row.id).sort()).toEqual([casey.memberId, jordan.memberId].sort());
      const leave = { firstDay: today(), backOn: addDays(today(), 14), reason: 'Personal leave.' };
      // Every driver needs someone, under their MC, who isn't the person going away.
      await act(agents.manager, riley.memberId, 'on-leave', { ...leave, covers: [{ driverId: marcus, memberId: casey.memberId }] }, 400);
      await act(agents.manager, riley.memberId, 'on-leave', { ...leave, covers: [marcus, lena, tomas].map(driverId => ({ driverId, memberId: riley.memberId })) }, 400);
      await act(agents.manager, riley.memberId, 'on-leave', { ...leave, covers: [{ driverId: marcus, memberId: casey.memberId }, { driverId: lena, memberId: jordan.memberId }, { driverId: tomas, memberId: casey.memberId }] });
      expect([await withDriver(marcus), await withDriver(lena), await withDriver(tomas)]).toEqual([casey.memberId, jordan.memberId, casey.memberId]);
      const page = (await agents.manager.get(`/api/dispatch/members/${riley.memberId}`).set(headers).expect(200)).body;
      expect(page.leave.covers.map((row: { driver: string; cover: string; started: boolean }) => [row.driver, row.cover, row.started])).toEqual([['Lena Driver', 'Jordan Fictional', true], ['Marcus Driver', 'Casey Fictional', true], ['Tomas Driver', 'Casey Fictional', true]]);
      expect(page.driversToReassign).toEqual([]);
      // Dispatch sees who covers and who they go back to.
      const listed = (await agents.manager.get('/api/dispatch/drivers').set(headers).expect(200)).body.items;
      expect(listed.find((row: { id: string }) => row.id === marcus).assignment).toMatchObject({ dispatcher: 'Casey Fictional', covering: { for: 'Riley Fictional', until: leave.backOn } });
      // Tomas is reassigned for good meanwhile, so he stays.
      const [{ version }] = await db.query(`SELECT version FROM drivers WHERE id = $1`, [tomas]);
      await agents.manager.post(`/api/dispatch/drivers/${tomas}/assign`).set(headers).send({ version, mcId: await mcId(), memberId: jordan.memberId, startsOn: today(), reason: 'Better fit.' }).expect(201);
      await act(agents.manager, riley.memberId, 'on-leave/return', {});
      expect([await withDriver(marcus), await withDriver(lena), await withDriver(tomas)]).toEqual([riley.memberId, riley.memberId, jordan.memberId]);
      expect((await db.query(`SELECT "endedHow" FROM driver_leave_covers ORDER BY "endedHow"`)).map((row: { endedHow: string }) => row.endedHow)).toEqual(['REASSIGNED', 'RETURNED', 'RETURNED']);
      // Each move is in the driver's history, with the truck kept.
      expect(await db.query(`SELECT "memberId", truck FROM driver_assignments WHERE "driverId" = $1 ORDER BY "startedAt", "createdAt"`, [marcus])).toEqual([
        { memberId: riley.memberId, truck: '214' }, { memberId: casey.memberId, truck: '214' }, { memberId: riley.memberId, truck: '214' }]);
      expect((await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'LEAVE_RECORDED'`))[0].metadata).toMatchObject({ covered: 3 });
    });
    it('plans a future leave, changes who covers before it starts, and keeps the drivers with who covers them if they leave', async () => {
      const riley = await dispatcher('Riley'), casey = await dispatcher('Casey'), jordan = await dispatcher('Jordan');
      const marcus = await driver('Marcus', riley.memberId);
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: addDays(today(), 3), backOn: addDays(today(), 20), reason: 'Vacation.', covers: [{ driverId: marcus, memberId: casey.memberId }] });
      // Nothing moves before the first day away.
      expect(await withDriver(marcus)).toBe(riley.memberId);
      await act(agents.manager, riley.memberId, 'on-leave/covers', { covers: [{ driverId: marcus, memberId: jordan.memberId }] });
      await act(agents.manager, riley.memberId, 'on-leave/covers', { covers: [{ driverId: marcus, memberId: jordan.memberId }] }, 400);
      await db.query(`UPDATE member_leaves SET "firstDay" = $1 WHERE "memberId" = $2`, [today(), riley.memberId]);
      expect(await app.get(LeaveService).sweep()).toMatchObject({ started: 1, failed: 0 });
      expect(await withDriver(marcus)).toBe(jordan.memberId);
      // Riley won't come back: Marcus stays with Jordan for good, and Riley has nobody to reassign.
      await act(agents.manager, riley.memberId, 'leave', { leftAt: today(), reason: 'Decided not to return.' });
      expect(await withDriver(marcus)).toBe(jordan.memberId);
      expect(await db.query(`SELECT "endedHow" FROM driver_leave_covers`)).toEqual([{ endedHow: 'KEPT' }]);
      expect((await db.query(`SELECT status FROM dispatch_members WHERE id = $1`, [riley.memberId]))[0].status).toBe('LEFT');
    });
    it('moves a covered driver to someone else while away, and refuses a dispatcher who is away themselves', async () => {
      const riley = await dispatcher('Riley'), casey = await dispatcher('Casey'), jordan = await dispatcher('Jordan');
      const marcus = await driver('Marcus', riley.memberId);
      await act(agents.manager, jordan.memberId, 'on-leave', { firstDay: today(), backOn: addDays(today(), 5), reason: 'Away.' });
      expect((await options(riley.memberId)).dispatchers.map((row: { id: string }) => row.id)).toEqual([casey.memberId]);
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: today(), backOn: addDays(today(), 9), reason: 'Personal leave.', covers: [{ driverId: marcus, memberId: jordan.memberId }] }, 400);
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: today(), backOn: addDays(today(), 9), reason: 'Personal leave.', covers: [{ driverId: marcus, memberId: casey.memberId }] });
      await act(agents.manager, jordan.memberId, 'on-leave/return', {});
      await act(agents.manager, riley.memberId, 'on-leave/covers', { covers: [{ driverId: marcus, memberId: jordan.memberId }] });
      expect(await withDriver(marcus)).toBe(jordan.memberId);
      await act(agents.manager, riley.memberId, 'on-leave/return', {});
      expect(await withDriver(marcus)).toBe(riley.memberId);
      expect((await db.query(`SELECT count(*)::integer AS n FROM driver_assignments WHERE "driverId" = $1`, [marcus]))[0].n).toBe(4);
    });
    it('refuses a rollback while covers are recorded', async () => {
      const riley = await dispatcher('Riley'), casey = await dispatcher('Casey');
      const marcus = await driver('Marcus', riley.memberId);
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: today(), backOn: addDays(today(), 9), reason: 'Personal leave.', covers: [{ driverId: marcus, memberId: casey.memberId }] });
      const runner = db.createQueryRunner();
      const { LeaveCovers1793280000000: Migration } = await import('../src/database/migrations/1793280000000-LeaveCovers');
      await expect(new Migration().down(runner)).rejects.toThrow('Refusing to roll back while drivers covered');
      await runner.release();
    });
  });
  describe('on leave (section 35)', () => {
    const today = () => usDay('latest');
    it('suspends access from today, restores it on return, and pauses a team lead’s sign-in', async () => {
      const riley = await dispatcher('Riley');
      const lead = await db.getRepository(User).save({ firstName: 'Riley', lastName: 'Lead', email: 'riley.work@example.test', role: Role.TEAM_LEAD, status: UserStatus.ACTIVE, passwordHash: await hashPassword(password) });
      const [team] = await db.query(`INSERT INTO teams (name,"nameKey","mcId","leadMemberId") VALUES ('Riley team','riley team',$1,$2) RETURNING id`, [await mcId(), riley.memberId]);
      await db.query(`UPDATE member_assignments SET "teamId" = $1 WHERE "memberId" = $2`, [team.id, riley.memberId]);
      await db.query(`UPDATE dispatch_members SET "accountUserId" = $1 WHERE id = $2`, [lead.id, riley.memberId]);
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: today(), backOn: addDays(today(), 28), reason: 'Personal leave.', callsWhileAway: 'VOICEMAIL' });
      expect((await db.getRepository(User).findOneByOrFail({ id: lead.id })).status).toBe(UserStatus.INACTIVE);
      expect(await alerts()).toEqual(['IT_LEAVE_SUSPEND']);
      const page = (await agents.manager.get(`/api/dispatch/members/${riley.memberId}`).set(headers).expect(200)).body;
      expect(page.leave).toMatchObject({ started: true, reason: 'Personal leave.', emailWhileAway: 'FORWARD', callsWhileAway: 'VOICEMAIL', suspend: { kind: 'SUSPEND', done: 0, total: 3 } });
      expect((await agents.manager.get('/api/dispatch/members?status=ON_LEAVE').set(headers).expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([riley.memberId]);
      await act(agents.manager, riley.memberId, 'move', { mcId: await mcId(), startedAt: today(), reason: 'Test.' }, 409);
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: today(), backOn: addDays(today(), 3), reason: 'Again.' }, 409);
      // IT sees it only when its page asks; finishing tells the manager who recorded it.
      expect((await agents.it.get('/api/it/tasks').set(headers).expect(200)).body.items).toEqual([]);
      const listed = (await agents.it.get('/api/it/tasks?view=leave&leave=1').set(headers).expect(200)).body;
      expect(listed.items.map((row: { kind: string }) => row.kind)).toEqual(['SUSPEND']);
      let detail = (await agents.it.get(`/api/it/leave/${listed.items[0].id}`).set(headers).expect(200)).body;
      expect(detail.tasks.map((task: { key: string }) => task.key)).toEqual(['GOOGLE_WORKSPACE', 'RINGCENTRAL', 'BUSINESS_SOFTWARE']);
      for (const key of ['GOOGLE_WORKSPACE', 'RINGCENTRAL']) detail = (await agents.it.patch(`/api/it/leave/${detail.request.id}/tasks/${key}`).set(headers).send({ version: detail.request.version, status: 'COMPLETED' }).expect(200)).body;
      await agents.it.patch(`/api/it/leave/${detail.request.id}/tasks/RINGCENTRAL`).set(headers).send({ version: detail.request.version, status: 'NOT_NEEDED' }).expect(400);
      detail = (await agents.it.patch(`/api/it/leave/${detail.request.id}/tasks/BUSINESS_SOFTWARE`).set(headers).send({ version: detail.request.version, status: 'NOT_NEEDED' }).expect(200)).body;
      expect(detail.request.completedAt).not.toBeNull();
      expect(await db.query(`SELECT kind, "recipientId" FROM portal_notifications`)).toEqual([{ kind: 'IT_SUSPEND_COMPLETED', recipientId: users.manager.id }]);
      // Back: Active, IT restores what it suspended (not what was Not needed), and the lead's sign-in waits for IT.
      await act(agents.manager, riley.memberId, 'on-leave/return', {});
      const [restore] = await db.query(`SELECT id, kind FROM it_leave_requests WHERE kind = 'RESTORE'`);
      expect((await db.query(`SELECT key FROM it_leave_tasks WHERE "requestId" = $1 ORDER BY key`, [restore.id])).map((row: { key: string }) => row.key)).toEqual(['GOOGLE_WORKSPACE', 'RINGCENTRAL']);
      expect(await alerts()).toEqual(['IT_LEAVE_SUSPEND', 'IT_LEAVE_RESTORE']);
      expect(await db.query(`SELECT kind FROM team_lead_sign_ins WHERE "memberId" = $1 AND "doneAt" IS NULL AND "cancelledAt" IS NULL`, [riley.memberId])).toEqual([{ kind: 'TURN_ON' }]);
      expect((await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'LEAVE_ENDED'`))[0].metadata).toEqual({ how: 'RETURNED', itRestore: true });
    });
    it('waits for an unfinished IT setup, and moves with the manager on hand-over', async () => {
      const riley = await dispatcher('Riley');
      await db.query(`UPDATE it_onboarding_requests SET "completedAt" = NULL WHERE id = $1`, [riley.setupId]);
      expect((await act(agents.manager, riley.memberId, 'on-leave', { firstDay: today(), backOn: addDays(today(), 9), reason: 'Vacation.' }, 409)).body.message).toContain('IT is still setting something up');
      await db.query(`UPDATE it_onboarding_requests SET "completedAt" = now() WHERE id = $1`, [riley.setupId]);
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: today(), backOn: addDays(today(), 9), reason: 'Vacation.' });
      expect((await agents.admin.get(`/api/users/${users.manager.id}/open-records`).set(headers).expect(200)).body).toMatchObject({ leave: 1 });
      await agents.admin.patch(`/api/users/${users.manager.id}`).set(headers).send({ status: 'INACTIVE', handOverTo: users.admin.id }).expect(200);
      expect(await db.query(`SELECT "forwardTo" FROM member_leaves`)).toEqual([{ forwardTo: users.admin.id }]);
      expect(await db.query(`SELECT "managerId", profile->>'forwardToName' AS name FROM it_leave_requests`)).toEqual([{ managerId: users.admin.id, name: 'Fictional admin' }]);
      expect((await db.query(`SELECT event FROM it_leave_activity ORDER BY "createdAt" DESC LIMIT 1`))[0].event).toBe('MANAGER_HANDED_OVER');
    });
    it('plans a future leave, refuses completing early, and cancels it while nothing is suspended', async () => {
      const riley = await dispatcher('Riley');
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: addDays(today(), 5), backOn: addDays(today(), 20), reason: 'Vacation.' });
      const [suspend] = await db.query(`SELECT id, version FROM it_leave_requests`);
      expect((await agents.it.patch(`/api/it/leave/${suspend.id}/tasks/GOOGLE_WORKSPACE`).set(headers).send({ version: suspend.version, status: 'COMPLETED' }).expect(400)).body.message).toContain('first day away');
      await act(agents.manager, riley.memberId, 'on-leave/return', {}, 409);
      await act(agents.manager, riley.memberId, 'on-leave/back-on', { backOn: addDays(today(), 25), reason: 'Longer.' });
      expect((await db.query(`SELECT profile->>'backOn' AS back FROM it_leave_requests`))[0].back).toBe(addDays(today(), 25));
      await act(agents.manager, riley.memberId, 'on-leave/cancel', {});
      expect(await db.query(`SELECT "cancelledAt" IS NOT NULL AS cancelled FROM it_leave_requests`)).toEqual([{ cancelled: true }]);
      expect(await db.query(`SELECT "endedHow" FROM member_leaves`)).toEqual([{ endedHow: 'CANCELLED' }]);
    });
    it('starts and ends leaves on the daily run, and a leaving person’s leave hands over to the removal', async () => {
      const riley = await dispatcher('Riley'), casey = await dispatcher('Casey');
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: addDays(today(), 2), backOn: addDays(today(), 9), reason: 'Vacation.' });
      await db.query(`UPDATE member_leaves SET "firstDay" = $1::date - 7, "backOn" = $1::date WHERE "memberId" = $2`, [today(), riley.memberId]);
      expect(await app.get(LeaveService).sweep()).toEqual({ started: 0, returned: 1, failed: 0 });
      expect(await db.query(`SELECT "endedHow", "startedAt" IS NOT NULL AS started FROM member_leaves`)).toEqual([{ endedHow: 'RETURNED', started: true }]);
      // Nothing was suspended, so there's nothing to restore.
      expect(await db.query(`SELECT kind FROM it_leave_requests WHERE kind = 'RESTORE'`)).toEqual([]);
      await act(agents.manager, casey.memberId, 'on-leave', { firstDay: today(), backOn: addDays(today(), 9), reason: 'Personal leave.' });
      const [suspend] = await db.query(`SELECT id, version FROM it_leave_requests WHERE "memberId" = $1`, [casey.memberId]);
      await agents.it.patch(`/api/it/leave/${suspend.id}/tasks/GOOGLE_WORKSPACE`).set(headers).send({ version: suspend.version, status: 'COMPLETED' }).expect(200);
      await act(agents.manager, casey.memberId, 'on-leave/cancel', {}, 409);
      await act(agents.manager, casey.memberId, 'leave', { leftAt: today(), reason: 'Decided not to return.' });
      expect(await db.query(`SELECT "endedHow" FROM member_leaves WHERE "memberId" = $1`, [casey.memberId])).toEqual([{ endedHow: 'LEAVING' }]);
      expect((await db.query(`SELECT profile FROM it_removal_requests WHERE "memberId" = $1`, [casey.memberId]))[0].profile).toMatchObject({ suspendedOnLeave: true });
      expect(await db.query(`SELECT "cancelledAt" IS NOT NULL AS cancelled FROM it_leave_requests WHERE id = $1`, [suspend.id])).toEqual([{ cancelled: true }]);
    });
    it('restores what was suspended when the notice that ended a leave is cancelled', async () => {
      const riley = await dispatcher('Riley');
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: today(), backOn: addDays(today(), 20), reason: 'Personal leave.' });
      const [suspend] = await db.query(`SELECT id, version FROM it_leave_requests`);
      await agents.it.patch(`/api/it/leave/${suspend.id}/tasks/GOOGLE_WORKSPACE`).set(headers).send({ version: suspend.version, status: 'COMPLETED' }).expect(200);
      await act(agents.manager, riley.memberId, 'leave', { leftAt: addDays(today(), 10), reason: 'Moving away.' });
      expect(await db.query(`SELECT kind FROM it_leave_requests WHERE kind = 'RESTORE'`)).toEqual([]);
      await act(agents.manager, riley.memberId, 'cancel-notice', { reason: 'Staying after all.' });
      const [restore] = await db.query(`SELECT id FROM it_leave_requests WHERE kind = 'RESTORE'`);
      expect((await db.query(`SELECT key FROM it_leave_tasks WHERE "requestId" = $1`, [restore.id])).map((row: { key: string }) => row.key)).toEqual(['GOOGLE_WORKSPACE']);
      expect(await alerts()).toEqual(['IT_LEAVE_SUSPEND', 'IT_REMOVAL_SCHEDULED', 'IT_LEAVE_RESTORE']);
      expect((await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'NOTICE_CANCELLED'`))[0].metadata).toEqual({ itRemoval: true, itRestore: true });
      // IT's page says why the restore opened.
      expect((await agents.it.get(`/api/it/leave/${restore.id}`).set(headers).expect(200)).body.request.leaveEnded).toBe('LEAVING');
    });
    it('restores a task IT started when the leave is cancelled, and forwards nothing to the manager unless asked', async () => {
      const riley = await dispatcher('Riley');
      await act(agents.manager, riley.memberId, 'on-leave', { firstDay: today(), backOn: addDays(today(), 9), reason: 'Vacation.', emailWhileAway: 'AUTO_REPLY', callsWhileAway: 'VOICEMAIL' });
      expect(await db.query(`SELECT l."forwardTo", r.profile->>'forwardToName' AS name FROM member_leaves l JOIN it_leave_requests r ON r."leaveId" = l.id`)).toEqual([{ forwardTo: null, name: null }]);
      const [suspend] = await db.query(`SELECT id, version FROM it_leave_requests`);
      await agents.it.patch(`/api/it/leave/${suspend.id}/tasks/GOOGLE_WORKSPACE`).set(headers).send({ version: suspend.version, status: 'IN_PROGRESS' }).expect(200);
      await act(agents.manager, riley.memberId, 'on-leave/cancel', {});
      const [restore] = await db.query(`SELECT id FROM it_leave_requests WHERE kind = 'RESTORE'`);
      expect((await db.query(`SELECT key FROM it_leave_tasks WHERE "requestId" = $1`, [restore.id])).map((row: { key: string }) => row.key)).toEqual(['GOOGLE_WORKSPACE']);
      expect((await agents.it.get(`/api/it/leave/${restore.id}`).set(headers).expect(200)).body.request.leaveEnded).toBe('CANCELLED');
    });
  });
});
