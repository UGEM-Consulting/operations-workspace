import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { validateEnvironment } from '../src/config/environment';
import { databaseOptions } from '../src/database/options';
import { configureApp } from '../src/common/configure-app';
import { AuthModule } from '../src/modules/auth/auth.module';
import { installSessions } from '../src/modules/auth/session';
import { hashPassword } from '../src/modules/auth/password';
import { User, Role, UserStatus } from '../src/modules/users/user.entity';
import { OnboardingModule } from '../src/modules/onboarding/onboarding.module';
import { DemoEmailService } from '../src/modules/demo-email/demo-email.service';
import { assertDemoIdentity, convertStarterIdentity, initializeDemoIdentity } from '../src/modules/demo-email/isolation';
import { deploymentMigrationLogger } from '../src/database/deploy-migrations';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Explicit starter conversion (local disposable database)', () => {
  let db: DataSource, app: INestApplication | undefined, closeSessions: (() => Promise<void>) | undefined;
  const password = randomBytes(24).toString('base64url');
  const env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test',
    WEB_ORIGIN: 'https://workspace.example.test', CORS_ORIGINS: 'https://workspace.example.test',
    SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'),
    DEPLOYMENT_PURPOSE: 'demo', DEMO_EMAIL_MODE: true, DEMO_STARTER_MODE: true, DEMO_FICTIONAL_DATA_ONLY: true,
    DEMO_DEPLOYMENT_ID: randomUUID(), DEMO_MAILBOX_KEY: randomBytes(32).toString('base64') });
  const headers = { origin: env.WEB_ORIGIN, 'x-workspace-key': env.BFF_SHARED_SECRET, 'x-csrf-protection': '1' };
  let operator: User;
  const convert = () => db.transaction(em => convertStarterIdentity(em, env));
  beforeAll(async () => {
    const url = new URL(env.DATABASE_URL);
    if (!url.pathname.endsWith('_test') || !['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('Local disposable *_test database required');
    db = await new DataSource({ ...databaseOptions(env), logger: deploymentMigrationLogger }).initialize(); await db.runMigrations();
  });
  async function reset() {
    await db.query(`UPDATE deployment_identity SET purpose='production', mode='isolated', "operatorAdminId"=NULL, "deploymentId"=NULL, "webOrigin"=NULL, "initializedAt"=NULL`);
    await db.query('TRUNCATE users, staff_sessions, applicant_sessions, login_attempts, deployment_activity CASCADE');
  }
  beforeEach(async () => {
    await reset();
    operator = await db.getRepository(User).save({ email: 'operator@company.example', firstName: 'Fictional', lastName: 'Operator', role: Role.SYSTEM_ADMIN, status: UserStatus.ACTIVE, passwordHash: await hashPassword(password) });
  });
  afterEach(async () => {
    if (closeSessions) { await closeSessions(); closeSessions = undefined; }
    if (app) { await app.close(); app = undefined; }
    await reset();
  });
  afterAll(async () => { if (db?.isInitialized) await db.destroy(); });
  async function start() {
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, OnboardingModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init(); await app.listen(0,'127.0.0.1');
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').set(headers).send({ email: operator.email, password }).expect(200);
    return agent;
  }
  it('preserves the administrator and password, revokes prior sessions and audits conversion once', async () => {
    const [before] = await db.query('SELECT * FROM users WHERE id=$1', [operator.id]);
    await db.query('INSERT INTO staff_sessions(sid,sess,expire) VALUES ($1,$2,now()+interval \'1 hour\')', ['old-fictional-session',JSON.stringify({userId:operator.id,authVersion:before.authVersion})]);
    await convert();
    const [after] = await db.query('SELECT * FROM users WHERE id=$1',[operator.id]);
    const version=after.authVersion; delete after.authVersion; const originalVersion=before.authVersion; delete before.authVersion;
    expect(JSON.stringify(after)===JSON.stringify(before)).toBe(true); expect(version).toBe(originalVersion+1);
    expect((await db.query('SELECT count(*)::int AS count FROM staff_sessions'))[0].count).toBe(0);
    await convert();
    expect((await db.query('SELECT count(*)::int AS count FROM deployment_activity'))[0].count).toBe(1);
    await assertDemoIdentity(db.manager,env);
    const admin=await start(); await admin.get('/api/demo-mailbox').set(headers).expect(200);
  });
  it('refuses non-starter databases with another user without changing any accounts', async () => {
    await db.getRepository(User).save({ firstName:'Fictional',lastName:'Staff',email:'manager@example.test',role:Role.DISPATCHER_MANAGER,status:UserStatus.ACTIVE });
    await expect(convert()).rejects.toThrow('exactly one');
    expect((await db.query('SELECT purpose FROM deployment_identity WHERE id=true'))[0].purpose).toBe('production');
    expect(await db.getRepository(User).count()).toBe(2);
  });
  it('refuses existing onboarding data without deleting invitations or changing the administrator', async () => {
    await db.query(`INSERT INTO invitations("managerId","tokenHash","expiresAt") VALUES($1,repeat('a',64),now()+interval '1 day')`,[operator.id]);
    await expect(convert()).rejects.toThrow('onboarding');
    expect((await db.query('SELECT count(*)::int AS count FROM invitations'))[0].count).toBe(1);
    expect((await db.query('SELECT "authVersion" FROM users WHERE id=$1',[operator.id]))[0].authVersion).toBe(1);
  });
  it('preserves only empty unclaimed invitation placeholders and their creation audit', async () => {
    const [inv]=await db.query(`INSERT INTO invitations("managerId","tokenHash","expiresAt") VALUES($1,repeat('b',64),now()+interval '1 day') RETURNING id`,[operator.id]);
    await db.query(`INSERT INTO dispatcher_applications("invitationId","assignedManagerId",status,fields,"applicantAccessUntil") VALUES($1,$2,'INVITED',$3,now()+interval '1 day')`,[inv.id,operator.id,JSON.stringify({jobTitle:'Dispatcher'})]);
    await db.query(`INSERT INTO application_activity("invitationId","actorId",event) VALUES($1,$2,'INVITATION_CREATED')`,[inv.id,operator.id]);
    await convert();
    expect((await db.query('SELECT count(*)::int AS count FROM invitations'))[0].count).toBe(1);
    expect((await db.query('SELECT status FROM dispatcher_applications'))[0].status).toBe('INVITED');
    expect((await db.query('SELECT count(*)::int AS count FROM application_activity'))[0].count).toBe(1);
  });
  it('refuses any applicant draft answers even on an unclaimed invitation', async () => {
    const [inv]=await db.query(`INSERT INTO invitations("managerId","tokenHash","expiresAt") VALUES($1,repeat('c',64),now()+interval '1 day') RETURNING id`,[operator.id]);
    await db.query(`INSERT INTO dispatcher_applications("invitationId","assignedManagerId",status,fields,"applicantAccessUntil") VALUES($1,$2,'INVITED',$3,now()+interval '1 day')`,[inv.id,operator.id,JSON.stringify({firstName:'Fictional'})]);
    await expect(convert()).rejects.toThrow('onboarding');
    expect((await db.query('SELECT count(*)::int AS count FROM dispatcher_applications'))[0].count).toBe(1);
  });
  it('requires explicit starter mode and refuses bypass through the isolated initializer', async () => {
    await expect(db.transaction(em=>convertStarterIdentity(em,{...env,DEMO_STARTER_MODE:false}))).rejects.toThrow('starter demo configuration');
    await expect(db.transaction(em=>initializeDemoIdentity(em,env))).rejects.toThrow('convert-starter');
    const service=new DemoEmailService(db,new ConfigService(env));
    await expect(service.onModuleInit()).rejects.toThrow('startup refused');
  });
  it('serializes conflicting conversions and records only the winning deployment', async () => {
    const results=await Promise.allSettled([convert(),db.transaction(em=>convertStarterIdentity(em,{...env,DEMO_DEPLOYMENT_ID:randomUUID()}))]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect((await db.query('SELECT count(*)::int AS count FROM deployment_activity'))[0].count).toBe(1);
  });
  it('retains only the bound operator email exception and rejects new real staff identities', async () => {
    await convert(); const admin=await start();
    await admin.patch(`/api/users/${operator.id}`).set(headers).send({email:operator.email,firstName:'Updated Fictional'}).expect(200);
    // Updates revoke sessions; login again with the preserved password.
    await admin.post('/api/auth/login').set(headers).send({email:operator.email,password}).expect(200);
    await admin.post('/api/users').set(headers).send({email:'another@company.example',firstName:'Fictional',lastName:'Staff',password,role:Role.IT_SPECIALIST}).expect(400);
    await admin.patch(`/api/users/${operator.id}`).set(headers).send({email:'changed@company.example'}).expect(400);
    await expect(db.getRepository(User).save({email:'another@company.example',firstName:'Fictional',lastName:'Staff',role:Role.SYSTEM_ADMIN,status:UserStatus.ACTIVE})).rejects.toThrow();
    await expect(db.getRepository(User).update(operator.id,{email:'changed@company.example'})).rejects.toThrow();
  });
  it('supports fictional claiming and admin-only mailbox with the preserved operator account', async () => {
    await convert();const admin=await start();
    const invitation=await admin.post('/api/onboarding/invitations').set(headers).send({}).expect(201);
    const applicant=request.agent(app!.getHttpServer());
    const challenge=await applicant.post('/api/applicant/begin').set(headers).send({email:'applicant@example.test',token:invitation.body.url.split('/').pop()}).expect(201);
    const messages=await admin.get('/api/demo-mailbox').set(headers).expect(200);
    const delivered=await admin.post(`/api/demo-mailbox/${messages.body[0].id}/reveal`).set(headers).send({}).expect(201);
    await applicant.post('/api/applicant/verify').set(headers).send({challengeId:challenge.body.challengeId,code:delivered.body.code}).expect(201);
    await applicant.get('/api/demo-mailbox').set(headers).expect(401);
    await expect(db.undoLastMigration()).rejects.toThrow();
  });
});
