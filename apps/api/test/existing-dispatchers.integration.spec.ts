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
import { issueDemoCode } from '../src/database/demo-verification';
import { AuthModule } from '../src/modules/auth/auth.module';
import { installSessions } from '../src/modules/auth/session';
import { hashPassword } from '../src/modules/auth/password';
import { User, Role, UserStatus } from '../src/modules/users/user.entity';
import { OnboardingModule } from '../src/modules/onboarding/onboarding.module';
import { ItModule } from '../src/modules/it/it.module';
import { WorkspaceModule } from '../src/modules/workspace/workspace.module';
import { DispatchModule } from '../src/modules/dispatch/dispatch.module';
import { fileDate } from '../src/modules/dispatch/existing.service';
import { documentStatus } from '../src/modules/documents/requirements';
import { openRecords } from '../src/modules/onboarding/hand-over';
type Agent = ReturnType<typeof request.agent>;
type Key = 'manager' | 'other' | 'it';
type Row = Record<string, unknown>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describe('dates in the file', () => {
  it('reads both formats and refuses dates that do not exist', () => {
    expect(fileDate('2024-03-04')).toBe('2024-03-04');
    expect(fileDate('3/4/2024')).toBe('2024-03-04');
    for (const bad of ['Marhc 2024', '2/30/2024', '2024-13-01', '']) expect(fileDate(bad)).toBeNull();
  });
});

