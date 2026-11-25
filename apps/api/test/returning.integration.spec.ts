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
import { completeMfa, enrolForTest } from './mfa-helpers';
import { countAttempt, sendsKey } from '../src/modules/onboarding/rate-limit';
import { EmailService } from '../src/modules/email/email.service';
type Agent = ReturnType<typeof request.agent>;
type Key = 'admin' | 'manager' | 'other' | 'it';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Returning applicants: more time and the code limit (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  // Codes are emailed here (a stand-in mailbox), so the outcomes recorded for staff are the ones production records; background work is awaited by settle().
  const sent: string[] = [], tasks: Promise<void>[] = [];
  const email = { enabled: true, staffCodesEnabled: false, onModuleInit: () => undefined, onApplicationShutdown: async () => undefined,
    sendVerificationCode: async (to: string) => { sent.push(to); return true; }, runInBackground: (task: () => Promise<void>) => { tasks.push(task()); } };
  const settle = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url');
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, OnboardingModule, ItModule, DispatchModule] }).overrideProvider(EmailService).useValue(email).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, notification_deliveries, it_removal_requests CASCADE');
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['admin', Role.SYSTEM_ADMIN], ['manager', Role.DISPATCHER_MANAGER], ['other', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `returning.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      // Administrators always use two-step verification: enrolled first, then the code after the password.
      const secret = key === 'admin' ? await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users[key].id) : null;
      const signedIn = await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password });
      expect([key, signedIn.status, signedIn.body.message ?? null]).toEqual([key, 200, null]);
      if (secret) expect((await completeMfa(agents[key], headers, db, users[key].id, secret)).status).toBe(200);
    }
  });
  // Background work from one test never runs into the next one’s setup.
  afterEach(settle);
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, it_removal_requests, users CASCADE'); await db.destroy(); } });

  /** An applicant who verified their email and saved a draft (or sent it), their time to return ending in `days` (negative: ended). */
  async function returning(name: string, options: { status?: string; days?: number; manager?: string } = {}) {
    const manager = options.manager ?? users.manager.id, email = `${name.toLowerCase()}@example.test`;
    const [inv] = await db.query(`INSERT INTO invitations ("managerId","tokenHash","expiresAt","telegramRequired",email,"consumedAt") VALUES ($1,$2,now()+interval '7 days',false,$3,now() - interval '2 days') RETURNING id`,
      [manager, randomBytes(32).toString('hex'), email]);
    const [application] = await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"applicantAccessUntil","submittedAt") VALUES ($1,$2,$3,'{}',2,now() + make_interval(days => $4),$5) RETURNING id`,
      [inv.id, manager, options.status ?? 'DRAFT', options.days ?? 5, options.status && options.status !== 'DRAFT' ? new Date() : null]);
    return { id: application.id as string, invitationId: inv.id as string, email };
  }
  const status = (agent: Agent, id: string, code = 200) => agent.get(`/api/onboarding/applications/${id}/returning`).set(headers).expect(code);
  const events = async (invitationId: string) => (await db.query(`SELECT event FROM application_activity WHERE "invitationId" = $1 ORDER BY "createdAt"`, [invitationId])).map((row: { event: string }) => row.event);
  /** The daily count of codes to an email, as sendRefusal keeps it. */
  const codesSent = async (email: string, count: number) => { for (let sent = 0; sent < count; sent++) await countAttempt(db, sendsKey(email), 86400); };

  it('shows the responsible manager until when they can return and today’s codes, and nobody else', async () => {
    const sam = await returning('Sam');
    await codesSent(sam.email, 10);
    expect((await status(agents.manager, sam.id)).body).toMatchObject({ status: 'DRAFT', email: sam.email, ended: false, codes: 10, limit: 10, limited: true, nextCodeAt: expect.any(String),
      canGiveTime: true, canReset: false, activity: [] });
    expect((await status(agents.admin, sam.id)).body).toMatchObject({ canReset: true });
    await status(agents.other, sam.id, 404);
    await status(agents.it, sam.id, 403);
    // Before they verify their email there is nobody to return.
    const [fresh] = await db.query(`INSERT INTO invitations ("managerId","tokenHash","expiresAt","telegramRequired") VALUES ($1,$2,now()+interval '7 days',false) RETURNING id`, [users.manager.id, randomBytes(32).toString('hex')]);
    const [unclaimed] = await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"applicantAccessUntil") VALUES ($1,$2,'INVITED','{}',1,now()+interval '7 days') RETURNING id`, [fresh.id, users.manager.id]);
    await status(agents.manager, unclaimed.id, 409);
  });

  it('gives more time from today, never shortening it, only while they can still change something', async () => {
    const sam = await returning('Sam', { days: -2 });
    expect((await status(agents.manager, sam.id)).body).toMatchObject({ ended: true, canGiveTime: true, canReset: false });
    const give = (id: string, days: number, code = 201, agent = agents.manager) => agent.post(`/api/onboarding/applications/${id}/more-time`).set(headers).send({ days }).expect(code);
    await give(sam.id, 10, 400);
    await give(sam.id, 7, 404, agents.other);
    const until = new Date((await give(sam.id, 14)).body.accessUntil).getTime();
    expect((await db.query(`SELECT version FROM dispatcher_applications WHERE id = $1`, [sam.id]))[0].version).toBe(2);
    expect(until).toBeGreaterThan(Date.now() + 13 * 86400000);
    // A shorter extension later keeps the longer time.
    expect(new Date((await give(sam.id, 7)).body.accessUntil).getTime()).toBe(until);
    expect(await events(sam.invitationId)).toEqual(['ACCESS_EXTENDED']);
    // A revoked invitation offers neither, and refuses both.
    await db.query(`UPDATE invitations SET "revokedAt" = now() WHERE id = $1`, [sam.invitationId]);
    expect((await status(agents.admin, sam.id)).body).toMatchObject({ revoked: true, canGiveTime: false, canReset: false });
    await give(sam.id, 30, 409);
    const sent = await returning('Riley', { status: 'SUBMITTED' });
    await give(sent.id, 7, 409);
  });

  it('lets only an administrator reset the code limit, once the applicant asked and while they can return', async () => {
    const sam = await returning('Sam');
    await codesSent(sam.email, 11);
    expect((await status(agents.admin, sam.id)).body).toMatchObject({ codes: 10, limited: true });
    const reset = (id: string, body: Record<string, unknown>, code: number, agent = agents.admin) => agent.post(`/api/onboarding/applications/${id}/reset-code-limit`).set(headers).send(body).expect(code);
    await reset(sam.id, { confirmed: true }, 404, agents.manager);
    await reset(sam.id, {}, 400);
    await reset(sam.id, { confirmed: true }, 201);

    expect(await events(sam.invitationId)).toEqual(['CODE_LIMIT_RESET']);
    expect((await status(agents.admin, sam.id)).body).toMatchObject({ codes: 0, limited: false, nextCodeAt: null });
    // Their time ended: more time comes first.
    const ended = await returning('Riley', { days: -1 });
    await reset(ended.id, { confirmed: true }, 409);
  });

  it('records why a returning applicant’s code wasn’t sent, answering them the same as anyone', async () => {
    const sam = await returning('Sam', { days: -1 });
    const applicant = request.agent(app.getHttpServer());
    const begin = (to: string, applicationId: string) => applicant.post('/api/applicant/begin').set(headers).send({ email: to, applicationId }).expect(201);
    const ended = await begin(sam.email, sam.id), unknown = await begin('nobody@example.test', sam.id);
    expect(ended.body.message).toBe(unknown.body.message);
    // Recorded after the response, at most once a day per application however often they ask.
    await begin(sam.email, sam.id); await settle();
    expect(await events(sam.invitationId)).toEqual(['CODE_NOT_SENT_ACCESS_ENDED']);
    expect(sent).toEqual([]);
    expect((await status(agents.manager, sam.id)).body.activity.map((row: { event: string }) => row.event)).toEqual(['CODE_NOT_SENT_ACCESS_ENDED']);
    // More time starts that record again: if their time ends again the same day, the next attempt is recorded too.
    expect((await agents.manager.post(`/api/onboarding/applications/${sam.id}/more-time`).set(headers).send({ days: 7 }).expect(201)).body).toMatchObject({ changed: true });
    await db.query(`UPDATE dispatcher_applications SET "applicantAccessUntil" = now() - interval '1 minute' WHERE id = $1`, [sam.id]);
    await begin(sam.email, sam.id); await settle();
    expect(await events(sam.invitationId)).toEqual(['CODE_NOT_SENT_ACCESS_ENDED', 'ACCESS_EXTENDED', 'CODE_NOT_SENT_ACCESS_ENDED']);
    // A decided application isn't one they come back to: nothing is recorded.
    const decided = await returning('Riley', { status: 'APPROVED', days: -1 });
    await begin(decided.email, decided.id); await settle();
    expect(await events(decided.invitationId)).toEqual([]);
    // Within their time, the daily limit for their email is recorded as such, not as a failed email.
    const morgan = await returning('Morgan');
    await codesSent(morgan.email, 10);
    await begin(morgan.email, morgan.id); await settle();
    expect(await events(morgan.invitationId)).toEqual(['CODE_NOT_SENT_DAILY_LIMIT']);
    // The page counts codes, never more than went out, though every request was counted.
    expect((await status(agents.manager, morgan.id)).body).toMatchObject({ codes: 10, limited: true });
  });

  it('never gives more time while another application with their email is in progress, and leaves catch-up paperwork to its page', async () => {
    const sam = await returning('Sam', { days: -1 });
    const [second] = await db.query(`INSERT INTO invitations ("managerId","tokenHash","expiresAt","telegramRequired",email,"consumedAt") VALUES ($1,$2,now()+interval '7 days',false,$3,now()) RETURNING id`,
      [users.other.id, randomBytes(32).toString('hex'), sam.email]);
    await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"applicantAccessUntil") VALUES ($1,$2,'DRAFT','{}',1,now()+interval '7 days')`, [second.id, users.other.id]);
    expect((await agents.manager.post(`/api/onboarding/applications/${sam.id}/more-time`).set(headers).send({ days: 7 }).expect(409)).body.message).toMatch(/Another application with sam@example.test is in progress/);
    const [member] = await db.query(`INSERT INTO dispatch_members ("firstName","lastName","joinedAt") VALUES ('Casey','Fictional',now()) RETURNING id`);
    const casey = await returning('Casey');
    await db.query(`UPDATE invitations SET "catchUpMemberId" = $2 WHERE id = $1`, [casey.invitationId, member.id]);
    await codesSent(casey.email, 10);
    expect((await status(agents.admin, casey.id)).body).toMatchObject({ catchUp: true, canGiveTime: false, canReset: false, resetWhy: 'Catch-up paperwork is handled from their dispatcher page.' });
    await agents.admin.post(`/api/onboarding/applications/${casey.id}/reset-code-limit`).set(headers).send({ confirmed: true }).expect(400);
  });
});
