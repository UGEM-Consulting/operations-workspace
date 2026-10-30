import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jpeg, pdfText } from './documents.fixtures';
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
import { SafetyModule } from '../src/modules/safety/safety.module';
import { EmailService } from '../src/modules/email/email.service';
import { normalSsn, PiiService } from '../src/modules/safety/pii';
import { LEFTOVER_SCAN_AGE_MS, ScanSweeper } from '../src/modules/safety/scan-sweeper';
import { completeMfa, enrolForTest } from './mfa-helpers';
type Agent = ReturnType<typeof request.agent>;
type Key = 'admin' | 'manager' | 'lead' | 'staff' | 'staff2' | 'dispatch';
const ROLES: Record<Key, Role> = { admin: Role.SYSTEM_ADMIN, manager: Role.SAFETY_MANAGER, lead: Role.SAFETY_LEAD, staff: Role.SAFETY_STAFF, staff2: Role.SAFETY_STAFF, dispatch: Role.DISPATCHER_MANAGER };
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Safety drivers (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url');
  const users = {} as Record<Key, User>, agents = {} as Record<Key, Agent>;
  const lead = { firstName: ' Jordan ', lastName: 'Wheeler', phone: '+1 (555) 010-2000', email: 'Jordan.Wheeler@Example.test', driverType: 'OWNER_OPERATOR', licenseType: 'CDL_A', licenseState: 'tx', experienceYears: 6, source: 'Referral' };
  const add = (agent: Agent, body: Record<string, unknown> = lead) => agent.post('/api/safety/drivers').set(headers).send(body);
  const driver = async (id: string, agent = agents.lead) => (await agent.get(`/api/safety/drivers/${id}`).set(headers).expect(200)).body;
  // Captures code emails instead of opening an SMTP connection; background work is awaited by settle().
  const sent: { to: string; code: string }[] = [], tasks: Promise<void>[] = [];
  const email = { enabled: true, onModuleInit: () => undefined, onApplicationShutdown: async () => undefined,
    sendVerificationCode: async (to: string, code: string) => { sent.push({ to, code }); return true; }, runInBackground: (task: () => Promise<void>) => { tasks.push(task()); } };
  const settle = async () => { await Promise.all(tasks.splice(0)); };
  // Fictional scans: structurally valid JPEG pages carrying fictional camera metadata the API must strip.
  const storage = mkdtempSync(join(tmpdir(), 'driver-documents-'));
  const page = () => jpeg().toString('base64');
  const scan = (agent: Agent, segment: string, body: Record<string, unknown> = { pages: [page()] }) => agent.post(`/api/driver/documents/${segment}`).set(headers).send(body);
  async function scanAll(agent: Agent) {
    await scan(agent, 'license', { pages: [page(), page()] }).expect(201);
    await scan(agent, 'medical-card').expect(201);
    return (await scan(agent, 'work-authorization', { pages: [page()], subtype: 'GREEN_CARD' }).expect(201)).body;
  }
  const complete = { legalFirstName: 'Jordan', legalLastName: 'Wheeler', dateOfBirth: '1988-04-12', phone: '555 010 2000', addressLine1: '100 Fictional Way', city: 'Austin', state: 'tx',
    zip: '73301', emergencyName: 'Casey Wheeler', emergencyRelationship: 'Sibling', emergencyPhone: '555 010 3000', licenseNumber: 'd1234567', licenseState: 'TX', licenseClass: 'CDL_A', licenseExpiresOn: '2030-01-31' };
  /** A lead with a sent link, and a driver agent signed in through the emailed code. */
  async function applying() {
    const { id } = (await add(agents.lead).expect(201)).body;
    const link = (await agents.lead.post(`/api/safety/drivers/${id}/link`).set(headers).send({ version: 1 }).expect(201)).body;
    const token = link.url.split('#').pop() as string, agent = request.agent(app.getHttpServer());
    const { challengeId } = (await agent.post('/api/driver/begin').set(headers).send({ token, email: 'jordan.wheeler@example.test' }).expect(201)).body;
    await settle();
    await agent.post('/api/driver/verify').set(headers).send({ challengeId, code: sent.at(-1)!.code }).expect(201);
    return { id, token, agent, version: link.version as number };
  }
  const events = async (id: string) => (await db.query(`SELECT event, metadata FROM driver_events WHERE "driverId" = $1 ORDER BY "createdAt"`, [id])) as { event: string; metadata: Record<string, unknown> }[];

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), PII_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: storage });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, SafetyModule] })
      .overrideProvider(EmailService).useValue(email).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await settle(); sent.length = 0;
    await db.query('TRUNCATE users, staff_sessions, driver_sessions, driver_challenges, login_attempts, staff_mfa, drivers CASCADE');
    const passwordHash = await hashPassword(password);
    for (const key of Object.keys(ROLES) as Key[]) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `safety.${key}@example.test`, role: ROLES[key], status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      // Administrators always use two-step verification.
      const secret = key === 'admin' ? await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users[key].id) : null;
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
      if (secret) expect((await completeMfa(agents[key], headers, db, users[key].id, secret)).status).toBe(200);
    }
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE drivers CASCADE'); await db.query(`DELETE FROM users WHERE role::text LIKE 'SAFETY_%'`); await db.destroy(); } rmSync(storage, { recursive: true, force: true }); });

  it('shows Drivers to Safety roles and administrators only, landing Safety roles on it', async () => {
    for (const key of ['manager', 'lead', 'staff'] as const) {
      const me = (await agents[key].get('/api/auth/me').set(headers).expect(200)).body;
      expect(me.landingPage).toBe('/safety/drivers');
      expect(me.navigation.map((item: { key: string }) => item.key)).toEqual(['drivers', 'security']);
    }
    expect((await agents.admin.get('/api/auth/me').set(headers).expect(200)).body.navigation.map((item: { key: string }) => item.key)).toContain('drivers');
    await agents.dispatch.get('/api/safety/drivers').set(headers).expect(403);
    await add(agents.dispatch).expect(403);
    await agents.admin.get('/api/safety/drivers').set(headers).expect(200);
  });

  it('adds a lead with normalised details, refuses a second open record for the same phone or email, and records field names only', async () => {
    const created = (await add(agents.lead).expect(201)).body;
    const record = await driver(created.id);
    expect(record).toMatchObject({ firstName: 'Jordan', email: 'jordan.wheeler@example.test', licenseState: 'TX', status: 'LEAD', version: 1, owner: null,
      safetyLead: { id: users.lead.id, name: 'Fictional lead', active: true }, addedBy: { id: users.lead.id } });
    expect(record).not.toHaveProperty('phoneKey');
    expect((await add(agents.manager, { ...lead, email: null, phone: '555.010.2000' }).expect(409)).body.message).toBe('Another open driver record already has this phone number.');
    expect((await add(agents.manager, { ...lead, phone: '555 010 9999', email: 'JORDAN.wheeler@example.test' }).expect(409)).body.message).toBe('Another open driver record already has this email.');
    await add(agents.lead, { ...lead, phone: '12' }).expect(400);
    await add(agents.lead, { ...lead, phone: '555 010 3000', email: null, licenseState: 'ZZ' }).expect(400);
    await add(agents.lead, { ...lead, phone: '555 010 3000', email: null, driverType: 'TEAM' }).expect(400);
    // An administrator adding a lead names no Safety lead unless one is chosen.
    const byAdmin = (await add(agents.admin, { firstName: 'Riley', lastName: 'Fictional', phone: '555 010 4000', driverType: 'COMPANY' }).expect(201)).body;
    expect((await driver(byAdmin.id)).safetyLead).toBeNull();
    const [row] = await events(created.id);
    expect(row).toEqual({ event: 'CREATED', metadata: { fields: ['firstName', 'lastName', 'phone', 'email', 'driverType', 'licenseType', 'licenseState', 'experienceYears', 'source'] } });
    expect(JSON.stringify(await events(created.id))).not.toContain('Wheeler');
    expect((await agents.staff.get('/api/safety/drivers').set(headers).expect(200)).body.items).toHaveLength(2);
  });

  it('edits with version checks; Safety staff read every driver but change only the ones they own', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    await agents.lead.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 2, notes: 'x' }).expect(409);
    expect((await agents.lead.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 1, notes: 'Prefers the Midwest', source: null, experienceYears: 7 }).expect(200)).body.version).toBe(2);
    // Nothing changed: no new version, no event.
    expect((await agents.lead.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 2, notes: 'Prefers the Midwest' }).expect(200)).body.version).toBe(2);
    expect((await driver(id))).toMatchObject({ notes: 'Prefers the Midwest', source: null, experienceYears: 7 });
    expect((await events(id)).at(-1)).toEqual({ event: 'UPDATED', metadata: { fields: ['experienceYears', 'source', 'notes'] } });
    await agents.staff.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 2, notes: 'Mine now' }).expect(403);
    // Changing the Safety lead: only an active Safety lead or manager, and not by safety staff.
    await agents.lead.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 2, safetyLeadId: users.staff.id }).expect(400);
    expect((await agents.lead.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 2, safetyLeadId: users.manager.id }).expect(200)).body.version).toBe(3);
    expect((await events(id)).at(-1)?.event).toBe('SAFETY_LEAD_CHANGED');

    await db.query(`UPDATE drivers SET status = 'APPROVED' WHERE id = $1`, [id]);
    await agents.lead.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 3, ownerId: users.staff.id }).expect(201);
    expect((await agents.staff.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 4, notes: 'Mine now' }).expect(200)).body.version).toBe(5);
    await agents.staff.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 5, safetyLeadId: users.lead.id }).expect(403);
    await agents.staff2.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 5, notes: 'Not mine' }).expect(403);
  });

  it('assigns a safety staff owner only after approval, keeping each owner as history and requiring a reason to change', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    expect((await agents.lead.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 1, ownerId: users.staff.id }).expect(409)).body.message).toMatch(/once the Safety manager approves/);
    await db.query(`UPDATE drivers SET status = 'APPROVED' WHERE id = $1`, [id]);
    await agents.staff.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 1, ownerId: users.staff.id }).expect(403);
    await agents.lead.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 1, ownerId: users.lead.id }).expect(400);
    await agents.lead.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 1, ownerId: users.staff.id }).expect(201);
    await agents.lead.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 2, ownerId: users.staff.id, reason: 'Again' }).expect(400);
    expect((await agents.manager.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 2, ownerId: users.staff2.id }).expect(400)).body.message).toBe('Say why the driver is changing owner.');
    await agents.manager.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 2, ownerId: users.staff2.id, reason: 'Balancing workloads' }).expect(201);
    const record = await driver(id);
    expect(record.owner).toMatchObject({ id: users.staff2.id });
    expect(record.owners.map((row: { owner: { id: string }; endedAt: string | null; reason: string | null }) => [row.owner.id, row.endedAt === null, row.reason]))
      .toEqual([[users.staff2.id, true, 'Balancing workloads'], [users.staff.id, false, null]]);
    expect((await agents.lead.get('/api/safety/drivers').set(headers).expect(200)).body.items[0].owner).toMatchObject({ id: users.staff2.id });
    expect((await events(id)).filter(row => row.event === 'OWNER_ASSIGNED').map(row => row.metadata)).toEqual([{ first: true }, { first: false }]);
    // An inactive staff member can't be chosen.
    await db.query(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [users.staff.id]);
    await agents.manager.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 3, ownerId: users.staff.id, reason: 'Back' }).expect(400);
    expect((await agents.lead.get('/api/safety/people').set(headers).expect(200)).body).toEqual({
      leads: expect.arrayContaining([{ id: users.lead.id, name: 'Fictional lead', role: 'SAFETY_LEAD' }, { id: users.manager.id, name: 'Fictional manager', role: 'SAFETY_MANAGER' }]),
      staff: [{ id: users.staff2.id, name: 'Fictional staff2', role: 'SAFETY_STAFF' }] });
  });

  it('withdraws an unapproved driver with a reason, closes the record, frees the phone and reopens it as a lead', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    await agents.staff.post(`/api/safety/drivers/${id}/withdraw`).set(headers).send({ version: 1, reason: 'No reply' }).expect(403);
    await agents.lead.post(`/api/safety/drivers/${id}/withdraw`).set(headers).send({ version: 1, reason: ' ' }).expect(400);
    expect((await agents.lead.post(`/api/safety/drivers/${id}/withdraw`).set(headers).send({ version: 1, reason: 'No reply after three calls' }).expect(201)).body.version).toBe(2);
    expect(await driver(id)).toMatchObject({ status: 'WITHDRAWN', statusReason: 'No reply after three calls' });
    expect((await agents.lead.get('/api/safety/drivers?status=CLOSED').set(headers).expect(200)).body.items).toHaveLength(1);
    expect((await agents.lead.get('/api/safety/drivers?status=OPEN').set(headers).expect(200)).body.items).toHaveLength(0);
    await agents.lead.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 2, notes: 'x' }).expect(409);
    // The same person can be entered again while the old record is closed; reopening then clashes with the new one.
    const again = (await add(agents.lead).expect(201)).body;
    expect((await agents.lead.post(`/api/safety/drivers/${id}/reopen`).set(headers).send({ version: 2 }).expect(409)).body.message).toBe('Another open driver record already has this phone number.');
    await agents.lead.post(`/api/safety/drivers/${again.id}/withdraw`).set(headers).send({ version: 1, reason: 'Duplicate' }).expect(201);
    expect((await agents.lead.post(`/api/safety/drivers/${id}/reopen`).set(headers).send({ version: 2 }).expect(201)).body.version).toBe(3);
    expect(await driver(id)).toMatchObject({ status: 'LEAD', statusReason: null, closedAt: null });
    await db.query(`UPDATE drivers SET status = 'APPROVED' WHERE id = $1`, [id]);
    expect((await agents.lead.post(`/api/safety/drivers/${id}/withdraw`).set(headers).send({ version: 3, reason: 'Late' }).expect(409)).body.message).toMatch(/isn’t approved yet/);
    expect((await events(id)).map(row => row.event)).toEqual(['CREATED', 'WITHDRAWN', 'REOPENED']);
  });

  it('sends a link bound to the driver’s email, replaces it on resend and keeps the token out of every response but the first', async () => {
    const { id } = (await add(agents.lead, { ...lead, email: null }).expect(201)).body;
    expect((await agents.lead.post(`/api/safety/drivers/${id}/link`).set(headers).send({ version: 1 }).expect(400)).body.message).toMatch(/Add the driver’s email first/);
    await agents.lead.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 1, email: 'jordan.wheeler@example.test' }).expect(200);
    await agents.staff.post(`/api/safety/drivers/${id}/link`).set(headers).send({ version: 2 }).expect(403);
    const first = (await agents.lead.post(`/api/safety/drivers/${id}/link`).set(headers).send({ version: 2 }).expect(201)).body;
    expect(first.url).toMatch(/^http:\/\/localhost:3000\/driver#[a-f0-9]{64}$/);
    const record = await driver(id);
    expect(record).toMatchObject({ status: 'APPLYING', link: { email: 'jordan.wheeler@example.test', expired: false, openedAt: null }, application: null });
    expect(JSON.stringify(record)).not.toContain(first.url.split('#').pop());
    const second = (await agents.lead.post(`/api/safety/drivers/${id}/link`).set(headers).send({ version: 3 }).expect(201)).body;
    // The first link is dead: same response, no email.
    const begin = (token: string, address = 'jordan.wheeler@example.test') => request(app.getHttpServer()).post('/api/driver/begin').set(headers).send({ token, email: address });
    const dead = (await begin(first.url.split('#').pop()).expect(201)).body, wrong = (await begin(second.url.split('#').pop(), 'someone.else@example.test').expect(201)).body;
    const live = (await begin(second.url.split('#').pop()).expect(201)).body;
    await settle();
    expect([dead.message, wrong.message]).toEqual([live.message, live.message]);
    expect(sent).toEqual([{ to: 'jordan.wheeler@example.test', code: expect.stringMatching(/^\d{8}$/) }]);
    expect((await events(id)).filter(row => row.event === 'LINK_SENT').map(row => row.metadata)).toEqual([{ resent: false }, { resent: true }]);
    await begin(second.url.split('#').pop(), 'real.person@gmail.com').expect(400);
  });

  it('lets only a verified driver read and save their application, with drafts version-checked and the SSN encrypted', async () => {
    const { id, agent } = await applying();
    await request(app.getHttpServer()).get('/api/driver/application').set(headers).expect(401);
    // A driver session is not a staff session, and a staff session is not a driver session.
    await agent.get('/api/safety/drivers').set(headers).expect(401);
    await agents.lead.get('/api/driver/application').set(headers).expect(401);
    const start = (await agent.get('/api/driver/application').set(headers).expect(200)).body;
    expect(start).toMatchObject({ email: 'jordan.wheeler@example.test', status: 'DRAFT', version: 1, ssnLast4: null, ssnAvailable: true,
      fields: { legalFirstName: 'Jordan', legalLastName: 'Wheeler', phone: '+1 (555) 010-2000', licenseState: 'TX', licenseClass: 'CDL_A' } });
    await agent.patch('/api/driver/application').set(headers).send({ version: 1, fields: { zip: '123' } }).expect(400);
    await agent.patch('/api/driver/application').set(headers).send({ version: 1, fields: { unknown: 'x' } }).expect(400);
    await agent.patch('/api/driver/application').set(headers).send({ version: 1, fields: {}, ssn: '666-12-3456' }).expect(400);
    const saved = (await agent.patch('/api/driver/application').set(headers).send({ version: 1, fields: { city: ' Austin ', zip: '' }, ssn: '123-45-6789' }).expect(200)).body;
    expect(saved).toMatchObject({ version: 2, ssnLast4: '6789', fields: { city: 'Austin' } });
    expect(saved.fields).not.toHaveProperty('zip');
    await agent.patch('/api/driver/application').set(headers).send({ version: 1, fields: { city: 'Dallas' } }).expect(409);
    const [row] = await db.query(`SELECT "ssnCiphertext" FROM driver_applications WHERE "driverId" = $1`, [id]);
    expect(row.ssnCiphertext).toMatch(/^v1:/);
    expect(row.ssnCiphertext).not.toContain('6789');
    // Staff see the last four digits only, until someone allowed asks for the number; every view is recorded.
    const record = await driver(id, agents.staff);
    expect(record.application).toMatchObject({ status: 'DRAFT', ssnLast4: '6789', fields: { city: 'Austin' } });
    expect(JSON.stringify(record)).not.toContain('123-45');
    await agents.staff.post(`/api/safety/drivers/${id}/ssn`).set(headers).send({}).expect(403);
    expect((await agents.lead.post(`/api/safety/drivers/${id}/ssn`).set(headers).send({}).expect(201)).body).toEqual({ ssn: '123-45-6789' });
    expect((await events(id)).map(row => row.event)).toEqual(['CREATED', 'LINK_SENT', 'APPLICATION_VERIFIED', 'SSN_REVEALED']);
    expect(JSON.stringify(await events(id))).not.toContain('6789');
  });

  it('submits a complete application once: the link closes and the driver moves to Screening', async () => {
    const { id, token, agent } = await applying();
    const missing = (await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: {} }).expect(400)).body;
    expect(missing.missing).toEqual(['dateOfBirth', 'addressLine1', 'city', 'state', 'zip', 'emergencyName', 'emergencyRelationship', 'emergencyPhone', 'licenseNumber', 'licenseExpiresOn', 'ssn',
      'LICENSE', 'MEDICAL_CARD', 'WORK_AUTHORIZATION']);
    await scanAll(agent);
    expect((await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: { ...complete, dateOfBirth: '2015-01-01' }, ssn: '123456789' }).expect(400)).body.missing).toEqual(['dateOfBirth']);
    expect((await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: { ...complete, licenseExpiresOn: '2020-01-01' }, ssn: '123456789' }).expect(400)).body.message).toMatch(/expired/);
    const done = (await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: complete, ssn: '123456789' }).expect(201)).body;
    expect(done).toMatchObject({ status: 'SUBMITTED', ssnLast4: '6789', fields: { state: 'TX', licenseNumber: 'D1234567' }, submittedAt: expect.any(String) });
    expect(await driver(id)).toMatchObject({ status: 'SCREENING', link: null, application: { status: 'SUBMITTED' } });
    // Still readable in this session; no further changes; the link can't start a new session.
    await agent.get('/api/driver/application').set(headers).expect(200);
    await agent.patch('/api/driver/application').set(headers).send({ version: 2, fields: { city: 'Dallas' } }).expect(409);
    await request(app.getHttpServer()).post('/api/driver/begin').set(headers).send({ token, email: 'jordan.wheeler@example.test' }).expect(201);
    await settle();
    expect(sent).toHaveLength(1);
    expect((await events(id)).at(-1)?.event).toBe('APPLICATION_SUBMITTED');
    await agents.lead.post(`/api/safety/drivers/${id}/link`).set(headers).send({ version: 3 }).expect(409);
  });

  it('ends the driver’s access when Safety cancels the link, changes the email or withdraws them, keeping saved answers', async () => {
    const one = await applying();
    await one.agent.patch('/api/driver/application').set(headers).send({ version: 1, fields: { city: 'Austin' } }).expect(200);
    expect((await agents.lead.post(`/api/safety/drivers/${one.id}/link/cancel`).set(headers).send({ version: one.version }).expect(201)).body.version).toBe(one.version + 1);
    await one.agent.get('/api/driver/application').set(headers).expect(401);
    expect(await driver(one.id)).toMatchObject({ status: 'LEAD', link: null, application: { fields: { city: 'Austin' } } });
    await agents.lead.post(`/api/safety/drivers/${one.id}/link/cancel`).set(headers).send({ version: one.version + 1 }).expect(409);
    // A new link opens the same saved answers.
    const again = (await agents.lead.post(`/api/safety/drivers/${one.id}/link`).set(headers).send({ version: one.version + 1 }).expect(201)).body;
    const agent = request.agent(app.getHttpServer());
    const { challengeId } = (await agent.post('/api/driver/begin').set(headers).send({ token: again.url.split('#').pop(), email: 'jordan.wheeler@example.test' }).expect(201)).body;
    await settle();
    await agent.post('/api/driver/verify').set(headers).send({ challengeId, code: sent.at(-1)!.code }).expect(201);
    expect((await agent.get('/api/driver/application').set(headers).expect(200)).body.fields.city).toBe('Austin');
    await agents.lead.patch(`/api/safety/drivers/${one.id}`).set(headers).send({ version: again.version, email: 'jordan.w@example.test' }).expect(200);
    await agent.get('/api/driver/application').set(headers).expect(401);
    expect((await driver(one.id))).toMatchObject({ status: 'LEAD', link: null });
    expect((await events(one.id)).filter(row => row.event === 'LINK_CANCELLED').map(row => row.metadata)).toEqual([{}, { emailChanged: true }]);
    await db.query('TRUNCATE drivers CASCADE');
    const two = await applying();
    await agents.lead.post(`/api/safety/drivers/${two.id}/withdraw`).set(headers).send({ version: two.version, reason: 'Took another job' }).expect(201);
    await two.agent.get('/api/driver/application').set(headers).expect(401);
  });

  it('refuses wrong, reused and expired codes', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    const token = (await agents.lead.post(`/api/safety/drivers/${id}/link`).set(headers).send({ version: 1 }).expect(201)).body.url.split('#').pop();
    const agent = request.agent(app.getHttpServer());
    const { challengeId } = (await agent.post('/api/driver/begin').set(headers).send({ token, email: 'jordan.wheeler@example.test' }).expect(201)).body;
    await settle();
    const code = sent.at(-1)!.code, other = code === '00000000' ? '11111111' : '00000000';
    await agent.post('/api/driver/verify').set(headers).send({ challengeId, code: other }).expect(401);
    await agent.post('/api/driver/verify').set(headers).send({ challengeId, code }).expect(201);
    await request(app.getHttpServer()).post('/api/driver/verify').set(headers).send({ challengeId, code }).expect(401);
    const next = (await agent.post('/api/driver/begin').set(headers).send({ token, email: 'jordan.wheeler@example.test' }).expect(201)).body.challengeId;
    await settle();
    await db.query(`UPDATE driver_challenges SET "expiresAt" = now() - interval '1 second' WHERE id = $1`, [next]);
    await agent.post('/api/driver/verify').set(headers).send({ challengeId: next, code: sent.at(-1)!.code }).expect(401);
  });

  it('accepts only structurally valid SSNs and fails closed without an encryption key', () => {
    expect(['123-45-6789', '123 45 6789', '123456789'].map(normalSsn)).toEqual(['123456789', '123456789', '123456789']);
    expect(['000-12-3456', '666-12-3456', '912-34-5678', '123-00-4567', '123-45-0000', '12345678', 'abc'].map(normalSsn)).toEqual(Array(7).fill(null));
    const off = new PiiService({ get: () => undefined } as never);
    expect(off.enabled).toBe(false);
    expect(() => off.sealSsn('123-45-6789', 'x')).toThrow(/encryption is configured/);
    const on = new PiiService({ get: () => env.PII_ENCRYPTION_KEY } as never), sealed = on.sealSsn('123-45-6789', 'driver-a');
    expect(on.openSsn(sealed.ciphertext, 'driver-a')).toBe('123-45-6789');
    // Bound to the driver: the same ciphertext can't be read as another driver's.
    expect(() => on.openSsn(sealed.ciphertext, 'driver-b')).toThrow();
  });

  it('scans documents into one metadata-free PDF per kind, replacing the earlier scan', async () => {
    const { id, agent } = await applying();
    await scan(agent, 'passport').expect(404);
    expect((await scan(agent, 'work-authorization').expect(400)).body.message).toMatch(/Choose which document/);
    await scan(agent, 'license', { pages: [page()], subtype: 'US_PASSPORT' }).expect(400);
    await scan(agent, 'license', { pages: [] }).expect(400);
    await scan(agent, 'license', { pages: Array(5).fill(page()) }).expect(400);
    await scan(agent, 'license', { pages: [Buffer.from('not a photo at all, fictional').toString('base64').padEnd(1400, 'A')] }).expect(400);
    expect((await scan(agent, 'license', { pages: [jpeg({ width: 2000, height: 100 }).toString('base64')] }).expect(400)).body.message).toMatch(/too narrow/);
    await request(app.getHttpServer()).post('/api/driver/documents/license').set(headers).send({ pages: [page()] }).expect(401);
    const first = (await scan(agent, 'license', { pages: [page(), page()] }).expect(201)).body;
    expect(first).toMatchObject({ documentsEnabled: true, requiredDocuments: ['LICENSE', 'MEDICAL_CARD', 'WORK_AUTHORIZATION'], documents: [{ kind: 'LICENSE', subtype: null, pageCount: 2 }] });
    const original = first.documents[0].id;
    const file = await agent.get(`/api/driver/documents/${original}/file`).set(headers).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['cache-control']).toBe('no-store, private');
    const pdf = file.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).not.toMatch(/FictionalCamera|GPS 41|fictional comment|TRAILING-FICTIONAL-DATA/);
    expect(pdfText(pdf)).toBe('');
    expect(existsSync(join(storage, 'drivers', id, `${original}.pdf`))).toBe(true);
    // A new scan replaces the old one, whose file is removed (nobody reviews a draft).
    const second = (await scan(agent, 'license').expect(201)).body.documents[0];
    expect(second).toMatchObject({ kind: 'LICENSE', pageCount: 1 });
    expect(existsSync(join(storage, 'drivers', id, `${original}.pdf`))).toBe(false);
    await agent.get(`/api/driver/documents/${original}/file`).set(headers).expect(404);
    expect((await db.query(`SELECT count(*)::integer AS n FROM driver_documents WHERE "driverId" = $1`, [id]))[0].n).toBe(2);
    expect((await events(id)).filter(row => row.event === 'DOCUMENT_UPLOADED').map(row => row.metadata)).toEqual([{ kind: 'LICENSE', pages: 2 }, { kind: 'LICENSE', pages: 1 }]);
    // A regular license needs no medical card.
    expect((await agent.patch('/api/driver/application').set(headers).send({ version: 1, fields: { licenseClass: 'DL' } }).expect(200)).body.requiredDocuments).toEqual(['LICENSE', 'WORK_AUTHORIZATION']);
  });

  it('shows scans to Safety and lets screeners or the owner record what a submitted document shows', async () => {
    const { id, agent } = await applying();
    const documents = (await scanAll(agent)).documents as { id: string; kind: string }[];
    const license = documents.find(row => row.kind === 'LICENSE')!.id;
    expect((await driver(id, agents.staff)).documents.map((row: { kind: string; subtype: string | null; verifiedAt: string | null }) => [row.kind, row.subtype, row.verifiedAt]))
      .toEqual([['LICENSE', null, null], ['MEDICAL_CARD', null, null], ['WORK_AUTHORIZATION', 'GREEN_CARD', null]]);
    const workAuthorization = documents.find(row => row.kind === 'WORK_AUTHORIZATION')!.id;
    const verify = (agent: Agent, documentId: string, body: Record<string, unknown>) => agent.post(`/api/safety/drivers/${id}/documents/${documentId}/verify`).set(headers).send(body);
    // Every staff view of an identity document is recorded, by kind only.
    await agents.staff.get(`/api/safety/drivers/${id}/documents/${license}/file`).set(headers).expect(200).expect('content-type', 'application/pdf');
    await agents.dispatch.get(`/api/safety/drivers/${id}/documents/${license}/file`).set(headers).expect(403);
    expect((await events(id)).filter(row => row.event === 'DOCUMENT_VIEWED').map(row => row.metadata)).toEqual([{ kind: 'LICENSE' }]);
    await verify(agents.lead, license, { version: 1, number: 'X1', expiresOn: '2030-01-31' }).expect(409);
    await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: complete, ssn: '123456789' }).expect(201);
    expect((await scan(agent, 'license').expect(409)).body.message).toMatch(/already sent/);
    await verify(agents.staff, license, { version: 1, expiresOn: '2030-01-31' }).expect(403);
    await verify(agents.lead, license, { expiresOn: '2030-01-31' }).expect(400);
    await verify(agents.lead, license, { version: 1, expiresOn: '2030-13-01' }).expect(400);
    // A license or medical card needs its expiry; work authorization takes no number (passport or A-numbers stay out).
    expect((await verify(agents.lead, license, { version: 1, number: 'D1234567' }).expect(400)).body.message).toMatch(/expiration date/);
    expect((await verify(agents.lead, workAuthorization, { version: 1, number: 'A123456789' }).expect(400)).body.message).toMatch(/number of a work authorization/);
    expect((await verify(agents.lead, workAuthorization, { version: 1 }).expect(201)).body.version).toBe(2);
    expect((await verify(agents.lead, license, { version: 1, number: ' D1234567 ', expiresOn: '2030-01-31' }).expect(201)).body.version).toBe(2);
    // A second person working from the same version can't overwrite the first silently.
    expect((await verify(agents.manager, license, { version: 1, number: 'D7654321', expiresOn: '2030-02-28' }).expect(409)).body.message).toMatch(/same time/);
    await verify(agents.manager, license, { version: 2, number: 'D1234567', expiresOn: '2030-02-28' }).expect(201);
    expect((await driver(id)).documents[0]).toMatchObject({ kind: 'LICENSE', number: 'D1234567', expiresOn: '2030-02-28', verifiedBy: 'Fictional manager', verifiedAt: expect.any(String), version: 3 });
    await expect(db.query(`UPDATE driver_documents SET number = 'A123456789' WHERE id = $1`, [workAuthorization])).rejects.toThrow();
    expect((await events(id)).filter(row => row.event === 'DOCUMENT_VERIFIED').map(row => row.metadata))
      .toEqual([{ kind: 'WORK_AUTHORIZATION', again: false }, { kind: 'LICENSE', again: false }, { kind: 'LICENSE', again: true }]);
    expect(JSON.stringify(await events(id))).not.toContain('D1234567');
  });

  it('reopens a submitted application when a withdrawn driver gets a new link, keeping verified scans', async () => {
    const { id, agent } = await applying();
    const license = ((await scanAll(agent)).documents as { id: string; kind: string }[]).find(row => row.kind === 'LICENSE')!.id;
    await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: complete, ssn: '123456789' }).expect(201);
    await agents.lead.post(`/api/safety/drivers/${id}/documents/${license}/verify`).set(headers).send({ version: 1, expiresOn: '2030-01-31' }).expect(201);
    const { version } = await driver(id);
    const withdrawn = (await agents.lead.post(`/api/safety/drivers/${id}/withdraw`).set(headers).send({ version, reason: 'Paused hiring' }).expect(201)).body;
    const reopened = (await agents.lead.post(`/api/safety/drivers/${id}/reopen`).set(headers).send({ version: withdrawn.version }).expect(201)).body;
    const link = (await agents.lead.post(`/api/safety/drivers/${id}/link`).set(headers).send({ version: reopened.version }).expect(201)).body;
    expect((await events(id)).filter(row => row.event === 'LINK_SENT').map(row => row.metadata)).toEqual([{ resent: false }, { resent: false, reopened: true }]);
    const again = request.agent(app.getHttpServer());
    const { challengeId } = (await again.post('/api/driver/begin').set(headers).send({ token: link.url.split('#').pop(), email: 'jordan.wheeler@example.test' }).expect(201)).body;
    await settle();
    await again.post('/api/driver/verify').set(headers).send({ challengeId, code: sent.at(-1)!.code }).expect(201);
    const view = (await again.get('/api/driver/application').set(headers).expect(200)).body;
    expect(view).toMatchObject({ status: 'DRAFT', version: 3, ssnLast4: '6789', fields: { licenseNumber: 'D1234567' } });
    // Replacing a scan Safety already verified keeps its file as the record of what was checked.
    await scan(again, 'license').expect(201);
    expect(existsSync(join(storage, 'drivers', id, `${license}.pdf`))).toBe(true);
    await again.post('/api/driver/application/submit').set(headers).send({ version: 3, fields: complete }).expect(201);
    expect(await driver(id)).toMatchObject({ status: 'SCREENING', application: { status: 'SUBMITTED' } });
  });

  it('ends a submitted session when Safety withdraws the driver, changes their email or reopens the application', async () => {
    async function submitted() {
      const one = await applying();
      const license = ((await scanAll(one.agent)).documents as { id: string; kind: string }[]).find(row => row.kind === 'LICENSE')!.id;
      await one.agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: complete, ssn: '123456789' }).expect(201);
      await one.agent.get('/api/driver/application').set(headers).expect(200);
      await one.agent.get(`/api/driver/documents/${license}/file`).set(headers).expect(200);
      return { ...one, license, version: (await driver(one.id)).version as number };
    }
    const withdrawn = await submitted();
    await agents.lead.post(`/api/safety/drivers/${withdrawn.id}/withdraw`).set(headers).send({ version: withdrawn.version, reason: 'Took another job' }).expect(201);
    await withdrawn.agent.get('/api/driver/application').set(headers).expect(401);
    await withdrawn.agent.get(`/api/driver/documents/${withdrawn.license}/file`).set(headers).expect(401);
    await db.query('TRUNCATE drivers CASCADE');
    const moved = await submitted();
    await agents.lead.patch(`/api/safety/drivers/${moved.id}`).set(headers).send({ version: moved.version, email: 'jordan.w@example.test' }).expect(200);
    await moved.agent.get('/api/driver/application').set(headers).expect(401);
    await db.query('TRUNCATE drivers CASCADE');
    // Even a completed link left unrevoked (an older API withdrew the driver) stops answering once the application is a draft again.
    const reopened = await submitted();
    const out = (await agents.lead.post(`/api/safety/drivers/${reopened.id}/withdraw`).set(headers).send({ version: reopened.version, reason: 'Paused hiring' }).expect(201)).body;
    await db.query(`UPDATE driver_links SET "revokedAt" = NULL WHERE "driverId" = $1 AND "completedAt" IS NOT NULL`, [reopened.id]);
    const lead = (await agents.lead.post(`/api/safety/drivers/${reopened.id}/reopen`).set(headers).send({ version: out.version }).expect(201)).body;
    await agents.lead.post(`/api/safety/drivers/${reopened.id}/link`).set(headers).send({ version: lead.version }).expect(201);
    await reopened.agent.get('/api/driver/application').set(headers).expect(401);
    expect(Number((await db.query(`SELECT count(*) FROM driver_links WHERE "driverId" = $1 AND "completedAt" IS NOT NULL AND "revokedAt" IS NULL`, [reopened.id]))[0].count)).toBe(0);
    await db.query(`UPDATE driver_links SET "revokedAt" = NULL WHERE "driverId" = $1 AND "completedAt" IS NOT NULL`, [reopened.id]);
    await reopened.agent.get('/api/driver/application').set(headers).expect(401);
  });

  it('sweeps leftover scan files after a day, never current, verified or unrecognised ones', async () => {
    // Earlier tests truncate drivers but leave their files; start from an empty folder so the counts are this test's.
    rmSync(join(storage, 'drivers'), { recursive: true, force: true });
    const { id, agent } = await applying();
    const sweeper = app.get(ScanSweeper), later = Date.now() + LEFTOVER_SCAN_AGE_MS + 60_000;
    const file = (documentId: string) => join(storage, 'drivers', id, `${documentId}.pdf`);
    const replaced = (await scan(agent, 'license').expect(201)).body.documents[0].id as string, pdf = readFileSync(file(replaced));
    const current = (await scan(agent, 'license').expect(201)).body.documents[0].id as string;
    // A replaced scan whose removal failed, a file whose row never committed, and a file the API never names.
    writeFileSync(file(replaced), pdf);
    const unreferenced = randomUUID(); writeFileSync(file(unreferenced), pdf);
    const foreign = join(storage, 'drivers', id, 'notes.txt'); writeFileSync(foreign, 'fictional');
    expect(await sweeper.sweep()).toBe(0);
    expect([file(replaced), file(unreferenced)].every(path => existsSync(path))).toBe(true);
    expect(await sweeper.sweep(later)).toBe(2);
    expect([existsSync(file(replaced)), existsSync(file(unreferenced)), existsSync(file(current)), existsSync(foreign)]).toEqual([false, false, true, true]);
    // A replaced scan Safety verified (a reopened application) is the record of what was checked.
    writeFileSync(file(replaced), pdf);
    await db.query(`UPDATE driver_documents SET "verifiedAt" = now() WHERE id = $1`, [replaced]);
    expect(await sweeper.sweep(later)).toBe(0);
    expect(existsSync(file(replaced))).toBe(true);
  });

  it('keeps the migrations from discarding driver documents, applications, driver records or Safety accounts', async () => {
    const { id, agent } = await applying();
    await scan(agent, 'license').expect(201);
    await db.undoLastMigration(); // ClearInactiveTeamLeads: a data fix with nothing to undo
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard driver documents or their history');
    await db.query('TRUNCATE driver_documents');
    await db.query(`DELETE FROM driver_events WHERE event = 'DOCUMENT_UPLOADED'`);
    await db.undoLastMigration();
    try {
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard driver application links, answers or their history');
    await db.query('TRUNCATE driver_sessions, driver_challenges, driver_links, driver_applications');
    await db.query(`DELETE FROM driver_events WHERE "driverId" = $1 AND event NOT IN ('CREATED')`, [id]);
    await db.undoLastMigration();
    try {
      await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard driver records or Safety accounts');
      await db.query('TRUNCATE drivers CASCADE');
      await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard driver records or Safety accounts');
      expect((await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name).toBe('SafetyDrivers1792860000000');
    } finally { await db.runMigrations(); }
    } finally { await db.runMigrations(); }
    expect((await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name).toBe('ClearInactiveTeamLeads1792890000000');
  });
});