integration('Existing dispatchers (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url');
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  const base = (row: number, name: string, extra: Row = {}): Row => ({ row, firstName: name, lastName: 'Fictional', mc: 'Northwind Freight', team: 'Red team', jobTitle: 'Dispatcher', startedOn: '2024-03-04', ...extra });
  const check = (rows: Row[]) => agents.manager.post('/api/dispatch/existing/check').set(headers).send({ rows }).expect(201);
  const add = (rows: Row[], sourceName?: string) => agents.manager.post('/api/dispatch/existing/add').set(headers).send({ rows, sourceName }).expect(201);
  const addOne = async (name: string, extra: Row = {}) => {
    const { body } = await add([base(2, name, { personalEmail: `${name.toLowerCase()}.home@example.test`, ...extra })]);
    expect(body.left).toEqual([]);
    return body.members[0].id as string;
  };
  const link = async (memberId: string) => (await agents.manager.post('/api/dispatch/paperwork/links').set(headers).send({ memberIds: [memberId] }).expect(201)).body.items[0];
  /** Opens a link the way a dispatcher does: their email, then a fresh code. */
  async function open(url: string, email: string) {
    const agent = request.agent(app.getHttpServer());
    const begin = await agent.post('/api/applicant/begin').set(headers).send({ token: url.split('#').pop(), email }).expect(201);
    const code = await issueDemoCode(db, begin.body.challengeId, 'test');
    const verified = await agent.post('/api/applicant/verify').set(headers).send({ challengeId: begin.body.challengeId, code }).expect(201);
    return { agent, applicationId: verified.body.applicationId as string };
  }
  const answers = { firstName: 'Legal', lastName: 'Name', personalPhoneNumber: '+1 202 555 0163', preferredAmericanFirstName: 'Dana', preferredAmericanLastName: 'Okafor' };

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, OnboardingModule, ItModule, WorkspaceModule, DispatchModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, applicant_sessions, login_attempts, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, notification_deliveries, it_removal_requests CASCADE');
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['manager', Role.DISPATCHER_MANAGER], ['other', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `existing.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    }
    const [mc] = await db.query(`INSERT INTO mcs (name,"nameKey","mcNumber") VALUES ('Northwind Freight','northwind freight','7654321') RETURNING id`);
    await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Lakeside Carriers','lakeside carriers')`);
    await db.query(`INSERT INTO teams (name,"nameKey","mcId") VALUES ('Red team','red team',$1)`, [mc.id]);
    await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Dispatcher','dispatcher')`);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, it_removal_requests, users CASCADE'); await db.destroy(); } });

  it('keeps this to dispatch managers and administrators', async () => {
    await agents.it.post('/api/dispatch/existing/check').set(headers).send({ rows: [base(2, 'Riley')] }).expect(403);
    await agents.it.get('/api/dispatch/paperwork').set(headers).expect(403);
    await request(app.getHttpServer()).post('/api/dispatch/existing/add').set(headers).send({ rows: [base(2, 'Riley')] }).expect(401);
  });
  it('checks every row without saving, and groups the same unmatched text into one choice', async () => {
    const rows = [base(2, 'Ready', { team: 'red  TEAM' }), base(3, 'Spelled', { mc: 'Northwind Frieght', team: '' }), base(4, 'Again', { mc: 'northwind frieght', team: '' }), base(5, 'Lost', { team: 'Chen' }), base(6, 'Title', { jobTitle: 'Sr dispatcher' }),
      base(7, 'Dated', { startedOn: 'Marhc 2024' }), base(8, 'Future', { startedOn: '2099-01-01' }), base(9, 'Solo', { mc: 'Independent', team: '' }), base(10, 'Real', { companyEmail: 'real@company.com' })];
    const { body } = await check(rows);
    const status = (row: number) => body.rows.find((item: Row) => item.row === row);
    expect(status(2).status).toBe('READY');
    expect([status(3).status, status(4).status, status(5).status, status(6).status]).toEqual(['CHOICE', 'CHOICE', 'CHOICE', 'CHOICE']);
    expect(status(7)).toMatchObject({ status: 'PROBLEM', problems: ['Started on “Marhc 2024” isn’t a date.'] });
    expect(status(8).status).toBe('PROBLEM');
    expect(status(9).status).toBe('READY');
    expect(status(10).status).toBe('PROBLEM');
    expect(body.choices.find((item: Row) => item.field === 'mc')).toMatchObject({ text: 'Northwind Frieght', rows: [3, 4] });
    expect(body.choices.find((item: Row) => item.field === 'team')).toMatchObject({ text: 'Chen', mc: 'Northwind Freight', rows: [5] });
    expect(body.counts).toEqual({ ready: 2, choice: 4, problem: 3, already: 0 });
    expect((await db.query(`SELECT count(*)::integer AS n FROM dispatch_members`))[0].n).toBe(0);
    // Refused without saving: a row with the same email as an earlier one.
    const twice = await check([base(2, 'One', { companyEmail: 'same@example.test' }), base(3, 'Two', { companyEmail: 'SAME@example.test' })]);
    expect(twice.body.rows[1].problems).toEqual(['Same company email as row 2.']);
  });
  it('adds ready rows as Active with no application, IT setup, alert or message, and adds nobody twice', async () => {
    const { body } = await add([base(2, 'Riley', { companyEmail: 'riley@example.test', ringCentralNumber: '+1 469 555 0142', personalEmail: 'riley.home@example.test', personalPhone: '+1 202 555 0147', ndaSignedOn: '3/4/2024' }), base(3, 'Bad', { startedOn: 'never' })], 'dispatchers-november.csv');
    expect(body.added).toBe(1);
    expect(body.left).toMatchObject([{ row: 3, status: 'PROBLEM' }]);
    const id = body.members[0].id;
    const page = (await agents.other.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body;
    expect(page).toMatchObject({ status: 'ACTIVE', firstName: 'Riley', applicationId: null, jobTitle: { name: 'Dispatcher' }, current: { mc: 'Northwind Freight', team: 'Red team' },
      existing: { sourceName: 'dispatchers-november.csv', companyEmail: 'riley@example.test', ringCentralNumber: '+1 469 555 0142', personalEmail: 'riley.home@example.test', catchUp: null, paper: [{ kind: 'NDA', signedOn: '2024-03-04' }] } });
    expect(new Date(page.joinedAt).toISOString()).toBe('2024-03-04T12:00:00.000Z');
    expect((await db.query(`SELECT count(*)::integer AS n FROM notification_deliveries`))[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::integer AS n FROM it_onboarding_requests`))[0].n).toBe(0);
    // Events hold no values.
    const [event] = await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'EXISTING_ADDED' AND "memberId" = $1`, [id]);
    expect(event.metadata).toEqual({ source: 'file', paper: 1 });
    // The same people again, however the file spells them.
    const again = await check([base(2, 'Someone', { companyEmail: 'RILEY@example.test' }), base(3, 'Else', { personalEmail: 'riley.home@example.test' }), base(4, 'Phone', { personalPhone: '(202) 555-0147' }), base(5, 'riley')]);
    expect(again.body.counts.already).toBe(4);
    expect(again.body.rows[3].sameName).toBe(true);
    expect((await check([base(5, 'riley', { differentPerson: true })])).body.rows[0].status).toBe('READY');
  });
  it('links a support to a dispatcher in the same file or already here, and refuses one who can’t be found', async () => {
    const support = (row: number, name: string, supports: string): Row => ({ row, firstName: name, lastName: 'Support', position: 'support', startedOn: '2025-01-02', supports });
    const here = await addOne('Taylor');
    const { body } = await add([support(2, 'Sky', 'Morgan Fictional'), base(3, 'Morgan'), support(4, 'Blake', 'taylor fictional'), support(5, 'Lost', 'Jay Park'), { ...support(6, 'Own', 'Taylor Fictional'), mc: 'Lakeside Carriers' }]);
    expect(body.added).toBe(3);
    expect(body.left.map((row: Row) => row.row)).toEqual([5, 6]);
    expect(body.left[0].problems).toEqual(['Supports “Jay Park”, who isn’t in this file or the workspace.']);
    const blake = body.members.find((row: Row) => row.row === 4).id;
    const page = (await agents.manager.get(`/api/dispatch/members/${blake}`).set(headers).expect(200)).body;
    expect(page).toMatchObject({ position: 'SUPPORT', status: 'ACTIVE', supportOf: { dispatcherId: here } });
    const morgan = body.members.find((row: Row) => row.row === 3).id, sky = body.members.find((row: Row) => row.row === 2).id;
    expect((await agents.manager.get(`/api/dispatch/members/${sky}`).set(headers).expect(200)).body.supportOf.dispatcherId).toBe(morgan);
  });
  it('asks for only what is outstanding through a catch-up link, then accepts it without changing their job', async () => {
    const id = await addOne('Dana', { ndaSignedOn: '2024-03-04' });
    const sent = await link(id);
    expect(sent.url).toContain('/apply#');
    const paperwork = async () => (await agents.manager.get('/api/dispatch/paperwork').set(headers).expect(200)).body;
    expect((await paperwork()).items[0]).toMatchObject({ state: 'SENT', nda: { state: 'PAPER', signedOn: '2024-03-04' }, sop: { state: 'TO_SIGN' } });
    // Only the personal email on the record opens it.
    await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({ token: sent.url.split('#').pop(), email: 'someone.else@example.test' });
    const { agent, applicationId } = await open(sent.url, 'dana.home@example.test');
    const own = (await agent.get('/api/applicant/application').set(headers).expect(200)).body;
    expect(own.invitation.catchUp).toEqual({ mc: 'Northwind Freight', team: 'Red team', jobTitle: 'Dispatcher', dispatcher: null, paper: [{ kind: 'NDA', signedOn: '2024-03-04' }] });
    expect(own.employmentOptions).toBeNull();
    expect(JSON.stringify(own)).not.toContain('7654321');
    expect(own.application.fields).toMatchObject({ preferredAmericanFirstName: 'Dana', preferredAmericanLastName: 'Fictional' });
    // A page's employment answers change nothing.
    const draft = (await agent.patch('/api/applicant/draft').set(headers).send({ version: 0, ...answers, mcName: 'Typed Carrier', teamLead: 'x', jobTitle: 'Boss' }).expect(200)).body;
    expect(draft.application.fields.mcName).toBeUndefined();
    expect((await paperwork()).items[0].state).toBe('IN_PROGRESS');
    await agent.post('/api/applicant/submit').set(headers).send({ version: 1, ...answers, accurate: true }).expect(201);
    expect((await db.query(`SELECT count(*)::integer AS n FROM notification_deliveries WHERE kind = 'REVIEW_WAITING'`))[0].n).toBe(0);
    // Waiting for the manager who sent it, and out of the review queues.
    const waiting = await paperwork();
    expect(waiting.items[0]).toMatchObject({ state: 'WAITING', canReview: true, applicationId });
    expect(waiting.counts.waiting).toBe(1);
    expect((await agents.manager.get('/api/onboarding/applications?status=AWAITING_REVIEW').set(headers)).status).toBeLessThan(500);
    expect((await agents.manager.get('/api/onboarding/summary').set(headers).expect(200)).body.awaitingReview).toBe(0);
    expect((await agents.manager.get('/api/onboarding/review-queue?status=ALL').set(headers).expect(200)).body.total).toBe(0);
    expect((await agents.manager.get('/api/onboarding/invitations').set(headers).expect(200)).body).toEqual([]);
    expect((await agents.other.get('/api/dispatch/paperwork').set(headers).expect(200)).body.items[0].canReview).toBe(false);
    await agents.other.post(`/api/onboarding/applications/${applicationId}/reviews`).set(headers).send({ version: 2, decisionType: 'APPROVE', requestedFields: [], confirmed: true }).expect(404);
    const review = (body: Row) => agents.manager.post(`/api/onboarding/applications/${applicationId}/reviews`).set(headers).send({ requestedFields: [], ...body });
    const detail = (await agents.manager.get(`/api/onboarding/applications/${applicationId}`).set(headers).expect(200)).body;
    expect(detail).toMatchObject({ catchUp: true, canReview: true, canReject: false, employmentOptions: null, readyForIt: false });
    await review({ version: 2, decisionType: 'REJECT', reason: 'No', confirmed: true }).expect(400);
    await review({ version: 2, decisionType: 'APPROVE', confirmed: true, employmentConfirmed: true, employment: { mcName: 'Lakeside Carriers', teamLead: 'Independent', jobTitle: 'Dispatcher' } }).expect(400);
    // Asking for changes sends the usual message and opens only what was asked.
    await review({ version: 2, decisionType: 'REQUEST_CHANGES', reason: 'Please fix your Telegram.', requestedFields: ['telegram'], confirmed: false }).expect(201);
    expect((await paperwork()).items[0].state).toBe('CHANGES_REQUESTED');
    expect((await db.query(`SELECT count(*)::integer AS n FROM applicant_update_deliveries`))[0].n).toBeGreaterThan(0);
    const before = (await db.query(`SELECT count(*)::integer AS n FROM applicant_update_deliveries`))[0].n;
    await agent.post('/api/applicant/submit').set(headers).send({ version: 3, telegram: 'dana_fictional', accurate: true }).expect(201);
    const accepted = await review({ version: 4, decisionType: 'APPROVE', confirmed: true }).expect(201);
    expect(accepted.body).toMatchObject({ status: 'APPROVED', readyForIt: false });
    // No message, no IT request and no second record; the page now reads from the application.
    expect((await db.query(`SELECT count(*)::integer AS n FROM applicant_update_deliveries`))[0].n).toBe(before);
    expect((await db.query(`SELECT count(*)::integer AS n FROM it_onboarding_requests`))[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::integer AS n FROM dispatch_members`))[0].n).toBe(1);
    const page = (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body;
    expect(page).toMatchObject({ firstName: 'Dana', lastName: 'Okafor', applicationId, status: 'ACTIVE', current: { mc: 'Northwind Freight', team: 'Red team' }, details: { personalEmail: 'dana.home@example.test', telegram: 'dana_fictional' } });
    expect(page.existing.acceptedAt).toBeTruthy();
    expect((await paperwork()).items[0].state).toBe('FINISHED');
    expect((await agents.manager.post('/api/dispatch/paperwork/links').set(headers).send({ memberIds: [id] }).expect(201)).body.items[0].problem).toBe('Their paperwork is finished.');
  });
  it('leaves out of the signing list a document on paper', async () => {
    const id = await addOne('Dana', { ndaSignedOn: '2024-03-04' });
    const sent = await link(id);
    const { applicationId } = await open(sent.url, 'dana.home@example.test');
    for (const kind of ['NDA', 'SOP']) await db.query(`INSERT INTO company_documents (kind,version,title,sha256,"pageCount","byteSize","uploadedBy") VALUES ($1::varchar,1,$1::varchar,$2,1,100,$3)`, [kind, randomBytes(32).toString('hex'), users.manager.id]);
    const status = await documentStatus(db.manager, applicationId, true);
    expect(status.documents.map(doc => doc.kind)).toEqual(['SOP']);
  });
  it('stops an unused link with a new one, needs an email, and keeps someone who started on their reference', async () => {
    const noEmail = (await add([base(2, 'Sage')])).body.members[0].id;
    expect((await agents.manager.post('/api/dispatch/paperwork/links').set(headers).send({ memberIds: [noEmail] }).expect(201)).body.items[0].problem).toBe('Add their personal email first.');
    expect((await agents.manager.get('/api/dispatch/paperwork').set(headers).expect(200)).body.items[0].state).toBe('NO_EMAIL');
    const version = (await agents.manager.get(`/api/dispatch/members/${noEmail}`).set(headers).expect(200)).body.version;
    await agents.manager.patch(`/api/dispatch/members/${noEmail}/existing`).set(headers).send({ version, personalEmail: 'sage.home@example.test', companyEmail: 'real@company.com' }).expect(400);
    await agents.manager.patch(`/api/dispatch/members/${noEmail}/existing`).set(headers).send({ version: version + 5, personalEmail: 'sage.home@example.test' }).expect(409);
    await agents.manager.patch(`/api/dispatch/members/${noEmail}/existing`).set(headers).send({ version, personalEmail: 'sage.home@example.test', sopSignedOn: '2023-05-06' }).expect(200);
    const first = await link(noEmail), second = await link(noEmail);
    const refused = await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({ token: first.url.split('#').pop(), email: 'sage.home@example.test' }).expect(201);
    await expect(issueDemoCode(db, refused.body.challengeId, 'test')).rejects.toThrow();
    const { applicationId } = await open(second.url, 'sage.home@example.test');
    expect((await agents.manager.post('/api/dispatch/paperwork/links').set(headers).send({ memberIds: [noEmail] }).expect(201)).body.items[0].problem).toContain('already started');
    expect((await agents.manager.get(`/api/dispatch/members/${noEmail}`).set(headers).expect(200)).body.existing.catchUp.reference).toBe(applicationId);
    expect((await agents.other.get(`/api/dispatch/members/${noEmail}`).set(headers).expect(200)).body.existing.catchUp.reference).toBeNull();
  });
  it('gives IT the normal checklist when they leave, from what the manager recorded', async () => {
    const id = await addOne('Riley', { companyEmail: 'riley@example.test' });
    const version = (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body.version;
    await agents.manager.post(`/api/dispatch/members/${id}/leave`).set(headers).send({ version, leftAt: new Date().toISOString().slice(0, 10), reason: 'Resigned.', emailAfter: 'FORWARD' }).expect(201);
    const [removal] = await db.query(`SELECT * FROM it_removal_requests WHERE "memberId" = $1`, [id]);
    expect(removal).toMatchObject({ setupRequestId: null, emailAfter: 'FORWARD' });
    expect(removal.profile).toMatchObject({ companyEmail: 'riley@example.test', ringCentralNumber: null, noSetupRecord: true, setUpAt: null, mcName: 'Northwind Freight' });
    expect((await db.query(`SELECT kind FROM notification_deliveries`)).map((row: Row) => row.kind)).toContain('IT_REMOVAL_WAITING');
    const open = (await agents.it.get(`/api/it/removals/${removal.id}`).set(headers).expect(200)).body;
    expect(open.request.profile.noSetupRecord).toBe(true);
    // No number recorded: RingCentral finishes with no number outcome.
    await agents.it.patch(`/api/it/removals/${removal.id}/tasks/RINGCENTRAL`).set(headers).send({ version: open.request.version, status: 'COMPLETED' }).expect(200);
  });
  it('gives a support a checklist only when accounts were recorded, and stops an unused link when someone leaves', async () => {
    const dispatcher = await addOne('Taylor');
    const support = (row: number, name: string, extra: Row = {}): Row => ({ row, firstName: name, lastName: 'Support', position: 'Support', startedOn: '2025-01-02', supports: 'Taylor Fictional', ...extra });
    const { body } = await add([support(2, 'Plain', { personalEmail: 'plain.home@example.test' }), support(3, 'Mailbox', { companyEmail: 'mailbox@example.test' })]);
    const plain = body.members[0].id, mailbox = body.members[1].id;
    const sent = await link(plain);
    for (const id of [plain, mailbox]) {
      const version = (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body.version;
      await agents.manager.post(`/api/dispatch/members/${id}/leave`).set(headers).send({ version, leftAt: new Date().toISOString().slice(0, 10), reason: 'Moved on.' }).expect(201);
    }
    expect((await db.query(`SELECT "memberId" FROM it_removal_requests`)).map((row: Row) => row.memberId)).toEqual([mailbox]);
    const refused = await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({ token: sent.url.split('#').pop(), email: 'plain.home@example.test' }).expect(201);
    await expect(issueDemoCode(db, refused.body.challengeId, 'test')).rejects.toThrow();
    expect((await agents.manager.get('/api/dispatch/paperwork').set(headers).expect(200)).body.items.map((row: Row) => row.id)).toEqual([dispatcher]);
  });
  const version = async (id: string) => (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body.version as number;
  const correct = async (id: string, body: Row) => { const current = await version(id); return agents.manager.patch(`/api/dispatch/members/${id}/existing`).set(headers).send({ version: current, ...body }); };
  const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const leave = async (id: string, leftAt = inDays(0)) => { const current = await version(id); return agents.manager.post(`/api/dispatch/members/${id}/leave`).set(headers).send({ version: current, leftAt, reason: 'Moved on.' }).expect(201); };

  it('holds back the same person twice in one file until they are said to be different people', async () => {
    const support = (row: number, extra: Row = {}): Row => ({ row, firstName: 'Sky', lastName: 'Support', position: 'Support', startedOn: '2025-01-02', supports: 'Riley Fictional', ...extra });
    const rows = [base(2, 'Riley'), base(3, 'riley ', { personalEmail: 'other.riley@example.test' }), base(4, 'Riley', { mc: 'Lakeside Carriers', team: '' }), support(5), support(6)];
    const { body } = await check(rows);
    expect(body.rows.map((row: Row) => row.status)).toEqual(['READY', 'PROBLEM', 'READY', 'PROBLEM', 'PROBLEM']);
    expect(body.rows[1]).toMatchObject({ sameName: true, problems: ['Same name and MC as row 2. Left out unless you say they’re different people.'] });
    expect(body.rows[4].problems[0]).toContain('Same name as row 5.');
    const allowed = await check([base(2, 'Riley'), base(3, 'Riley', { differentPerson: true })]);
    expect(allowed.body.counts.ready).toBe(2);
  });
  it('tells same-named dispatchers apart when one is picked from the list', async () => {
    const north = await addOne('Riley'), lake = (await add([base(2, 'Riley', { mc: 'Lakeside Carriers', team: '' })])).body.members[0].id;
    expect((await agents.manager.get('/api/dispatch/existing/options').set(headers).expect(200)).body.dispatchers).toEqual(expect.arrayContaining([{ id: lake, name: 'Riley Fictional', mc: 'Lakeside Carriers' }]));
    const row = (extra: Row): Row => ({ row: 2, firstName: 'Sky', lastName: 'Support', position: 'Support', startedOn: '2025-01-02', ...extra });
    expect((await check([row({ supports: 'Riley Fictional' })])).body.rows[0].problems[0]).toContain('Use Add one person');
    const { body } = await add([row({ supportsMemberId: lake })]);
    expect((await agents.manager.get(`/api/dispatch/members/${body.members[0].id}`).set(headers).expect(200)).body.supportOf.dispatcherId).toBe(lake);
    // Someone on notice, or who left, can't take on a support.
    await leave(north, inDays(10));
    expect((await check([row({ firstName: 'Blake', supportsMemberId: north })])).body.rows[0].problems[0]).toContain('is leaving');
    expect((await check([row({ firstName: 'Blake', supportsMemberId: randomUUID() })])).body.rows[0].status).toBe('PROBLEM');
  });
  it('moves an unused link with a corrected email and stops it when the email is cleared', async () => {
    const id = await addOne('Dana');
    const sent = await link(id), token = sent.url.split('#').pop();
    await correct(id, { personalEmail: 'dana.right@example.test' }).then(res => expect(res.status).toBe(200));
    const refused = await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({ token, email: 'dana.home@example.test' }).expect(201);
    await expect(issueDemoCode(db, refused.body.challengeId, 'test')).rejects.toThrow();
    const accepted = await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({ token, email: 'dana.right@example.test' }).expect(201);
    await expect(issueDemoCode(db, accepted.body.challengeId, 'test')).resolves.toBeTruthy();
    await correct(id, { personalEmail: '' }).then(res => expect(res.status).toBe(200));
    const stopped = await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({ token, email: 'dana.right@example.test' }).expect(201);
    await expect(issueDemoCode(db, stopped.body.challengeId, 'test')).rejects.toThrow();
    expect((await agents.manager.get('/api/dispatch/paperwork').set(headers).expect(200)).body.items[0].state).toBe('NO_EMAIL');
  });
  it('closes started paperwork when someone leaves, for them, for review and for hand-over', async () => {
    const id = await addOne('Dana');
    const { agent, applicationId } = await open((await link(id)).url, 'dana.home@example.test');
    await agent.patch('/api/applicant/draft').set(headers).send({ version: 0, ...answers }).expect(200);
    await agent.post('/api/applicant/submit').set(headers).send({ version: 1, ...answers, accurate: true }).expect(201);
    expect((await openRecords(db.manager, users.manager.id)).counts.applications).toBe(1);
    await leave(id);
    await agent.get('/api/applicant/application').set(headers).expect(401);
    const resume = await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({ applicationId, email: 'dana.home@example.test' }).expect(201);
    await expect(issueDemoCode(db, resume.body.challengeId, 'test')).rejects.toThrow();
    await agents.manager.post(`/api/onboarding/applications/${applicationId}/reviews`).set(headers).send({ version: 2, decisionType: 'APPROVE', requestedFields: [], confirmed: true }).expect(409);
    await agents.manager.post(`/api/onboarding/applications/${applicationId}/reviews`).set(headers).send({ version: 2, decisionType: 'REQUEST_CHANGES', reason: 'Please fix.', requestedFields: ['telegram'], confirmed: false }).expect(409);
    // Only IT's removal is still theirs to hand over.
    expect((await openRecords(db.manager, users.manager.id)).counts).toMatchObject({ applications: 0, removals: 1, total: 1 });
    expect(await db.query(`SELECT event FROM application_activity a JOIN invitations i ON i.id = a."invitationId" WHERE i."catchUpMemberId" = $1 AND a.event = 'INVITATION_REVOKED'`, [id])).toHaveLength(1);
    expect((await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body.firstName).toBe('Dana');
  });
  it('gives the reference and the application only to the manager responsible', async () => {
    const id = await addOne('Dana');
    const { applicationId } = await open((await link(id)).url, 'dana.home@example.test');
    expect((await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body.existing.catchUp).toMatchObject({ applicationId, reference: applicationId });
    expect((await agents.other.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body.existing.catchUp).toMatchObject({ applicationId: null, reference: null, started: true });
    expect((await agents.other.get('/api/dispatch/paperwork').set(headers).expect(200)).body.items[0].applicationId).toBeNull();
  });
  it('gives someone who ran out of time more time, keeping what they did', async () => {
    const id = await addOne('Dana');
    const { agent, applicationId } = await open((await link(id)).url, 'dana.home@example.test');
    await agent.patch('/api/applicant/draft').set(headers).send({ version: 0, ...answers }).expect(200);
    const moreTime = (who: Agent) => who.post(`/api/dispatch/members/${id}/more-time`).set(headers).send({});
    const row = async (who: Agent = agents.manager) => (await who.get('/api/dispatch/paperwork').set(headers).expect(200)).body.items[0];
    // Only once their time has ended.
    await moreTime(agents.manager).expect(409);
    await db.query(`UPDATE dispatcher_applications SET "applicantAccessUntil" = now() - interval '1 day' WHERE id = $1`, [applicationId]);
    expect(await row()).toMatchObject({ state: 'TIME_ENDED', canReview: true, returnEmail: 'dana.home@example.test' });
    expect(await row(agents.other)).toMatchObject({ state: 'TIME_ENDED', canReview: false, returnEmail: null });
    expect((await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body.existing.catchUp.timeEndedAt).toBeTruthy();
    await agent.get('/api/applicant/application').set(headers).expect(401);
    // Another manager can't, and IT can't reach it at all.
    await moreTime(agents.other).expect(403);
    await moreTime(agents.it).expect(403);
    const given = await moreTime(agents.manager).expect(201);
    expect(new Date(given.body.accessUntil).getTime()).toBeGreaterThan(Date.now() + 13 * 86400000);
    expect((await row()).state).toBe('IN_PROGRESS');
    const own = (await agent.get('/api/applicant/application').set(headers).expect(200)).body;
    expect(own.application.fields).toMatchObject({ preferredAmericanFirstName: 'Dana', firstName: 'Legal' });
    expect(await db.query(`SELECT "actorId" FROM application_activity a JOIN invitations i ON i.id = a."invitationId" WHERE i."catchUpMemberId" = $1 AND a.event = 'ACCESS_EXTENDED'`, [id])).toEqual([{ actorId: users.manager.id }]);
    // A lapsed correction gets it too; someone waiting for their manager doesn't need it; someone who left can't have it.
    await agent.post('/api/applicant/submit').set(headers).send({ version: 1, ...answers, accurate: true }).expect(201);
    await db.query(`UPDATE dispatcher_applications SET "applicantAccessUntil" = now() - interval '1 day' WHERE id = $1`, [applicationId]);
    expect((await row()).state).toBe('WAITING');
    await moreTime(agents.manager).expect(409);
    await agents.manager.post(`/api/onboarding/applications/${applicationId}/reviews`).set(headers).send({ version: 2, decisionType: 'REQUEST_CHANGES', reason: 'Please fix your Telegram.', requestedFields: ['telegram'], confirmed: false }).expect(201);
    await db.query(`UPDATE dispatcher_applications SET "applicantAccessUntil" = now() - interval '1 day' WHERE id = $1`, [applicationId]);
    expect((await row()).state).toBe('TIME_ENDED');
    await moreTime(agents.manager).expect(201);
    await db.query(`UPDATE dispatcher_applications SET "applicantAccessUntil" = now() - interval '1 day' WHERE id = $1`, [applicationId]);
    await leave(id);
    await moreTime(agents.manager).expect(409);
  });
  it('carries corrected accounts to the open removal during a notice', async () => {
    const id = await addOne('Riley');
    await leave(id, inDays(10));
    const [before] = await db.query(`SELECT * FROM it_removal_requests WHERE "memberId" = $1`, [id]);
    expect(before.profile).toMatchObject({ companyEmail: null, ringCentralNumber: null });
    await correct(id, { companyEmail: 'riley@example.test', ringCentralNumber: '+1 469 555 0142' }).then(res => expect(res.status).toBe(200));
    const [after] = await db.query(`SELECT * FROM it_removal_requests WHERE "memberId" = $1`, [id]);
    expect(after.profile).toMatchObject({ companyEmail: 'riley@example.test', ringCentralNumber: '+1 469 555 0142', noSetupRecord: true });
    expect(after.version).toBe(before.version + 1);
    const activity = async () => db.query(`SELECT metadata FROM it_removal_activity WHERE "requestId" = $1 AND event = 'ACCOUNTS_CORRECTED' ORDER BY "createdAt"`, [after.id]);
    expect(await activity()).toEqual([{ metadata: { reopened: false } }]);
    expect(JSON.stringify(await activity())).not.toContain('riley@example.test');
    // A manager asks for access to go now; IT finishes RingCentral, then a different number turns up.
    const current = await version(id);
    await agents.manager.post(`/api/dispatch/members/${id}/remove-access`).set(headers).send({ version: current, reason: 'Left early.' }).expect(201);
    const detail = (await agents.it.get(`/api/it/removals/${after.id}`).set(headers).expect(200)).body;
    await agents.it.patch(`/api/it/removals/${after.id}/tasks/RINGCENTRAL`).set(headers).send({ version: detail.request.version, status: 'COMPLETED', numberOutcome: 'RELEASED' }).expect(200);
    await correct(id, { ringCentralNumber: '+1 469 555 0199' }).then(res => expect(res.status).toBe(200));
    const [reopened] = await db.query(`SELECT r."numberOutcome", t.status FROM it_removal_requests r JOIN it_removal_tasks t ON t."requestId" = r.id AND t.key = 'RINGCENTRAL' WHERE r.id = $1`, [after.id]);
    expect(reopened).toEqual({ numberOutcome: null, status: 'PENDING' });
    expect((await activity()).at(-1)).toEqual({ metadata: { reopened: true } });
  });
  it('opens a removal for a support whose accounts are recorded during their notice', async () => {
    await addOne('Taylor');
    const id = (await add([{ row: 2, firstName: 'Sky', lastName: 'Support', position: 'Support', startedOn: '2025-01-02', supports: 'Taylor Fictional' }])).body.members[0].id;
    await leave(id, inDays(10));
    expect(await db.query(`SELECT id FROM it_removal_requests WHERE "memberId" = $1`, [id])).toEqual([]);
    await correct(id, { companyEmail: 'sky@example.test' }).then(res => expect(res.status).toBe(200));
    const [removal] = await db.query(`SELECT "dueOn"::text AS "dueOn", profile FROM it_removal_requests WHERE "memberId" = $1`, [id]);
    expect(removal).toMatchObject({ dueOn: inDays(10), profile: { companyEmail: 'sky@example.test', noSetupRecord: true } });
    expect((await db.query(`SELECT kind FROM notification_deliveries`)).map((row: Row) => row.kind)).toContain('IT_REMOVAL_SCHEDULED');
  });
  it('refuses a rollback while existing records are kept', async () => {
    await addOne('Riley');
    const runner = db.createQueryRunner();
    const { ExistingDispatchers1792960000000: Migration } = await import('../src/database/migrations/1792960000000-ExistingDispatchers');
    await expect(new Migration().down(runner)).rejects.toThrow('Cannot discard existing dispatcher records');
    await runner.release();
  });
});
