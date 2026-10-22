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
import { Role, User, UserStatus } from '../src/modules/users/user.entity';
import { OnboardingModule } from '../src/modules/onboarding/onboarding.module';
import { DemoEmailService } from '../src/modules/demo-email/demo-email.service';
import { initializeDemoIdentity } from '../src/modules/demo-email/isolation';
import { ApplicantChallenge, ApplicationActivity, Invitation } from '../src/modules/onboarding/entities';
import { issueDemoCode } from '../src/database/demo-verification';

const integration = process.env.DEMO_TEST_DATABASE_URL ? describe : describe.skip;
integration('Isolated demo mailbox and applicant workflow (dedicated demo test DB)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  const env = validateEnvironment({ NODE_ENV: 'test', DEPLOYMENT_PURPOSE: 'demo', DEMO_EMAIL_MODE: true,
    DEMO_FICTIONAL_DATA_ONLY: true, DEMO_DEPLOYMENT_ID: randomUUID(), DEMO_MAILBOX_KEY: randomBytes(32).toString('base64'),
    DATABASE_URL: process.env.DEMO_TEST_DATABASE_URL ?? 'postgresql://localhost/operations_email_demo_test', WEB_ORIGIN: 'https://workspace-demo.example.test',
    CORS_ORIGINS: 'https://workspace-demo.example.test', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex') });
  const headers = { origin: env.WEB_ORIGIN, 'x-workspace-key': env.BFF_SHARED_SECRET, 'x-csrf-protection': '1' };
  const password = randomBytes(24).toString('base64url');
  type Agent = ReturnType<typeof request.agent>;
  let admin: Agent, manager: Agent, itAgent: Agent, otherManager: Agent;
  let managerId: string, otherManagerId: string;
  const create = async () => {
    const response = await manager.post('/api/onboarding/invitations').set(headers).send({}).expect(201);
    return { token: response.body.url.split('/').pop() as string, id: response.body.id as string };
  };
  const begin = async (token: string, email = 'applicant@example.test') => (await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({ token, email }).expect(201)).body;
  async function message(challengeId: string) {
    const list = await admin.get('/api/demo-mailbox').set(headers).expect(200);
    return list.body.find((row: { challengeId: string }) => row.challengeId === challengeId) as { id: string };
  }
  async function reveal(id: string) { return (await admin.post(`/api/demo-mailbox/${id}/reveal`).set(headers).send({}).expect(201)).body.code as string; }
  beforeAll(async () => {
    const url = new URL(env.DATABASE_URL);
    if (!url.pathname.endsWith('_demo_test') || !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Dedicated local *_demo_test DB required');
    db = await new DataSource(databaseOptions(env)).initialize();
    await db.runMigrations();
    // Explicitly disposable DB only: reset previous demo identity before preparing fictional fixtures.
    await db.query("UPDATE deployment_identity SET purpose='unassigned', mode='isolated', \"operatorAdminId\"=NULL, \"deploymentId\"=NULL, \"webOrigin\"=NULL");
    await db.query('TRUNCATE users, staff_sessions, applicant_sessions, login_attempts, deployment_activity CASCADE');
    const hash = await hashPassword(password);
    for (const role of Object.values(Role)) await db.getRepository(User).save({ firstName: 'Fictional', lastName: 'Demo', email: `${role.toLowerCase()}@example.test`, role, status: UserStatus.ACTIVE, passwordHash: hash });
    await db.transaction(em => initializeDemoIdentity(em, env));
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, OnboardingModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init(); await app.listen(0, '127.0.0.1');
    const agents: Agent[] = [];
    for (const role of Object.values(Role)) {
      const agent = request.agent(app.getHttpServer());
      await agent.post('/api/auth/login').set(headers).send({ email: `${role.toLowerCase()}@example.test`, password }).expect(200); agents.push(agent);
    }
    [admin, manager, itAgent] = agents;
    managerId = (await db.getRepository(User).findOneByOrFail({ email: 'dispatcher_manager@example.test' })).id;
    otherManagerId = (await db.getRepository(User).save({ firstName: 'Fictional', lastName: 'Other Manager', email: 'other.manager@example.test', role: Role.DISPATCHER_MANAGER, status: UserStatus.ACTIVE, passwordHash: hash })).id;
    otherManager = request.agent(app.getHttpServer());
    await otherManager.post('/api/auth/login').set(headers).send({ email: 'other.manager@example.test', password }).expect(200);
  }, 30000);
  beforeEach(async () => { await db.query('TRUNCATE invitations, applicant_sessions, login_attempts CASCADE'); });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) await db.destroy(); });

  it('simulates delivery, stores encrypted codes and reveals only through the audited admin action', async () => {
    const inv = await create(), challenge = await begin(inv.token);
    expect(Object.keys(challenge).sort()).toEqual(['challengeId', 'message']);
    const list = await admin.get('/api/demo-mailbox').set(headers).expect(200);
    expect(list.body).toHaveLength(1); expect(list.body[0].code).toBeUndefined(); expect(list.body[0].ciphertext).toBeUndefined();
    const code = await reveal(list.body[0].id);
    expect(/^\d{8}$/.test(code)).toBe(true);
    const [stored] = await db.query('SELECT ciphertext FROM demo_mailbox');
    expect(stored.ciphertext.includes(code)).toBe(false);
    const storedChallenge = await db.getRepository(ApplicantChallenge).createQueryBuilder('c').addSelect('c.codeHash').getOneOrFail();
    expect(storedChallenge.codeHash === code).toBe(false);
    expect((await db.getRepository(ApplicationActivity).findBy({ invitationId: inv.id })).map(row => row.event)).toEqual(expect.arrayContaining(['DEMO_VERIFICATION_DELIVERED', 'DEMO_VERIFICATION_VIEWED']));
  });
  it('denies unauthenticated, IT and applicant mailbox access and enforces reveal CSRF', async () => {
    const inv = await create(), challenge = await begin(inv.token), item = await message(challenge.challengeId);
    for (const agent of [itAgent]) {
      await agent.get('/api/demo-mailbox').set(headers).expect(403);
      await agent.post(`/api/demo-mailbox/${item.id}/reveal`).set(headers).send({}).expect(403);
    }
    await request(app.getHttpServer()).get('/api/demo-mailbox').set(headers).expect(401);
    for (const agent of [admin, manager]) {
      await agent.post(`/api/demo-mailbox/${item.id}/reveal`).set({ ...headers, 'x-csrf-protection': '' }).send({}).expect(403);
      await agent.post(`/api/demo-mailbox/${item.id}/reveal`).set({ ...headers, origin: 'https://foreign.example.test' }).send({}).expect(403);
    }
    const applicant = request.agent(app.getHttpServer());
    await applicant.post('/api/applicant/verify').set(headers).send({ challengeId: challenge.challengeId, code: await reveal(item.id) }).expect(201);
    await applicant.get('/api/demo-mailbox').set(headers).expect(401);
    await applicant.post(`/api/demo-mailbox/${item.id}/reveal`).set(headers).send({}).expect(401);
  });
  it('lists and reveals only the manager-owned invitations while administrators retain all access', async () => {
    const own = await create(), challenge = await begin(own.token), ownMessage = await message(challenge.challengeId);
    const other = await otherManager.post('/api/onboarding/invitations').set(headers).send({}).expect(201);
    const otherChallenge = await begin(other.body.url.split('/').pop()), otherMessage = await message(otherChallenge.challengeId);
    const list = await manager.get('/api/demo-mailbox').set(headers).expect(200);
    expect(list.body.map((row: { id: string }) => row.id)).toEqual([ownMessage.id]);
    expect(list.body[0].code).toBeUndefined(); expect(list.body[0].ciphertext).toBeUndefined();
    expect((await admin.get('/api/demo-mailbox').set(headers)).body).toHaveLength(2);
    const revealed = await manager.post(`/api/demo-mailbox/${ownMessage.id}/reveal`).set(headers).send({}).expect(201);
    expect(revealed.body.code).toMatch(/^\d{8}$/);
    expect(await db.getRepository(ApplicationActivity).findOneBy({ invitationId: own.id, event: 'DEMO_VERIFICATION_VIEWED', actorId: managerId })).not.toBeNull();
    await manager.post(`/api/demo-mailbox/${otherMessage.id}/reveal`).set(headers).send({ managerId }).expect(404);
    await otherManager.post(`/api/demo-mailbox/${ownMessage.id}/reveal`).set(headers).send({}).expect(404);
    expect((await otherManager.get('/api/demo-mailbox').set(headers)).body.map((row: { id: string }) => row.id)).toEqual([otherMessage.id]);
    expect(await db.getRepository(ApplicationActivity).countBy({ invitationId: other.body.id, event: 'DEMO_VERIFICATION_VIEWED' })).toBe(0);
  });
  it('rechecks persisted invitation ownership after listing a message', async () => {
    const inv = await create(), challenge = await begin(inv.token), item = await message(challenge.challengeId);
    await manager.get('/api/demo-mailbox').set(headers).expect(200);
    await db.getRepository(Invitation).update(inv.id, { managerId: otherManagerId });
    expect((await manager.get('/api/demo-mailbox').set(headers)).body).toEqual([]);
    await manager.post(`/api/demo-mailbox/${item.id}/reveal`).set(headers).send({}).expect(404);
    await otherManager.post(`/api/demo-mailbox/${item.id}/reveal`).set(headers).send({}).expect(201);
  });
  it('never reveals revoked or expired invitation codes to their manager', async () => {
    const inv = await create(), challenge = await begin(inv.token), item = await message(challenge.challengeId);
    await db.getRepository(Invitation).update(inv.id, { expiresAt: new Date(Date.now() - 1000) });
    await manager.post(`/api/demo-mailbox/${item.id}/reveal`).set(headers).send({}).expect(404);
    await db.getRepository(Invitation).update(inv.id, { expiresAt: new Date(Date.now() + 60000), revokedAt: new Date() });
    await manager.post(`/api/demo-mailbox/${item.id}/reveal`).set(headers).send({}).expect(404);
  });
  it('rejects real applicant/staff emails and the database also enforces fictional identities', async () => {
    const inv = await create();
    await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({ token: inv.token, email: 'person@company.example' }).expect(400);
    await admin.post('/api/users').set(headers).send({ firstName: 'Fictional', lastName: 'Demo', email: 'person@company.example', password, role: Role.IT_SPECIALIST }).expect(400);
    await expect(db.getRepository(User).update({ role: Role.IT_SPECIALIST }, { email: 'person@company.example' })).rejects.toThrow();
    expect(await db.getRepository(User).countBy({ email: 'person@company.example' })).toBe(0);
  });
  it('expires codes, consumes them once and removes consumed mailbox messages', async () => {
    const inv = await create(), challenge = await begin(inv.token), item = await message(challenge.challengeId), code = await reveal(item.id);
    const applicant = request.agent(app.getHttpServer());
    await applicant.post('/api/applicant/verify').set(headers).send({ challengeId: challenge.challengeId, code }).expect(201);
    await applicant.post('/api/applicant/verify').set(headers).send({ challengeId: challenge.challengeId, code }).expect(401);
    await admin.post(`/api/demo-mailbox/${item.id}/reveal`).set(headers).send({}).expect(404);
    const second = await create(), expired = await begin(second.token), expiredItem = await message(expired.challengeId), expiredCode = await reveal(expiredItem.id);
    await db.getRepository(ApplicantChallenge).update(expired.challengeId, { expiresAt: new Date(Date.now() - 1000) });
    await applicant.post('/api/applicant/verify').set(headers).send({ challengeId: expired.challengeId, code: expiredCode }).expect(401);
    await admin.post(`/api/demo-mailbox/${expiredItem.id}/reveal`).set(headers).send({}).expect(404);
    expect((await admin.get('/api/demo-mailbox').set(headers)).body).toHaveLength(0);
  });
  it('retains verification attempt limits and never delivers for unavailable invitation details', async () => {
    const inv = await create(), challenge = await begin(inv.token), item = await message(challenge.challengeId), code = await reveal(item.id);
    const wrong = code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 5; i++) await request(app.getHttpServer()).post('/api/applicant/verify').set(headers).send({ challengeId: challenge.challengeId, code: wrong }).expect(401);
    await request(app.getHttpServer()).post('/api/applicant/verify').set(headers).send({ challengeId: challenge.challengeId, code }).expect(429);
    const unknown = await begin('f'.repeat(64));
    expect(await message(unknown.challengeId)).toBeUndefined();
  });
  it('fails isolation changes closed and refuses local CLI delivery on a designated demo', async () => {
    const inv = await create(), challenge = await begin(inv.token);
    await expect(issueDemoCode(db, challenge.challengeId, 'test')).rejects.toThrow('mailbox');
    await db.query('UPDATE deployment_identity SET "deploymentId"=$1', [randomUUID()]);
    try {
      await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({ token: inv.token, email: 'applicant@example.test' }).expect(503);
      await admin.get('/api/demo-mailbox').set(headers).expect(503);
      await expect(app.get(DemoEmailService).onModuleInit()).rejects.toThrow('startup refused');
    } finally { await db.query('UPDATE deployment_identity SET "deploymentId"=$1', [env.DEMO_DEPLOYMENT_ID]); }
  });
  it('never initializes a production identity or a populated unassigned database', async () => {
    const inv = await create();
    await db.transaction(async em => {
      await em.query("UPDATE deployment_identity SET purpose='production'");
      await expect(initializeDemoIdentity(em, env)).rejects.toThrow('production database');
      await em.query("UPDATE deployment_identity SET purpose='unassigned'");
      await expect(initializeDemoIdentity(em, env)).rejects.toThrow('unused database');
      await em.query("UPDATE deployment_identity SET purpose='demo'");
    });
    expect(inv.id).toBeTruthy();
  });
  it('refuses rollback that would remove an active demo identity', async () => {
    await expect(db.undoLastMigration()).rejects.toThrow();
    expect((await db.query("SELECT purpose FROM deployment_identity WHERE id=true"))[0].purpose).toBe('demo');
  });
  it('keeps the production provider disabled independently of runtime development mode', async () => {
    const service = new DemoEmailService(db, new ConfigService({ NODE_ENV: 'development', DEPLOYMENT_PURPOSE: 'production', DEMO_EMAIL_MODE: false }));
    await expect(service.assertAvailable()).rejects.toThrow('not configured');
    const user = await db.getRepository(User).findOneByOrFail({ id: managerId });
    await expect(service.mailbox(user)).rejects.toThrow('Not Found');
  });
  it('demonstrates invitation, verification, submission, corrections, independent return verification and approval', async () => {
    const inv = await create(), challenge = await begin(inv.token), applicant = request.agent(app.getHttpServer());
    const verified = await applicant.post('/api/applicant/verify').set(headers).send({ challengeId: challenge.challengeId, code: (await manager.post(`/api/demo-mailbox/${(await message(challenge.challengeId)).id}/reveal`).set(headers).send({}).expect(201)).body.code }).expect(201);
    const id = verified.body.applicationId;
    const fields = { firstName: 'Fictional', lastName: 'Applicant', preferredAmericanFirstName: 'Alex', preferredAmericanLastName: 'Demo', personalPhoneNumber: '+1 202 555 0123', workPhoneNumber: '+44 20 7946 0958', mcName: 'Independent', teamLead: 'Independent', jobTitle: 'Dispatcher' };
    await applicant.patch('/api/applicant/draft').set(headers).send({ version: 0, ...fields }).expect(200);
    await applicant.post('/api/applicant/submit').set(headers).send({ version: 1, ...fields, accurate: true }).expect(201);
    await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({ version: 2, decisionType: 'REQUEST_CHANGES', requestedFields: ['firstName'], reason: 'Please correct the fictional name.' }).expect(201);
    await applicant.post('/api/applicant/logout').set(headers).send({}).expect(201);
    const resumed = await applicant.post('/api/applicant/begin').set(headers).send({ applicationId: id, email: 'applicant@example.test' }).expect(201);
    await applicant.post('/api/applicant/verify').set(headers).send({ challengeId: resumed.body.challengeId, code: (await manager.post(`/api/demo-mailbox/${(await message(resumed.body.challengeId)).id}/reveal`).set(headers).send({}).expect(201)).body.code }).expect(201);
    await applicant.patch('/api/applicant/draft').set(headers).send({ version: 3, firstName: 'Corrected Fictional' }).expect(200);
    await applicant.post('/api/applicant/submit').set(headers).send({ version: 4, accurate: true }).expect(201);
    const result = await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({ version: 5, decisionType: 'APPROVE', confirmed: true, employmentConfirmed: true, employment: { mcName: 'Independent', teamLead: 'Independent', jobTitle: 'Dispatcher' } }).expect(201);
    expect(result.status).toBe(201);
    expect((await applicant.get('/api/applicant/application').set(headers)).body.application.status).toBe('APPROVED');
    expect((await admin.get('/api/auth/me').set(headers)).body.demoEmailEnabled).toBe(true);
  });
});
