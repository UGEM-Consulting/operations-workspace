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
import { RetentionModule } from '../src/modules/retention/retention.module';
import { RetentionService } from '../src/modules/retention/retention.service';
import { addDays, usDay } from '../src/modules/safety/screening-rules';
import { completeMfa, enrolForTest } from './mfa-helpers';
type Agent = ReturnType<typeof request.agent>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Keeping records (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url');
  let admin: User, manager: User, agent: Agent, managerAgent: Agent;
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params))[0];
  const today = () => usDay('latest');
  /** A rejected application whose last change was some years ago, with a photo row, a submission and its activity. */
  async function oldApplication(years: number, name = 'Jamie') {
    const inv = await one(`INSERT INTO invitations ("managerId","tokenHash","expiresAt","telegramRequired",email,"consumedAt") VALUES ($1,$2,now() - interval '${years} years',false,$3,now() - interval '${years} years') RETURNING id`,
      [manager.id, randomBytes(32).toString('hex'), `${name.toLowerCase()}@example.test`]);
    const app = await one(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"applicantAccessUntil","updatedAt","submittedAt") VALUES ($1,$2,'REJECTED',$3,3,now() - interval '${years} years',now() - interval '${years} years',now() - interval '${years} years') RETURNING id`,
      [inv.id, manager.id, { preferredAmericanFirstName: name, preferredAmericanLastName: 'Ortiz' }]);
    await db.query(`INSERT INTO application_submissions ("applicationId",version,fields) VALUES ($1,1,$2)`, [app.id, { preferredAmericanFirstName: name }]);
    await db.query(`INSERT INTO applicant_photos ("applicationId",kind,sha256,"byteSize","storageLayout") VALUES ($1,'SELFIE',$2,10,2)`, [app.id, 'a'.repeat(64)]);
    await db.query(`INSERT INTO application_activity ("invitationId",event) VALUES ($1,'INVITATION_CREATED')`, [inv.id]);
    return { applicationId: app.id as string, invitationId: inv.id as string };
  }
  /** A driver Safety rejected some years ago, with a review (signed evidence) and an event. */
  async function oldDriver(years: number, status: 'REJECTED' | 'LEFT', phone: string, testYearsAgo: number | null = null) {
    const driver = await one(`INSERT INTO drivers ("firstName","lastName",phone,"phoneKey","driverType",status,"closedAt","clearedAt") VALUES ('Kai','Mendez',$1,$1,'COMPANY',$2,now() - interval '${years} years',$3) RETURNING id`,
      [phone, status, status === 'LEFT' ? new Date(Date.now() - (years + 1) * 365 * 86400000) : null]);
    await db.query(`INSERT INTO driver_reviews ("driverId",action,note,"noticeSentOn","previousStatus","newStatus") VALUES ($1,'REJECTED','Final notice sent.',(now() - interval '${years} years')::date,'PRE_ADVERSE','REJECTED')`, [driver.id]);
    await db.query(`INSERT INTO driver_events ("driverId",event,metadata) VALUES ($1,'CREATED','{}')`, [driver.id]);
    if (testYearsAgo !== null) await db.query(`INSERT INTO driver_tests ("driverId",kind,reason,"testedOn",result) VALUES ($1,'DRUG','RANDOM',(now() - interval '${testYearsAgo} years')::date,'NEGATIVE')`, [driver.id]);
    return driver.id as string;
  }
  /** A dispatcher who left some years ago, with a period, a leave and an event. */
  async function oldMember(years: number, name = 'Lee') {
    await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Northwind Freight','northwind freight') ON CONFLICT DO NOTHING`);
    const member = await one(`INSERT INTO dispatch_members ("firstName","lastName",status,"joinedAt","leftAt") VALUES ($1,'Varga','LEFT',now() - interval '${years + 2} years',now() - interval '${years} years') RETURNING id`, [name]);
    await db.query(`INSERT INTO member_assignments ("memberId","mcId","startedAt","endedAt") SELECT $1, id, now() - interval '${years + 2} years', now() - interval '${years} years' FROM mcs LIMIT 1`, [member.id]);
    await db.query(`INSERT INTO member_leaves ("memberId","firstDay","backOn",reason,"recordedBy","endedAt","endedHow") VALUES ($1,(now() - interval '${years + 1} years')::date,(now() - interval '${years + 1} years' + interval '7 days')::date,'Vacation.',$2,now(),'RETURNED')`, [member.id, manager.id]);
    await db.query(`INSERT INTO dispatch_events ("memberId",event,metadata) VALUES ($1,'MEMBER_LEFT','{}')`, [member.id]);
    return member.id as string;
  }
  /** Deleting on, as if turned on more than 14 days ago. */
  async function deletingOn() {
    await agent.post('/api/retention/settings').set(headers).send({ deleting: true }).expect(200);
    await db.query(`UPDATE retention_settings SET "updatedAt" = now() - interval '15 days'`);
  }

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, RetentionModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, drivers, dispatch_members, mcs, retention_runs, retention_holds, retention_setting_changes, dispatch_events, driver_events, application_activity CASCADE');
    await db.query(`UPDATE retention_settings SET deleting = false, "updatedBy" = NULL, "updatedAt" = NULL`);
    const passwordHash = await hashPassword(password);
    admin = await db.getRepository(User).save({ firstName: 'Fictional', lastName: 'Admin', email: 'retention.admin@example.test', role: Role.SYSTEM_ADMIN, status: UserStatus.ACTIVE, passwordHash });
    manager = await db.getRepository(User).save({ firstName: 'Fictional', lastName: 'Manager', email: 'retention.manager@example.test', role: Role.DISPATCHER_MANAGER, status: UserStatus.ACTIVE, passwordHash });
    agent = request.agent(app.getHttpServer()); managerAgent = request.agent(app.getHttpServer());
    const secret = await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, admin.id);
    await agent.post('/api/auth/login').set(headers).send({ email: admin.email, password }).expect(200);
    expect((await completeMfa(agent, headers, db, admin.id, secret)).status).toBe(200);
    await managerAgent.post('/api/auth/login').set(headers).send({ email: manager.email, password }).expect(200);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE users, invitations, drivers, dispatch_members, mcs CASCADE'); await db.destroy(); } });

  it('lists each kind with how many are past their period, and what is due within 14 days', async () => {
    await oldApplication(3); await oldApplication(1, 'Robin');
    await oldDriver(3, 'REJECTED', '5550101000'); await oldDriver(4, 'LEFT', '5550101001'); await oldMember(4);
    // A driver file whose last test is only 2 years old waits for the test's five years.
    await oldDriver(4, 'LEFT', '5550101002', 2);
    const overview = (await agent.get('/api/retention').set(headers).expect(200)).body;
    expect(overview).toMatchObject({ deleting: false, firstDeletion: null });
    expect(Object.fromEntries(overview.kinds.map((kind: { kind: string; pastIt: number }) => [kind.kind, kind.pastIt]))).toEqual({ APPLICATIONS: 1, DRIVER_APPLICATIONS: 1, DRIVER_FILES: 1, TESTS: 0, MEMBERS: 1, FILES: 0 });
    const due = (await agent.get('/api/retention/due').set(headers).expect(200)).body;
    expect(due.items.map((item: { name: string; what: string }) => item.name).sort()).toEqual(['Jamie Ortiz', 'Kai Mendez', 'Kai Mendez', 'Lee Varga']);
    expect(due).toMatchObject({ total: 4, deletesOn: null });
    // Only administrators.
    await managerAgent.get('/api/retention').set(headers).expect(403);
  });

  it('deletes nothing while off, nothing in the 14 days after it is turned on, and records each change', async () => {
    await oldApplication(3);
    expect(await app.get(RetentionService).run(today())).toBeNull();
    await agent.post('/api/retention/settings').set(headers).send({ deleting: true }).expect(200);
    await agent.post('/api/retention/settings').set(headers).send({ deleting: true }).expect(400);
    expect((await agent.get('/api/retention').set(headers).expect(200)).body).toMatchObject({ deleting: true, firstDeletion: addDays(today(), 14) });
    expect(await app.get(RetentionService).run(today())).toBeNull();
    expect((await one(`SELECT count(*)::integer AS n FROM dispatcher_applications`)).n).toBe(1);
    expect((await db.query(`SELECT deleting, "changedBy" FROM retention_setting_changes`))).toEqual([{ deleting: true, changedBy: admin.id }]);
  });

  it('deletes what is due for good, keeps audit history without the subject, and skips held records', async () => {
    const application = await oldApplication(3), recent = await oldApplication(1, 'Robin');
    const rejected = await oldDriver(3, 'REJECTED', '5550102000'), member = await oldMember(4), kept = await oldMember(4, 'Sam');
    const waiting = await oldDriver(4, 'LEFT', '5550102001', 2);
    await agent.post('/api/retention/holds').set(headers).send({ subjectKind: 'MEMBER', subjectId: kept, until: addDays(today(), 60), reason: 'Unemployment claim in progress.' }).expect(201);
    await agent.post('/api/retention/holds').set(headers).send({ subjectKind: 'MEMBER', subjectId: kept, until: addDays(today(), 60), reason: 'Again.' }).expect(409);
    await agent.post('/api/retention/holds').set(headers).send({ subjectKind: 'MEMBER', subjectId: kept, until: addDays(today(), 800), reason: 'Too long.' }).expect(400);
    await deletingOn();
    const result = await app.get(RetentionService).run(today());
    expect(result).toEqual({ deleted: { APPLICATIONS: { records: 1, files: 1 }, DRIVER_APPLICATIONS: { records: 1, files: 0 }, MEMBERS: { records: 1, files: 0 } }, held: 1, failed: 0 });
    expect(await db.query(`SELECT id FROM dispatcher_applications`)).toEqual([{ id: recent.applicationId }]);
    expect(await db.query(`SELECT id FROM invitations WHERE id = $1`, [application.invitationId])).toEqual([]);
    expect((await db.query(`SELECT id FROM drivers ORDER BY id`)).map((row: { id: string }) => row.id)).toEqual([waiting]);
    expect((await db.query(`SELECT id FROM dispatch_members`)).map((row: { id: string }) => row.id)).toEqual([kept]);
    expect(rejected && member).toBeTruthy();
    // What happened stays, naming nobody.
    expect((await one(`SELECT count(*)::integer AS n FROM application_activity WHERE "invitationId" IS NULL`)).n).toBe(1);
    expect((await one(`SELECT count(*)::integer AS n FROM driver_events WHERE "driverId" IS NULL`)).n).toBe(1);
    expect((await one(`SELECT count(*)::integer AS n FROM dispatch_events WHERE "memberId" IS NULL`)).n).toBe(1);
    // Once a day; the log keeps counts only.
    expect(await app.get(RetentionService).run(today())).toBeNull();
    const runs = (await agent.get('/api/retention/runs').set(headers).expect(200)).body.items;
    expect(runs).toEqual([expect.objectContaining({ day: today(), held: 1, failed: 0 })]);
    expect(JSON.stringify(runs)).not.toMatch(/Jamie|Kai|Lee|Varga/);
  });

  it('extends and ends holds, finds people to hold by name, and keeps someone whose later record came back', async () => {
    const lee = await oldMember(4);
    await db.query(`INSERT INTO dispatch_members ("firstName","lastName",status,"joinedAt","previousMemberId") VALUES ('Lee','Varga','ACTIVE',now(),$1)`, [lee]);
    expect((await agent.get('/api/retention/due').set(headers).expect(200)).body.total).toBe(0);
    const sam = await oldMember(4, 'Sam');
    expect((await agent.get('/api/retention/people?q=sam').set(headers).expect(200)).body.items).toEqual([expect.objectContaining({ id: sam, subject: 'MEMBER', name: 'Sam Varga' })]);
    const hold = (await agent.post('/api/retention/holds').set(headers).send({ subjectKind: 'MEMBER', subjectId: sam, until: addDays(today(), 30), reason: 'Audit.' }).expect(201)).body;
    await agent.post(`/api/retention/holds/${hold.id}/extend`).set(headers).send({ until: addDays(today(), 10), reason: 'Shorter.' }).expect(400);
    await agent.post(`/api/retention/holds/${hold.id}/extend`).set(headers).send({ until: addDays(today(), 90), reason: 'Audit runs longer.' }).expect(200);
    expect((await agent.get('/api/retention/due').set(headers).expect(200)).body.items[0]).toMatchObject({ id: sam, heldUntil: addDays(today(), 90) });
    await agent.post(`/api/retention/holds/${hold.id}/end`).set(headers).send({}).expect(200);
    await agent.post(`/api/retention/holds/${hold.id}/end`).set(headers).send({}).expect(404);
    // Someone working here now isn't due under any rule, so there's nothing to hold.
    const [here] = await db.query(`SELECT id FROM dispatch_members WHERE status = 'ACTIVE'`);
    await agent.post('/api/retention/holds').set(headers).send({ subjectKind: 'MEMBER', subjectId: here.id, until: addDays(today(), 30), reason: 'No.' }).expect(404);
  });

  it('knows every reference to the records it deletes, and refuses a rollback once it has run', async () => {
    expect(await app.get(RetentionService).unknownReferences()).toEqual([]);
    await agent.post('/api/retention/settings').set(headers).send({ deleting: true }).expect(200);
    const runner = db.createQueryRunner();
    const { RetentionJob1793300000000: Migration } = await import('../src/database/migrations/1793300000000-RetentionJob');
    await expect(new Migration().down(runner)).rejects.toThrow('Refusing to roll back while retention');
    await runner.release();
  });
});
