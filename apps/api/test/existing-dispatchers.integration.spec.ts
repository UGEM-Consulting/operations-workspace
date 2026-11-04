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
    expect(body.counts).toEqual({ ready: 2, choice: 4, problem: 3, already: 0, noStartDate: 0, noMc: 0, mcFromTeam: 0 });
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
    expect(event.metadata).toEqual({ source: 'file', paper: 1, noStartDate: false, noMc: false });
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
  it('keeps a link in use with the manager who sent it, until it ends', async () => {
    const id = await addOne('Rowan');
    const sent = async (agent: Agent) => (await agent.post('/api/dispatch/paperwork/links').set(headers).send({ memberIds: [id] }).expect(201)).body.items[0];
    const first = await link(id), owner = async () => (await db.query(`SELECT "managerId" FROM invitations WHERE "catchUpMemberId" = $1 AND "revokedAt" IS NULL`, [id])) as { managerId: string }[];
    const refused = await sent(agents.other);
    expect(refused.problem).toContain('Another manager');
    expect(refused.url).toBeUndefined();
    expect(await owner()).toEqual([{ managerId: users.manager.id }]);
    // The link they were sent still works.
    await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({ token: first.url.split('#').pop(), email: 'rowan.home@example.test' }).expect(201);
    // Once it has run out nobody can use it, so any manager may carry on.
    await db.query(`UPDATE invitations SET "expiresAt" = now() - interval '1 minute' WHERE "catchUpMemberId" = $1`, [id]);
    expect((await sent(agents.other)).url).toBeTruthy();
    expect(await owner()).toEqual([{ managerId: users.other.id }]);
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
  describe('details not known yet', () => {
    const missing = (row: number, name: string, extra: Row = {}) => base(row, name, { mc: '', team: '', startedOn: '', ...extra });
    const page = async (id: string) => (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body;
    const list = async () => (await agents.manager.get('/api/dispatch/members').set(headers).expect(200)).body.items as Row[];
    const place = (id: string, version: number, body: Row, status = 201) => agents.manager.post(`/api/dispatch/members/${id}/place`).set(headers).send({ version, ...body }).expect(status);
    const setStart = (id: string, version: number, body: Row, status = 201) => agents.manager.post(`/api/dispatch/members/${id}/start-date`).set(headers).send({ version, ...body }).expect(status);
    const mcId = async (name: string) => (await db.query(`SELECT id FROM mcs WHERE name = $1`, [name]))[0].id as string;

    it('counts rows with no start date or MC as ready, and says how many, but a date that can’t be read is still a problem', async () => {
      const { body } = await check([missing(2, 'Blank'), base(3, 'Undated', { startedOn: '' }), missing(4, 'Typo', { startedOn: 'Marhc 2024' }), missing(5, 'Team', { team: 'Red team' }), missing(6, 'Typed', { mc: 'No MC yet' })]);
      expect(body.rows.map((row: Row) => row.status)).toEqual(['READY', 'READY', 'PROBLEM', 'READY', 'READY']);
      expect(body.counts).toEqual({ ready: 4, choice: 0, problem: 1, already: 0, noStartDate: 4, noMc: 2, mcFromTeam: 1 });
    });
    it('still needs a job title for a dispatcher', async () => {
      expect((await check([missing(2, 'Untitled', { jobTitle: '' })])).body.rows[0]).toMatchObject({ status: 'PROBLEM', problems: ['Job title is empty.'] });
    });
    it('lets a team bring its MC, by its name or its lead’s name, and asks about a team it can’t find', async () => {
      const { body } = await add([missing(2, 'Teamed', { team: 'red TEAM', startedOn: '2024-03-04' })]);
      const profile = await page(body.members[0].id);
      expect(profile.current).toMatchObject({ mc: 'Northwind Freight', team: 'Red team' });
      expect(profile.existing).toMatchObject({ startDateKnown: true, periodDateKnown: true });
      await db.query(`UPDATE teams SET "leadMemberId" = $1 WHERE name = 'Red team'`, [body.members[0].id]);
      expect((await add([missing(2, 'Led', { team: 'Teamed Fictional' })])).body.added).toBe(1);
      const unknown = await check([missing(2, 'Lost', { team: 'Chen' })]);
      expect(unknown.body.rows[0].status).toBe('CHOICE');
      expect(unknown.body.choices).toEqual([{ field: 'team', text: 'Chen', rows: [2] }]);
    });
    it('never treats someone with no MC as Independent, and gives them no period', async () => {
      const id = (await add([missing(2, 'Nomc')])).body.members[0].id;
      const profile = await page(id);
      expect(profile).toMatchObject({ status: 'ACTIVE', current: null, history: [], existing: { startDateKnown: false, periodDateKnown: true } });
      expect((await list()).find(row => row.id === id)).toMatchObject({ placed: false, mc: 'No MC yet', startDateKnown: false });
      const [event] = await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'EXISTING_ADDED' AND "memberId" = $1`, [id]);
      expect(event.metadata).toMatchObject({ noStartDate: true, noMc: true });
      const solo = (await add([base(2, 'Solo', { mc: 'Independent', team: '' })])).body.members[0].id;
      expect((await list()).find(row => row.id === solo)).toMatchObject({ placed: true, mc: null });
    });
    it('keeps a second upload from adding someone with no MC twice', async () => {
      await add([missing(2, 'Nomc')]);
      const again = await check([base(2, 'Nomc'), missing(3, 'nomc')]);
      expect(again.body.rows.map((row: Row) => [row.status, row.sameName])).toEqual([['ALREADY', true], ['ALREADY', true]]);
      expect((await check([base(2, 'Nomc', { differentPerson: true })])).body.rows[0].status).toBe('READY');
      const file = await check([missing(2, 'Twice'), base(3, 'Twice', { startedOn: '' })]);
      expect(file.body.rows[1]).toMatchObject({ status: 'PROBLEM', sameName: true });
      expect((await check([base(2, 'Already')])).body.rows[0].status).toBe('READY');
      await add([base(2, 'Already')]);
      expect((await check([missing(2, 'Already')])).body.rows[0]).toMatchObject({ status: 'ALREADY', sameName: true });
    });
    it('sets the first MC and team without a reason, once, following the start date when it has no date', async () => {
      const id = (await add([missing(2, 'Place')])).body.members[0].id, northwind = await mcId('Northwind Freight');
      const [team] = await db.query(`SELECT id FROM teams WHERE name = 'Red team'`);
      await place(id, 99, { mcId: northwind }, 409);
      await place(id, 1, { mcId: await mcId('Lakeside Carriers'), teamId: team.id }, 400);
      await place(id, 1, { mcId: northwind, teamId: team.id });
      const profile = await page(id);
      expect(profile.current).toMatchObject({ mc: 'Northwind Freight', team: 'Red team' });
      expect(profile.existing.periodDateKnown).toBe(false);
      expect((await list()).find(row => row.id === id)).toMatchObject({ placed: true, sinceKnown: false });
      await place(id, profile.version, { mcId: northwind }, 409);
      // Their start date, when found, is the first period's date too.
      await setStart(id, profile.version, { startedOn: '2023-05-01' });
      const dated = await page(id);
      expect(new Date(dated.history[0].startedAt).toISOString()).toBe('2023-05-01T12:00:00.000Z');
      expect(dated.existing).toMatchObject({ startDateKnown: true, periodDateKnown: true, startDateChanges: [{ startedOn: '2023-05-01', previousOn: null, reason: null }] });
      const [event] = await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'MEMBER_PLACED' AND "memberId" = $1`, [id]);
      expect(event.metadata).toEqual({ fields: ['mcId', 'teamId'], dated: false });
    });
    it('keeps a period’s own date, and refuses a date before a known start', async () => {
      const northwind = await mcId('Northwind Freight');
      const known = (await add([base(2, 'Known', { mc: '', team: '' })])).body.members[0].id;
      await place(known, 1, { mcId: northwind, startedAt: '2020-01-01' }, 400);
      await place(known, 1, { mcId: northwind, startedAt: '2024-06-01' });
      const profile = await page(known);
      expect(new Date(profile.history[0].startedAt).toISOString()).toBe('2024-06-01T12:00:00.000Z');
      expect(profile.existing.periodDateKnown).toBe(true);
      // A start date can't then be later than when that period began.
      await setStart(known, profile.version, { startedOn: '2025-01-01', reason: 'Payroll says so.' }, 400);
      await setStart(known, profile.version, { startedOn: '2024-01-15', reason: 'Payroll says so.' });
      const corrected = await page(known);
      expect(new Date(corrected.history[0].startedAt).toISOString()).toBe('2024-06-01T12:00:00.000Z');
      expect(new Date(corrected.joinedAt).toISOString()).toBe('2024-01-15T12:00:00.000Z');
    });
    it('corrects a start date with a reason, moves the first period with it, and leaves a move alone', async () => {
      const id = await addOne('Correct');
      let profile = await page(id);
      await setStart(id, profile.version, { startedOn: '2024-02-19' }, 400);
      await setStart(id, profile.version, { startedOn: '2099-01-01', reason: 'Future' }, 400);
      await setStart(id, profile.version, { startedOn: '2024-02-30', reason: 'No such day' }, 400);
      await setStart(id, profile.version, { startedOn: '1970-01-01', reason: 'Too long ago' }, 400);
      await setStart(id, profile.version, { startedOn: '2024-02-19', reason: 'The file had the date of their first paycheck.' });
      profile = await page(id);
      expect(new Date(profile.history[0].startedAt).toISOString()).toBe('2024-02-19T12:00:00.000Z');
      expect(profile.existing.startDateChanges[0]).toMatchObject({ startedOn: '2024-02-19', previousOn: '2024-03-04', reason: 'The file had the date of their first paycheck.' });
      await agents.manager.post(`/api/dispatch/members/${id}/move`).set(headers).send({ version: profile.version, mcId: await mcId('Lakeside Carriers'), startedAt: '2025-06-02', reason: 'Needed there' }).expect(201);
      profile = await page(id);
      await setStart(id, profile.version, { startedOn: '2025-07-01', reason: 'After the move' }, 400);
      await setStart(id, profile.version, { startedOn: '2024-01-08', reason: 'Payroll' });
      profile = await page(id);
      expect(profile.history.map((row: Row) => new Date(row.startedAt as string).toISOString().slice(0, 10))).toEqual(['2025-06-02', '2024-01-08']);
      const events = await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'START_DATE_RECORDED' AND "memberId" = $1`, [id]);
      expect(JSON.stringify(events)).not.toContain('2024');
      expect(events[0].metadata).toMatchObject({ fields: ['startDate'], corrected: true, periodMoved: true });
    });
    it('gives a support with no start date a date through their dispatcher link', async () => {
      const dispatcher = (await add([missing(2, 'Lead')])).body.members[0].id;
      const support = (await add([{ row: 2, firstName: 'Sky', lastName: 'Fictional', position: 'Support', supportsMemberId: dispatcher }])).body.members[0].id;
      let profile = await page(support);
      expect(profile.supportOf).toMatchObject({ dispatcher: 'Lead Fictional', mc: 'No MC yet' });
      expect(profile.existing).toMatchObject({ startDateKnown: false, periodDateKnown: false });
      await place(support, profile.version, { mcId: await mcId('Northwind Freight') }, 400);
      await setStart(support, profile.version, { startedOn: '2025-01-13' });
      profile = await page(support);
      expect(new Date(profile.supportOf.startedAt).toISOString()).toBe('2025-01-13T12:00:00.000Z');
    });
    it('lets someone with no MC or start date leave and get a paperwork link', async () => {
      const id = (await add([missing(2, 'Leaver', { personalEmail: 'leaver.home@example.test' })])).body.members[0].id;
      expect((await link(id)).url).toBeTruthy();
      expect((await agents.manager.get('/api/dispatch/paperwork').set(headers).expect(200)).body.items.find((row: Row) => row.id === id).mc).toBe('No MC yet');
      const profile = await page(id);
      await agents.manager.post(`/api/dispatch/members/${id}/leave`).set(headers).send({ version: profile.version, leftAt: new Date().toISOString().slice(0, 10), reason: 'Moved away' }).expect(201);
      const left = await page(id);
      expect(left.status).toBe('LEFT');
      await setStart(id, left.version, { startedOn: '2024-01-01' }, 409);
    });
    it('is only for someone added by hand, and only for staff who manage dispatchers', async () => {
      await agents.it.post(`/api/dispatch/members/${randomUUID()}/place`).set(headers).send({ version: 1, mcId: null }).expect(403);
      await agents.it.post(`/api/dispatch/members/${randomUUID()}/start-date`).set(headers).send({ version: 1, startedOn: '2024-01-01' }).expect(403);
      const [approved] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",position,status,"joinedAt") VALUES ('Approved','Fictional','DISPATCHER','ACTIVE',now()) RETURNING id`);
      await place(approved.id, 1, { mcId: null }, 400);
      await setStart(approved.id, 1, { startedOn: '2024-01-01' }, 400);
    });
    it('moves a promoted support’s undated support period, not their later one', async () => {
      const dispatcher = (await add([base(2, 'Lead')])).body.members[0].id;
      const id = (await add([{ row: 2, firstName: 'Sky', lastName: 'Fictional', position: 'Support', supportsMemberId: dispatcher }])).body.members[0].id;
      const [{ id: linkId, startedAt }] = await db.query(`SELECT id, "startedAt" FROM member_support_links WHERE "supportId" = $1`, [id]);
      expect((await page(id)).existing.undatedPeriodId).toBe(linkId);
      // As a promotion leaves them: the support link ended, and a dispatcher period from then on.
      const promoted = new Date(new Date(startedAt).getTime() + 3600000);
      await db.query(`UPDATE member_support_links SET "endedAt" = $2 WHERE id = $1`, [linkId, promoted]);
      await db.query(`UPDATE dispatch_members SET position = 'DISPATCHER' WHERE id = $1`, [id]);
      const [{ id: placedId }] = await db.query(`INSERT INTO member_assignments ("memberId","mcId","teamId","startedAt",reason) VALUES ($1,$2,NULL,$3,'Promoted') RETURNING id`, [id, await mcId('Northwind Freight'), promoted]);
      const before = await page(id);
      expect(before.existing.undatedPeriodId).toBe(linkId);
      await setStart(id, before.version, { startedOn: '2025-01-13' });
      const [link] = await db.query(`SELECT "startedAt", "endedAt" FROM member_support_links WHERE id = $1`, [linkId]);
      const [placed] = await db.query(`SELECT "startedAt" FROM member_assignments WHERE id = $1`, [placedId]);
      expect(new Date(link.startedAt).toISOString()).toBe('2025-01-13T12:00:00.000Z');
      expect(new Date(placed.startedAt).getTime()).toBe(promoted.getTime());
      expect(new Date(link.endedAt).getTime()).toBeLessThanOrEqual(new Date(placed.startedAt).getTime());
      expect((await page(id)).existing.undatedPeriodId).toBeNull();
    });
    it('doesn’t call a blank MC with an unfound team the same as Independent', async () => {
      await add([base(2, 'Solo', { mc: 'Independent', team: '' })]);
      const row = (await check([missing(2, 'Solo', { team: 'Chen' })])).body.rows[0];
      expect(row).toMatchObject({ status: 'CHOICE', sameName: false });
      const file = (await check([base(2, 'Twin', { mc: 'Independent', team: '' }), missing(3, 'Twin', { team: 'Chen' })])).body.rows;
      expect(file[1]).toMatchObject({ status: 'CHOICE', sameName: false });
      // Once chosen, the MC is known and the usual check applies.
      await add([base(2, 'Chosen')]);
      expect((await check([missing(2, 'Chosen', { team: 'Red team' })])).body.rows[0]).toMatchObject({ status: 'ALREADY', sameName: true });
    });
    it('settles on the team a name names, even when it is also another team’s lead', async () => {
      const northwind = await mcId('Northwind Freight');
      const [lead] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",position,status,"joinedAt") VALUES ('Red','team','DISPATCHER','ACTIVE',now()) RETURNING id`);
      await db.query(`INSERT INTO teams (name,"nameKey","mcId","leadMemberId") VALUES ('Blue team','blue team',$1,$2)`, [northwind, lead.id]);
      const { body } = await add([missing(2, 'Named', { team: 'Red team' })]);
      expect((await page(body.members[0].id)).current.team).toBe('Red team');
      const withMc = (await add([base(2, 'Withmc', { team: 'Red team' })])).body.members[0].id;
      expect((await page(withMc)).current.team).toBe('Red team');
    });
    it('shows no MC to come for a support who has left, and still knows who was added by hand', async () => {
      const dispatcher = (await add([base(2, 'Lead')])).body.members[0].id;
      const id = (await add([{ row: 2, firstName: 'Gone', lastName: 'Fictional', position: 'Support', supportsMemberId: dispatcher, startedOn: '2024-03-04' }])).body.members[0].id;
      expect((await list()).find(row => row.id === id)).toMatchObject({ addedByHand: true, mc: 'Northwind Freight' });
      const profile = await page(id);
      await agents.manager.post(`/api/dispatch/members/${id}/leave`).set(headers).send({ version: profile.version, leftAt: new Date().toISOString().slice(0, 10), reason: 'Moved away' }).expect(201);
      expect((await list()).find(row => row.id === id)).toMatchObject({ placed: false, mc: null, addedByHand: true });
      const [approved] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName",position,status,"joinedAt") VALUES ('Approved','Fictional','DISPATCHER','ACTIVE',now()) RETURNING id`);
      expect((await list()).find(row => row.id === approved.id)).toMatchObject({ addedByHand: false });
    });
    it('tells IT someone had no MC yet, not that they were Independent', async () => {
      const nomc = (await add([missing(2, 'Nomc', { companyEmail: 'nomc@example.test' })])).body.members[0].id, solo = (await add([base(2, 'Solo', { mc: 'Independent', team: '' })])).body.members[0].id;
      for (const id of [nomc, solo]) { const { version } = await page(id); await agents.manager.post(`/api/dispatch/members/${id}/leave`).set(headers).send({ version, leftAt: new Date().toISOString().slice(0, 10), reason: 'Moved away' }).expect(201); }
      const profile = async (id: string) => (await db.query(`SELECT profile FROM it_removal_requests WHERE "memberId" = $1`, [id]))[0].profile;
      expect((await profile(nomc)).mcName).toBe('No MC yet');
      expect((await profile(solo)).mcName).toBeNull();
    });
    it('makes a promotion choose an MC when the dispatcher has none, and hides an unrecorded date from the team lead', async () => {
      const [mc] = [await mcId('Northwind Freight')];
      const placedLead = (await add([base(2, 'Lead')])).body.members[0].id, unplaced = (await add([missing(2, 'Unplaced')])).body.members[0].id;
      const support = (await add([{ row: 2, firstName: 'Sky', lastName: 'Fictional', position: 'Support', supportsMemberId: unplaced }])).body.members[0].id;
      await db.query(`INSERT INTO promotion_requests ("supportId","requestedBy",reason) VALUES ($1,$2,'Ready')`, [support, users.manager.id]);
      const rows = (await agents.manager.get('/api/dispatch/promotions').set(headers).expect(200)).body.items;
      expect(rows[0]).toMatchObject({ supportId: support, dispatcherPlaced: false, mcId: null });
      // The team lead's page: a support linked to a dispatcher in their team, added with no date.
      const undated = (await add([{ row: 2, firstName: 'Undated', lastName: 'Fictional', position: 'Support', supportsMemberId: placedLead }])).body.members[0].id;
      const dated = (await add([{ row: 2, firstName: 'Dated', lastName: 'Fictional', position: 'Support', supportsMemberId: placedLead, startedOn: '2024-03-04' }])).body.members[0].id;
      const lead = await db.getRepository(User).save({ firstName: 'Fictional', lastName: 'Lead', email: 'existing.lead@example.test', role: Role.TEAM_LEAD, status: UserStatus.ACTIVE, passwordHash: await hashPassword(password) });
      await db.query(`UPDATE dispatch_members SET "accountUserId" = $1 WHERE id = $2`, [lead.id, placedLead]);
      await db.query(`UPDATE teams SET "leadMemberId" = $1 WHERE "mcId" = $2`, [placedLead, mc]);
      const agent = request.agent(app.getHttpServer());
      await agent.post('/api/auth/login').set(headers).send({ email: lead.email, password }).expect(200);
      const team = (await agent.get('/api/team').set(headers).expect(200)).body;
      const supports = team.teams.flatMap((item: { supports?: Row[]; members?: { supports?: Row[] }[] }) => item.supports ?? item.members?.flatMap(row => row.supports ?? []) ?? []).concat(team.supports ?? []);
      expect(supports.find((row: Row) => row.id === undated)).toMatchObject({ sinceKnown: false });
      expect(supports.find((row: Row) => row.id === dated)).toMatchObject({ sinceKnown: true });
    });
    it('refuses a rollback while missing details or their history are kept', async () => {
      await add([missing(2, 'Kept')]);
      const runner = db.createQueryRunner();
      const { MissingDetails1792980000000: Migration } = await import('../src/database/migrations/1792980000000-MissingDetails');
      await expect(new Migration().down(runner)).rejects.toThrow('Cannot discard missing details or start date history');
      await runner.release();
    });
  });
  describe('support and updater', () => {
    const page = async (id: string) => (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body;
    const list = async () => (await agents.manager.get('/api/dispatch/members').set(headers).expect(200)).body.items as Row[];
    const helper = (row: number, first: string, position: string) => ({ row, firstName: first, lastName: 'Fictional', position, supports: 'Lead Fictional', startedOn: '2024-03-04' });

    it('takes Updater in the file, treats it as a support, and catches a typo', async () => {
      const { body } = await check([base(2, 'Lead'), helper(3, 'Sky', 'Support'), helper(4, 'Ann', 'updater'), helper(5, 'Bo', 'Update')]);
      expect(body.rows[1]).toMatchObject({ status: 'READY', position: 'SUPPORT', supportType: 'SUPPORT' });
      expect(body.rows[2]).toMatchObject({ status: 'READY', position: 'SUPPORT', supportType: 'UPDATER' });
      expect(body.rows[3]).toMatchObject({ status: 'PROBLEM', problems: ['Position “Update” should be Dispatcher, Support or Updater.'] });
      expect((await check([{ ...helper(2, 'Mc', 'Updater'), mc: 'Northwind Freight' }])).body.rows[0].problems).toContain('An updater has no MC, team or job title of their own. Leave them empty.');
      const added = (await add([base(2, 'Lead'), helper(3, 'Ann', 'Updater')])).body;
      const id = added.members.find((row: Row) => row.row === 3).id;
      const profile = await page(id);
      expect(profile).toMatchObject({ position: 'SUPPORT', supportType: 'UPDATER', jobTitle: null, supportOf: { dispatcher: 'Lead Fictional', mc: 'Northwind Freight', team: 'Red team' }, supportTypeChanges: [] });
      expect((await list()).find(row => row.id === id)).toMatchObject({ position: 'SUPPORT', supportType: 'UPDATER', mc: 'Northwind Freight' });
      const lead = await page(added.members.find((row: Row) => row.row === 2).id);
      expect(lead.supportType).toBe('SUPPORT');
      expect(lead.supports).toMatchObject([{ id, supportType: 'UPDATER' }]);
    });
    it('says one thing about a position it can’t read, and offers no job title to choose', async () => {
      const blank = await check([{ row: 2, firstName: 'Bo', lastName: 'Fictional', position: 'Update' }]);
      expect(blank.body.rows[0]).toMatchObject({ status: 'PROBLEM', problems: ['Position “Update” should be Dispatcher, Support or Updater.'] });
      expect(blank.body.choices.filter((item: Row) => item.field === 'jobTitle')).toEqual([]);
      const typed = await check([{ row: 2, firstName: 'Bo', lastName: 'Fictional', position: 'Update', jobTitle: 'Nothing like it' }]);
      expect(typed.body.rows[0].status).toBe('PROBLEM');
      expect(typed.body.choices.filter((item: Row) => item.field === 'jobTitle')).toEqual([]);
      // A dispatcher still needs a job title, written or left empty.
      expect((await check([{ row: 2, firstName: 'Cy', lastName: 'Fictional', position: 'Dispatcher', mc: 'Independent' }])).body.rows[0].problems).toEqual(['Job title is empty.']);
      expect((await check([{ row: 2, firstName: 'Di', lastName: 'Fictional', mc: 'Independent', jobTitle: 'Nothing like it' }])).body.choices).toMatchObject([{ field: 'jobTitle', text: 'Nothing like it' }]);
    });
    it('names an updater in what the file is told', async () => {
      const rows = (await check([{ row: 2, firstName: 'An', lastName: 'Fictional', position: 'Updater' }, { row: 3, firstName: 'Su', lastName: 'Fictional', position: 'Support' }, helper(4, 'Lo', 'Updater')])).body.rows;
      expect(rows[0].problems).toEqual(['An updater needs the dispatcher they assist.']);
      expect(rows[1].problems).toEqual(['A support needs the dispatcher they assist.']);
      expect(rows[2].problems).toEqual(['Assists “Lead Fictional”, who isn’t in this file or the workspace.']);
    });
    it('changes between the two without touching anything else, and keeps the change', async () => {
      const added = (await add([base(2, 'Lead'), helper(3, 'Sky', 'Support')])).body;
      const id = added.members.find((row: Row) => row.row === 3).id, leadId = added.members.find((row: Row) => row.row === 2).id;
      const change = (member: string, version: number, supportType: string, status = 201) => agents.manager.post(`/api/dispatch/members/${member}/support-type`).set(headers).send({ version, supportType }).expect(status);
      await agents.it.post(`/api/dispatch/members/${id}/support-type`).set(headers).send({ version: 1, supportType: 'UPDATER' }).expect(403);
      await change(id, 99, 'UPDATER', 409);
      await change(id, 1, 'MANAGER', 400);
      await change(leadId, 1, 'UPDATER', 400);
      const before = await page(id);
      await change(id, before.version, 'UPDATER');
      const after = await page(id);
      expect(after).toMatchObject({ supportType: 'UPDATER', position: 'SUPPORT', supportOf: { dispatcherId: leadId }, supportTypeChanges: [{ to: 'UPDATER' }] });
      // Choosing what they already are changes nothing.
      await change(id, after.version, 'UPDATER');
      expect((await page(id)).version).toBe(after.version);
      const [event] = await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'SUPPORT_TYPE_CHANGED' AND "memberId" = $1`, [id]);
      expect(event.metadata).toEqual({ fields: ['supportType'], to: 'UPDATER' });
    });
    it('invites someone as an updater, and refuses it on a dispatcher invitation', async () => {
      const lead = (await add([base(2, 'Lead')])).body.members[0].id;
      await agents.manager.post('/api/onboarding/invitations').set(headers).send({ supportType: 'UPDATER' }).expect(400);
      const made = await agents.manager.post('/api/onboarding/invitations').set(headers).send({ position: 'SUPPORT', supportType: 'UPDATER', supportsMemberId: lead }).expect(201);
      const rows = (await agents.manager.get('/api/onboarding/invitations').set(headers).expect(200)).body as Row[];
      expect(rows.find(row => row.id === made.body.id)).toMatchObject({ position: 'SUPPORT', supportType: 'UPDATER', member: null });
      // Applying as a support does, with no employment questions, and what they're called can change at approval.
      const { agent, applicationId } = await open(made.body.url, 'updater.fictional@example.test');
      expect((await agent.get('/api/applicant/application').set(headers).expect(200)).body.invitation.supportType).toBe('UPDATER');
      await agent.patch('/api/applicant/draft').set(headers).send({ version: 0, ...answers }).expect(200);
      await agent.post('/api/applicant/submit').set(headers).send({ version: 1, ...answers, accurate: true }).expect(201);
      const detail = (await agents.manager.get(`/api/onboarding/applications/${applicationId}`).set(headers).expect(200)).body;
      expect(detail.supports).toMatchObject({ supportType: 'UPDATER', supportsMemberId: lead });
      expect(detail.member).toBeNull();
      const review = { version: 2, decisionType: 'APPROVE', confirmed: true, supportsMemberId: lead };
      await agents.manager.post(`/api/onboarding/applications/${applicationId}/reviews`).set(headers).send({ ...review, supportType: 'MANAGER' }).expect(400);
      await agents.manager.post(`/api/onboarding/applications/${applicationId}/reviews`).set(headers).send(review).expect(201);
      const member = (await list()).find(row => row.dispatcherId === lead);
      expect(member).toMatchObject({ position: 'SUPPORT', supportType: 'UPDATER', status: 'ACTIVE', mc: 'Northwind Freight' });
      expect((await db.query(`SELECT count(*)::integer AS n FROM it_onboarding_requests`))[0].n).toBe(0);
      // Their record decides from here: a change shows on the application and the invitations list, and the invitation keeps what was chosen.
      await agents.manager.post(`/api/dispatch/members/${member!.id}/support-type`).set(headers).send({ version: (member as Row).version, supportType: 'SUPPORT' }).expect(201);
      expect((await agents.manager.get(`/api/onboarding/applications/${applicationId}`).set(headers).expect(200)).body).toMatchObject({ invitation: { supportType: 'UPDATER' }, member: { position: 'SUPPORT', supportType: 'SUPPORT' } });
      const after = (await agents.manager.get('/api/onboarding/invitations').set(headers).expect(200)).body as Row[];
      expect(after.find(row => row.id === made.body.id)).toMatchObject({ supportType: 'UPDATER', member: { position: 'SUPPORT', supportType: 'SUPPORT' } });
    });
    it('lets a manager change it at approval, and a promotion ends it', async () => {
      const lead = (await add([base(2, 'Lead')])).body.members[0].id;
      const made = await agents.manager.post('/api/onboarding/invitations').set(headers).send({ position: 'SUPPORT', supportsMemberId: lead }).expect(201);
      const { agent, applicationId } = await open(made.body.url, 'changed.fictional@example.test');
      await agent.patch('/api/applicant/draft').set(headers).send({ version: 0, ...answers }).expect(200);
      await agent.post('/api/applicant/submit').set(headers).send({ version: 1, ...answers, accurate: true }).expect(201);
      await agents.manager.post(`/api/onboarding/applications/${applicationId}/reviews`).set(headers).send({ version: 2, decisionType: 'REQUEST_CHANGES', reason: 'Check your phone', requestedFields: ['personalPhoneNumber'], supportType: 'UPDATER' }).expect(400);
      await agents.manager.post(`/api/onboarding/applications/${applicationId}/reviews`).set(headers).send({ version: 2, decisionType: 'APPROVE', confirmed: true, supportsMemberId: lead, supportType: 'UPDATER' }).expect(201);
      const member = (await list()).find(row => row.dispatcherId === lead)!;
      expect(member.supportType).toBe('UPDATER');
      const [{ id: requestId }] = await db.query(`INSERT INTO promotion_requests ("supportId",reason) VALUES ($1,'Ready') RETURNING id`, [member.id]);
      const [title] = await db.query(`SELECT id FROM job_titles LIMIT 1`);
      await agents.manager.post(`/api/dispatch/promotions/${requestId}/decide`).set(headers).send({ version: 1, decision: 'APPROVE', mcId: null, teamId: null, jobTitleId: title.id }).expect(201);
      expect((await page(member.id as string))).toMatchObject({ position: 'DISPATCHER', supportType: 'SUPPORT' });
      // A person promoted to dispatcher no longer reads as an updater on what they applied through.
      expect((await agents.manager.get(`/api/onboarding/applications/${applicationId}`).set(headers).expect(200)).body.member).toMatchObject({ position: 'DISPATCHER' });
    });
    it('refuses a rollback while there are updaters', async () => {
      await add([base(2, 'Lead'), helper(3, 'Ann', 'Updater')]);
      const runner = db.createQueryRunner();
      const { SupportTypes1793000000000: Migration } = await import('../src/database/migrations/1793000000000-SupportTypes');
      await expect(new Migration().down(runner)).rejects.toThrow('Cannot discard updaters');
      await runner.release();
    });
  });
  it('refuses a rollback while existing records are kept', async () => {
    await addOne('Riley');
    const runner = db.createQueryRunner();
    const { ExistingDispatchers1792960000000: Migration } = await import('../src/database/migrations/1792960000000-ExistingDispatchers');
    await expect(new Migration().down(runner)).rejects.toThrow('Cannot discard existing dispatcher records');
    await runner.release();
  });
});
