import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jpeg, pdfText, png } from './documents.fixtures';
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
import { DriverSignedCopies } from '../src/modules/safety/signed-copies';
import { RETRY_FIRST_MS } from '../src/modules/storage/signed-copies';
import { earliestFinalRejection } from '../src/modules/safety/safety.entity';
import { ScreeningService } from '../src/modules/safety/screening.service';
import { addDays, usDay } from '../src/modules/safety/screening-rules';
import { addMonths } from '../src/modules/safety/history-rules';
import { PDFDocument } from 'pdf-lib';
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
  // A complete address and work history, in months relative to now: addresses and jobs reach back far enough, no gaps.
  const now = () => usDay('latest').slice(0, 7);
  const history = () => ({ currentSince: addMonths(now(), -20), addresses: [{ id: randomUUID(), line1: '12 Example Rd', city: 'Tulsa', state: 'OK', zip: '74103', fromMonth: addMonths(now(), -60), toMonth: addMonths(now(), -21) }],
    jobs: [{ id: randomUUID(), company: 'Prairie Haulers', city: 'Tulsa', state: 'OK', phone: '555-010-9100', position: 'Company driver', fromMonth: addMonths(now(), -30), toMonth: null, drove: 'YES', fmcsr: 'YES', dotTesting: 'YES', reasonLeft: '' },
      { id: randomUUID(), company: 'Hill Country Grocers', city: 'Austin', state: 'TX', phone: '555-010-9300', position: 'Warehouse associate', fromMonth: addMonths(now(), -130), toMonth: addMonths(now(), -31), drove: 'NO', fmcsr: 'NO', dotTesting: 'NO', reasonLeft: 'Started driving' }],
    accidents: 'NO', tickets: 'NO', otherLicenses: 'NO', licenseTrouble: 'NO' });
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
    app.get(DriverSignedCopies).archive.stop(); // Tests run the signed-copy job themselves.
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
      // Every Safety role reads the consent forms; only the Safety manager publishes them.
      expect(me.navigation.map((item: { key: string }) => item.key)).toEqual(['drivers', 'trucks', 'expiring', 'consents', 'security']);
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
    expect((await agents.manager.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 2, ownerId: users.staff2.id }).expect(400)).body.message).toBe('Say why the driver’s Safety contact is changing.');
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
      'LICENSE', 'MEDICAL_CARD', 'WORK_AUTHORIZATION', 'history:currentSince', `history:gap:${addMonths(now(), -35)}_${now()}`, 'history:driving', 'history:accidents', 'history:tickets',
      'history:licenses', 'history:licenseTrouble']);
    await scanAll(agent);
    expect((await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: { ...complete, dateOfBirth: '2015-01-01' }, history: history(), ssn: '123456789' }).expect(400)).body.missing).toEqual(['dateOfBirth']);
    expect((await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: { ...complete, licenseExpiresOn: '2020-01-01' }, history: history(), ssn: '123456789' }).expect(400)).body.message).toMatch(/expired/);
    const done = (await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: complete, history: history(), ssn: '123456789' }).expect(201)).body;
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
    expect(existsSync(join(storage, 'drivers', id, 'documents', 'license', `${original}.pdf`))).toBe(true);
    // A new scan replaces the old one, whose file is removed (nobody reviews a draft).
    const second = (await scan(agent, 'license').expect(201)).body.documents[0];
    expect(second).toMatchObject({ kind: 'LICENSE', pageCount: 1 });
    expect(existsSync(join(storage, 'drivers', id, 'documents', 'license', `${original}.pdf`))).toBe(false);
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
    await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: complete, history: history(), ssn: '123456789' }).expect(201);
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

  it('lists verified scans that expired or expire within 60 days, soonest first, to Safety roles only, with dates and no numbers', async () => {
    const { id, agent } = await applying();
    const documents = (await scanAll(agent)).documents as { id: string; kind: string }[];
    await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: complete, history: history(), ssn: '123456789' }).expect(201);
    const expiring = async (agent = agents.staff) => (await agent.get('/api/safety/expiring').set(headers).expect(200)).body;
    const verify = (kind: string, body: Record<string, unknown>) => agents.lead.post(`/api/safety/drivers/${id}/documents/${documents.find(row => row.kind === kind)!.id}/verify`).set(headers).send(body);
    const today = usDay('latest');
    // An unverified scan, and one that expires far away, are not listed.
    expect((await expiring()).items).toEqual([]);
    await verify('LICENSE', { version: 1, number: 'D1234567', expiresOn: addDays(today, 400) }).expect(201);
    expect((await expiring()).items).toEqual([]);
    await verify('MEDICAL_CARD', { version: 1, expiresOn: addDays(today, 30) }).expect(201);
    await verify('WORK_AUTHORIZATION', { version: 1, subtype: 'WORK_PERMIT', expiresOn: addDays(today, -3) }).expect(201);
    const body = await expiring();
    expect(body).toMatchObject({ today, warningDays: 60 });
    expect(body.items.map((row: { kind: string; expired: boolean }) => [row.kind, row.expired])).toEqual([['WORK_AUTHORIZATION', true], ['MEDICAL_CARD', false]]);
    expect(JSON.stringify(body)).not.toContain('D1234567');
    // Non-Safety roles are refused.
    await agents.dispatch.get('/api/safety/expiring').set(headers).expect(403);
    // A closed record drops out of the list.
    const { version } = await driver(id);
    await agents.lead.post(`/api/safety/drivers/${id}/withdraw`).set(headers).send({ version, reason: 'Fictional withdrawal' }).expect(201);
    expect((await expiring()).items).toEqual([]);
  });

  it('marks an approved or cleared driver as left: closes the record, ends the owner and dispatch assignment, frees the contacts and records no private values', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    const left = (agent: Agent, version: number, body: Record<string, unknown> = {}) => agent.post(`/api/safety/drivers/${id}/left`).set(headers).send({ version, leftOn: usDay('latest'), reason: 'Fictional resignation', ...body });
    // Only approved or cleared drivers can leave.
    expect((await left(agents.manager, 1).expect(409)).body.message).toMatch(/approved or cleared/);
    await db.query(`UPDATE drivers SET status = 'CLEARED', "clearedAt" = now() - interval '3 days', version = 2 WHERE id = $1`, [id]);
    const owner = await db.query(`INSERT INTO driver_owners ("driverId", "ownerId", "startedAt") VALUES ($1, $2, now() - interval '3 days') RETURNING id`, [id, users.staff.id]);
    const mc = (await db.query(`INSERT INTO mcs (name, "nameKey", "mcNumber") VALUES ('Fictional MC', 'fictional mc', '698741') RETURNING id`))[0].id;
    const member = (await db.query(`INSERT INTO dispatch_members ("firstName", "lastName", position, status, "joinedAt") VALUES ('Dee', 'Fictional', 'DISPATCHER', 'ACTIVE', '2026-02-01T12:00:00Z') RETURNING id`))[0].id;
    await db.query(`INSERT INTO driver_assignments ("driverId", "mcId", "memberId", "startedAt") VALUES ($1, $2, $3, now() - interval '2 days')`, [id, mc, member]);
    try {
      // Roles and input: the Safety lead and other owners can't; the reason, a real date, not in the future, not before clearance.
      await left(agents.lead, 2).expect(403);
      await left(agents.staff2, 2).expect(403);
      await left(agents.dispatch, 2).expect(403);
      await left(agents.manager, 2, { reason: ' ' }).expect(400);
      await left(agents.manager, 2, { leftOn: '2026-13-01' }).expect(400);
      await left(agents.manager, 2, { leftOn: addDays(usDay('latest'), 1) }).expect(400);
      await left(agents.manager, 2, { leftOn: addDays(usDay('latest'), -10) }).expect(400);
      await left(agents.manager, 1).expect(409);
      expect((await left(agents.manager, 2).expect(201)).body.version).toBe(3);
      expect(await driver(id)).toMatchObject({ status: 'LEFT', statusReason: 'Fictional resignation', closedAt: expect.any(String), version: 3 });
      expect((await db.query(`SELECT count(*)::int AS n FROM driver_owners WHERE "driverId" = $1 AND "endedAt" IS NULL`, [id]))[0].n).toBe(0);
      expect((await db.query(`SELECT count(*)::int AS n FROM driver_assignments WHERE "driverId" = $1 AND "endedAt" IS NULL`, [id]))[0].n).toBe(0);
      expect((await events(id)).filter(row => row.event === 'LEFT').map(row => row.metadata)).toEqual([{ from: 'CLEARED', assignmentEnded: true, trucksArchived: false }]);
      expect(JSON.stringify(await events(id))).not.toContain('Fictional resignation');
      // Closed: no more changes, and the same person can be entered again.
      await left(agents.manager, 3).expect(409);
      await agents.lead.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: 3, notes: 'x' }).expect(409);
      expect((await agents.lead.get('/api/safety/drivers?status=CLOSED').set(headers).expect(200)).body.items.map((row: { status: string }) => row.status)).toEqual(['LEFT']);
      await add(agents.lead).expect(201);
    } finally { await db.query('TRUNCATE drivers, dispatch_members, mcs CASCADE'); void owner; }
  });

  it('lets the current owner mark their own approved driver as left', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    await db.query(`UPDATE drivers SET status = 'APPROVED', version = 2 WHERE id = $1`, [id]);
    await db.query(`INSERT INTO driver_owners ("driverId", "ownerId", "startedAt") VALUES ($1, $2, now() - interval '1 day')`, [id, users.staff.id]);
    await db.query(`INSERT INTO driver_trucks ("driverId", unit, vin, year, make) VALUES ($1, 'T-9', '1FUJGLLB5CLDF9999', 2020, 'Volvo')`, [id]);
    await agents.staff.post(`/api/safety/drivers/${id}/left`).set(headers).send({ version: 2, leftOn: usDay('latest'), reason: 'Fictional move' }).expect(201);
    expect(await driver(id)).toMatchObject({ status: 'LEFT' });
    // Their truck is archived with them, so its VIN is free for the next driver.
    expect((await db.query(`SELECT "archivedAt" IS NOT NULL AS archived FROM driver_trucks WHERE "driverId" = $1`, [id]))[0].archived).toBe(true);
    expect((await events(id)).find(row => row.event === 'LEFT')!.metadata).toEqual({ from: 'APPROVED', assignmentEnded: false, trucksArchived: true });
  });

  it('records yearly reviews of cleared drivers with a new MVR, lists the ones due, and keeps them as history', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    const day = usDay('latest');
    const review = (agent: Agent, version: number, body: Record<string, unknown> = {}) => agent.post(`/api/safety/drivers/${id}/annual-reviews`).set(headers).send({ version, reviewedOn: day, outcome: 'QUALIFIED', mvr: { file: '', pulledOn: day, paperAuthorization: true }, ...body });
    const withPdf = async (body: Record<string, unknown> = {}) => ({ mvr: { file: await mvrPdf(), pulledOn: day, paperAuthorization: true, ...body } });
    await review(agents.manager, 1, await withPdf()).expect(409);
    // Cleared 400 days ago, so the first yearly review is already overdue.
    await db.query(`UPDATE drivers SET status = 'CLEARED', "clearedAt" = now() - interval '400 days', version = 2 WHERE id = $1`, [id]);
    await db.query(`INSERT INTO driver_owners ("driverId", "ownerId", "startedAt") VALUES ($1, $2, now() - interval '400 days')`, [id, users.staff.id]);
    const due = async () => (await agents.lead.get('/api/safety/due').set(headers).expect(200)).body;
    expect((await due()).items).toMatchObject([{ driverId: id, overdue: true, lastReviewedOn: null, notQualified: false }]);
    await review(agents.lead, 2, await withPdf()).expect(403);
    await review(agents.staff2, 2, await withPdf()).expect(403);
    await review(agents.dispatch, 2, await withPdf()).expect(403);
    // Input: a real date, not in the future, a current MVR, its PDF, and a note unless qualified.
    await review(agents.manager, 2, { ...await withPdf(), reviewedOn: addDays(day, 1) }).expect(400);
    await review(agents.manager, 2, { ...await withPdf(), outcome: 'MAYBE' }).expect(400);
    await review(agents.manager, 2, { ...await withPdf(), outcome: 'NOT_QUALIFIED' }).expect(400);
    await review(agents.manager, 2, await withPdf({ pulledOn: addDays(day, -120) })).expect(400);
    await review(agents.manager, 2, await withPdf({ file: Buffer.from('not a pdf').toString('base64') })).expect(400);
    await review(agents.manager, 2, { mvr: undefined }).expect(400);
    await review(agents.manager, 2, await withPdf({ paperAuthorization: false })).expect(400);
    await review(agents.manager, 1, await withPdf()).expect(409);
    const recorded = (await review(agents.staff, 2, await withPdf()).expect(201)).body;
    expect(recorded.version).toBe(3);
    const profile = await driver(id);
    expect(profile.annualReviews).toMatchObject({ dueOn: addDays(day, 365), notQualified: false, items: [{ reviewedOn: day, outcome: 'QUALIFIED', mvr: { pulledOn: day, pageCount: 1 } }] });
    // The MVR opens like any report, and the event holds the outcome only.
    await agents.lead.get(`/api/safety/drivers/${id}/reports/${profile.annualReviews.items[0].mvr.id}/file`).set(headers).expect(200).expect('content-type', 'application/pdf');
    expect((await events(id)).filter(row => row.event === 'ANNUAL_REVIEW_RECORDED').map(row => row.metadata)).toEqual([{ outcome: 'QUALIFIED', withMvr: true }]);
    expect((await due()).items).toEqual([]);
    // A later review that finds the driver not qualified stays on the list until a qualified one follows; history is append-only.
    await review(agents.manager, 3, { ...await withPdf(), outcome: 'NOT_QUALIFIED', note: 'Fictional serious violation' }).expect(201);
    expect((await due()).items).toMatchObject([{ driverId: id, notQualified: true }]);
    expect(JSON.stringify(await events(id))).not.toContain('Fictional serious violation');
    await expect(db.query(`UPDATE driver_annual_reviews SET outcome = 'QUALIFIED'`)).rejects.toThrow();
    expect((await driver(id)).annualReviews.items.map((row: { outcome: string }) => row.outcome)).toEqual(['NOT_QUALIFIED', 'QUALIFIED']);
  });

  it('records drug and alcohol test results only, lists non-negative ones for follow-up and lets only the manager void an entry', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    const day = usDay('latest');
    const test = (agent: Agent, version: number, body: Record<string, unknown> = {}) => agent.post(`/api/safety/drivers/${id}/tests`).set(headers).send({ version, kind: 'DRUG', reason: 'RANDOM', testedOn: day, result: 'NEGATIVE', ...body });
    await test(agents.manager, 1).expect(409);
    await db.query(`UPDATE drivers SET status = 'CLEARED', "clearedAt" = now() - interval '30 days', version = 2 WHERE id = $1`, [id]);
    await db.query(`INSERT INTO driver_owners ("driverId", "ownerId", "startedAt") VALUES ($1, $2, now() - interval '30 days')`, [id, users.staff.id]);
    const attention = async (agent = agents.manager) => (await agent.get('/api/safety/due').set(headers).expect(200)).body.tests;
    await test(agents.lead, 2).expect(403);
    await test(agents.staff2, 2).expect(403);
    await test(agents.dispatch, 2).expect(403);
    await test(agents.manager, 2, { kind: 'URINE' }).expect(400);
    await test(agents.manager, 2, { reason: 'BORED' }).expect(400);
    await test(agents.manager, 2, { result: 'POSITIVE' }).expect(400);
    await test(agents.manager, 2, { testedOn: addDays(day, 1) }).expect(400);
    await test(agents.manager, 2, { testedOn: addDays(day, -60) }).expect(400);
    await test(agents.manager, 2, { lab: 'Fictional Lab' }).expect(400);
    await test(agents.manager, 1).expect(409);
    expect((await test(agents.staff, 2, { note: 'Fictional collection site', testedOn: addDays(day, -5) }).expect(201)).body.version).toBe(3);
    expect(await attention()).toEqual([]);
    // A not-negative drug test needs follow-up; an alcohol negative doesn't clear it, a later drug negative does.
    await test(agents.manager, 3, { result: 'NOT_NEGATIVE', testedOn: addDays(day, -1) }).expect(201);
    await test(agents.manager, 4, { kind: 'ALCOHOL', reason: 'FOLLOW_UP' }).expect(201);
    expect(await attention()).toMatchObject([{ driverId: id, kind: 'DRUG', result: 'NOT_NEGATIVE' }]);
    // Results are for the manager and the owner only (49 CFR 40.321): the lead and other staff see neither them nor why the driver is on hold.
    expect(await attention(agents.staff)).toHaveLength(1);
    expect(await attention(agents.lead)).toEqual([]);
    expect(await attention(agents.staff2)).toEqual([]);
    const as = async (agent: Agent) => (await agent.get(`/api/safety/drivers/${id}`).set(headers).expect(200)).body;
    expect(await as(agents.lead)).toMatchObject({ testing: { hidden: true }, hold: { onHold: false, test: null, review: false } });
    expect((await as(agents.staff2)).testing).toEqual({ hidden: true });
    expect(await as(agents.staff)).toMatchObject({ testing: { items: expect.any(Array) }, hold: { onHold: true, test: true } });
    await test(agents.manager, 5, { reason: 'RETURN_TO_DUTY' }).expect(201);
    expect(await attention()).toEqual([]);
    expect((await as(agents.manager)).hold).toEqual({ onHold: false, test: false, review: false, documents: false });
    // Entries are never edited: only the manager voids, with a reason, and a voided result no longer counts.
    const items = (await as(agents.manager)).testing.items as { id: string; result: string; voidedAt: string | null }[];
    expect(items).toHaveLength(4);
    const refused = items.find(row => row.result === 'NOT_NEGATIVE')!.id;
    const voidTest = (agent: Agent, version: number, testId: string, reason = 'Entered against the wrong driver') => agent.post(`/api/safety/drivers/${id}/tests/${testId}/void`).set(headers).send({ version, reason });
    await voidTest(agents.staff, 6, refused).expect(403);
    await voidTest(agents.manager, 6, refused, ' ').expect(400);
    await voidTest(agents.manager, 6, refused).expect(201);
    await voidTest(agents.manager, 7, refused).expect(409);
    expect((await as(agents.manager)).testing.items.find((row: { id: string }) => row.id === refused)).toMatchObject({ voidedAt: expect.any(String), voidReason: 'Entered against the wrong driver' });
    // Events name the kind and reason, never the result, the date or notes.
    expect((await events(id)).filter(row => row.event === 'TEST_RECORDED').map(row => row.metadata)[0]).toEqual({ kind: 'DRUG', reason: 'RANDOM' });
    expect(JSON.stringify(await events(id))).not.toMatch(/NOT_NEGATIVE|Fictional collection site|wrong driver/);
  });

  it('records accidents, violations and inspections of cleared drivers, settles open ones once and lets only the manager void', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    const day = usDay('latest');
    const incident = (agent: Agent, version: number, body: Record<string, unknown> = {}) => agent.post(`/api/safety/drivers/${id}/incidents`).set(headers)
      .send({ version, kind: 'ACCIDENT', occurredOn: day, state: 'tx', summary: 'Fictional rear-end contact at a dock', preventable: 'UNDETERMINED', injuries: false, fatalities: false, towAway: false, ...body });
    await incident(agents.manager, 1).expect(409);
    await db.query(`UPDATE drivers SET status = 'CLEARED', "clearedAt" = now() - interval '30 days', version = 2 WHERE id = $1`, [id]);
    await db.query(`INSERT INTO driver_owners ("driverId", "ownerId", "startedAt") VALUES ($1, $2, now() - interval '30 days')`, [id, users.staff.id]);
    const attention = async () => (await agents.lead.get('/api/safety/due').set(headers).expect(200)).body.incidents;
    await incident(agents.lead, 2).expect(403);
    await incident(agents.staff2, 2).expect(403);
    await incident(agents.dispatch, 2).expect(403);
    // Input: a kind, a real past date after clearance, a summary, and only the fields of that kind.
    await incident(agents.manager, 2, { kind: 'CRASH' }).expect(400);
    await incident(agents.manager, 2, { occurredOn: addDays(day, 1) }).expect(400);
    await incident(agents.manager, 2, { occurredOn: addDays(day, -60) }).expect(400);
    await incident(agents.manager, 2, { summary: ' ' }).expect(400);
    await incident(agents.manager, 2, { state: 'ZZ' }).expect(400);
    await incident(agents.manager, 2, { towAway: undefined }).expect(400);
    await incident(agents.manager, 2, { policeReport: 'R-1' }).expect(400);
    await incident(agents.manager, 2, { kind: 'VIOLATION', disposition: undefined }).expect(400);
    await incident(agents.manager, 2, { kind: 'INSPECTION', outOfService: false, violationCount: 99 }).expect(400);
    await incident(agents.manager, 1).expect(409);
    expect((await incident(agents.staff, 2).expect(201)).body.version).toBe(3);
    await incident(agents.manager, 3, { kind: 'VIOLATION', disposition: 'PENDING', summary: 'Fictional speeding citation', preventable: undefined, injuries: undefined, fatalities: undefined, towAway: undefined }).expect(201);
    await incident(agents.manager, 4, { kind: 'INSPECTION', outOfService: false, violationCount: 0, summary: 'Fictional level 2 inspection, clean', preventable: undefined, injuries: undefined, fatalities: undefined, towAway: undefined }).expect(201);
    // Open accidents and pending violations wait on the Safety list until settled; a clean inspection never does.
    expect((await attention()).map((row: { kind: string }) => row.kind).sort()).toEqual(['ACCIDENT', 'VIOLATION']);
    const items = (await driver(id)).incidents.items as { id: string; kind: string }[];
    const accident = items.find(row => row.kind === 'ACCIDENT')!.id, violation = items.find(row => row.kind === 'VIOLATION')!.id, inspection = items.find(row => row.kind === 'INSPECTION')!.id;
    const settle = (agent: Agent, version: number, incidentId: string, body: Record<string, unknown>) => agent.post(`/api/safety/drivers/${id}/incidents/${incidentId}/settle`).set(headers).send({ version, ...body });
    await settle(agents.lead, 5, accident, { preventable: 'NO' }).expect(403);
    await settle(agents.manager, 5, accident, {}).expect(400);
    await settle(agents.manager, 5, accident, { preventable: 'NO', disposition: 'DISMISSED' }).expect(400);
    await settle(agents.manager, 5, violation, { preventable: 'NO' }).expect(409);
    await settle(agents.manager, 5, inspection, { disposition: 'DISMISSED' }).expect(409);
    await settle(agents.staff, 5, accident, { preventable: 'NO' }).expect(201);
    await settle(agents.manager, 6, accident, { preventable: 'YES' }).expect(409);
    await settle(agents.manager, 6, violation, { disposition: 'CONVICTED' }).expect(201);
    expect(await attention()).toEqual([]);
    expect((await driver(id)).incidents.items.find((row: { id: string }) => row.id === accident)).toMatchObject({ preventable: 'NO', settledAt: expect.any(String) });
    // Only the manager voids, with a reason; the entry stays in the record.
    const voidIt = (agent: Agent, version: number, reason = 'Recorded against the wrong driver') => agent.post(`/api/safety/drivers/${id}/incidents/${inspection}/void`).set(headers).send({ version, reason });
    await voidIt(agents.staff, 7).expect(403);
    await voidIt(agents.manager, 7, ' ').expect(400);
    await voidIt(agents.manager, 7).expect(201);
    await voidIt(agents.manager, 8).expect(409);
    expect((await driver(id)).incidents.items.find((row: { id: string }) => row.id === inspection)).toMatchObject({ voidedAt: expect.any(String), voidReason: 'Recorded against the wrong driver' });
    // Events hold the kind only: no summary, notes, dates or outcomes.
    expect((await events(id)).filter(row => row.event.startsWith('INCIDENT_')).map(row => row.metadata).slice(0, 2)).toEqual([{ kind: 'ACCIDENT' }, { kind: 'VIOLATION' }]);
    expect(JSON.stringify(await events(id))).not.toMatch(/rear-end|speeding|CONVICTED|wrong driver/);
  });

  it('keeps an owner-operator’s trucks and their lease, insurance and registration PDFs, listing expiring ones', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    const day = usDay('latest');
    const truck = { unit: 'T-101', vin: '1fujgllb5cldf1234', year: 2021, make: 'Freightliner', plate: 'abc1234', plateState: 'tx' };
    const addTruck = (agent: Agent, version: number, body: Record<string, unknown> = {}) => agent.post(`/api/safety/drivers/${id}/trucks`).set(headers).send({ version, ...truck, ...body });
    await addTruck(agents.lead, 1).expect(409);
    await db.query(`UPDATE drivers SET status = 'APPROVED', version = 2 WHERE id = $1`, [id]);
    await db.query(`INSERT INTO driver_owners ("driverId", "ownerId", "startedAt") VALUES ($1, $2, now())`, [id, users.staff.id]);
    await addTruck(agents.dispatch, 2).expect(403);
    await addTruck(agents.staff2, 2).expect(403);
    await addTruck(agents.lead, 2, { vin: '1FUJGLLB5CLDF123I' }).expect(400);
    await addTruck(agents.lead, 2, { vin: 'SHORT' }).expect(400);
    await addTruck(agents.lead, 2, { year: 1950 }).expect(400);
    await addTruck(agents.lead, 2, { plateState: undefined }).expect(400);
    await addTruck(agents.lead, 2, { unit: ' ' }).expect(400);
    await addTruck(agents.lead, 1).expect(409);
    expect((await addTruck(agents.staff, 2).expect(201)).body.version).toBe(3);
    const trucks = async () => (await driver(id)).trucks.items as { id: string; vin: string; plate: string; plateState: string; documents: { id: string; kind: string; expiresOn: string | null }[]; archivedAt: string | null }[];
    expect((await trucks())[0]).toMatchObject({ vin: '1FUJGLLB5CLDF1234', plate: 'ABC1234', plateState: 'TX', documents: [] });
    const truckId = (await trucks())[0].id;
    // The same VIN can't be listed twice while the first is current.
    const other = (await add(agents.lead, { ...lead, phone: '+1 (555) 010-2999', email: 'other.driver@example.test' }).expect(201)).body.id;
    await db.query(`UPDATE drivers SET status = 'APPROVED', version = 2 WHERE id = $1`, [other]);
    expect((await agents.lead.post(`/api/safety/drivers/${other}/trucks`).set(headers).send({ version: 2, ...truck }).expect(409)).body.message).toMatch(/already has this VIN/);
    // Only owner-operators keep trucks.
    await db.query(`UPDATE drivers SET "driverType" = 'COMPANY' WHERE id = $1`, [other]);
    expect((await agents.lead.post(`/api/safety/drivers/${other}/trucks`).set(headers).send({ version: 2, ...truck, vin: '2FUJGLLB5CLDF1234' }).expect(409)).body.message).toMatch(/owner-operators/);
    // Documents: a PDF per kind, an expiration for insurance and registration, replaced files are kept.
    const file = await mvrPdf();
    const upload = (agent: Agent, version: number, body: Record<string, unknown> = {}) => agent.post(`/api/safety/drivers/${id}/trucks/${truckId}/documents`).set(headers).send({ version, kind: 'INSURANCE', file, expiresOn: addDays(day, 20), ...body });
    await upload(agents.dispatch, 3).expect(403);
    await upload(agents.staff2, 3).expect(403);
    await upload(agents.lead, 3, { expiresOn: undefined }).expect(400);
    await upload(agents.lead, 3, { kind: 'POLICY' }).expect(400);
    await upload(agents.lead, 3, { file: Buffer.from('not a pdf').toString('base64') }).expect(400);
    await upload(agents.lead, 3, { policyNumber: 'P-1' }).expect(400);
    await upload(agents.lead, 2).expect(409);
    expect((await upload(agents.staff, 3).expect(201)).body.version).toBe(4);
    await upload(agents.lead, 4, { kind: 'LEASE', expiresOn: undefined }).expect(201);
    await upload(agents.lead, 5, { kind: 'REGISTRATION', expiresOn: addDays(day, 300) }).expect(201);
    const docs = (await trucks())[0].documents;
    expect(docs.map(row => row.kind).sort()).toEqual(['INSURANCE', 'LEASE', 'REGISTRATION']);
    const insurance = docs.find(row => row.kind === 'INSURANCE')!.id;
    await agents.lead.get(`/api/safety/drivers/${id}/trucks/${truckId}/documents/${insurance}/file`).set(headers).expect(200).expect('content-type', 'application/pdf').expect('cache-control', 'no-store, private');
    await agents.dispatch.get(`/api/safety/drivers/${id}/trucks/${truckId}/documents/${insurance}/file`).set(headers).expect(403);
    // Insurance expiring within 60 days appears with the other expiring documents; registration far away doesn't.
    const expiring = (await agents.staff.get('/api/safety/expiring').set(headers).expect(200)).body.items as { kind: string; truck: string | null }[];
    expect(expiring.map(row => [row.kind, row.truck])).toEqual([['INSURANCE', 'T-101']]);
    expect(JSON.stringify(expiring)).not.toMatch(/notes|passwordHash/);
    // A new insurance PDF replaces the current one; the old row is kept.
    await upload(agents.lead, 6, { expiresOn: addDays(day, 365) }).expect(201);
    expect((await agents.staff.get('/api/safety/expiring').set(headers).expect(200)).body.items).toEqual([]);
    expect((await db.query(`SELECT count(*)::int AS n FROM driver_owner_documents WHERE kind = 'INSURANCE'`))[0].n).toBe(2);
    // The list shows every truck with its dates; archiving removes it from the expiring list and frees the VIN.
    expect((await agents.staff2.get('/api/safety/trucks').set(headers).expect(200)).body.items).toMatchObject([{ unit: 'T-101', hasLease: true, insuranceExpiresOn: addDays(day, 365), firstName: 'Jordan' }]);
    await agents.dispatch.get('/api/safety/trucks').set(headers).expect(403);
    await agents.lead.post(`/api/safety/drivers/${id}/trucks/${truckId}/archive`).set(headers).send({ version: 7 }).expect(201);
    await agents.lead.post(`/api/safety/drivers/${id}/trucks/${truckId}/archive`).set(headers).send({ version: 8 }).expect(409);
    await agents.lead.post(`/api/safety/drivers/${other}/trucks`).set(headers).send({ version: 2, ...truck }).expect(409);
    // Events name the action or kind only.
    expect((await events(id)).filter(row => /^(TRUCK|OWNER_DOCUMENT)/.test(row.event)).map(row => [row.event, row.metadata]).slice(0, 2)).toEqual([['TRUCK_SAVED', { action: 'added' }], ['OWNER_DOCUMENT_UPLOADED', { kind: 'INSURANCE' }]]);
    expect(JSON.stringify(await events(id))).not.toMatch(/1FUJGL|ABC1234|Freightliner/);
  });

  it('reopens a submitted application when a withdrawn driver gets a new link, keeping verified scans', async () => {
    const { id, agent } = await applying();
    const license = ((await scanAll(agent)).documents as { id: string; kind: string }[]).find(row => row.kind === 'LICENSE')!.id;
    await agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: complete, history: history(), ssn: '123456789' }).expect(201);
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
    expect(existsSync(join(storage, 'drivers', id, 'documents', 'license', `${license}.pdf`))).toBe(true);
    await again.post('/api/driver/application/submit').set(headers).send({ version: 3, fields: complete, history: history() }).expect(201);
    expect(await driver(id)).toMatchObject({ status: 'SCREENING', application: { status: 'SUBMITTED' } });
  });

  it('ends a submitted session when Safety withdraws the driver, changes their email or reopens the application', async () => {
    async function submitted() {
      const one = await applying();
      const license = ((await scanAll(one.agent)).documents as { id: string; kind: string }[]).find(row => row.kind === 'LICENSE')!.id;
      await one.agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: complete, history: history(), ssn: '123456789' }).expect(201);
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
    rmSync(join(storage, 'driver-reports'), { recursive: true, force: true });
    rmSync(join(storage, 'driver-consents'), { recursive: true, force: true }); rmSync(join(storage, 'company-documents'), { recursive: true, force: true });
    const { id, agent } = await applying();
    const sweeper = app.get(ScanSweeper), later = Date.now() + LEFTOVER_SCAN_AGE_MS + 60_000;
    const file = (documentId: string) => join(storage, 'drivers', id, 'documents', 'license', `${documentId}.pdf`);
    const report = (reportId: string) => join(storage, 'driver-reports', id, `${reportId}.pdf`);
    const replaced = (await scan(agent, 'license').expect(201)).body.documents[0].id as string, pdf = readFileSync(file(replaced));
    const current = (await scan(agent, 'license').expect(201)).body.documents[0].id as string;
    // A replaced scan whose removal failed, a file whose row never committed, and a file the API never names.
    writeFileSync(file(replaced), pdf);
    const unreferenced = randomUUID(); writeFileSync(file(unreferenced), pdf);
    const foreign = join(storage, 'drivers', id, 'notes.txt'); writeFileSync(foreign, 'fictional');
    // An MVR upload that never committed is a leftover; a recorded MVR (current or replaced) is kept.
    mkdirSync(join(storage, 'driver-reports', id), { recursive: true });
    const uncommitted = randomUUID(), recorded = randomUUID();
    writeFileSync(report(uncommitted), pdf); writeFileSync(report(recorded), pdf);
    await db.query(`INSERT INTO driver_reports (id, "driverId", kind, "pulledOn", "pageCount", sha256, "byteSize", "createdAt", "replacedAt")
      VALUES ($1, $2, 'MVR', CURRENT_DATE, 1, repeat('0', 64), 1, now(), now())`, [recorded, id]);
    // A consent form whose publish never committed is a leftover too.
    mkdirSync(join(storage, 'driver-consents'), { recursive: true });
    const unpublished = join(storage, 'driver-consents', `${randomUUID()}.pdf`); writeFileSync(unpublished, pdf);
    // The per-person folders: an uncommitted MVR and an unpublished form are leftovers too; a saved signed copy never is.
    mkdirSync(join(storage, 'drivers', id, 'reports', 'mvr'), { recursive: true }); mkdirSync(join(storage, 'drivers', id, 'signed'), { recursive: true });
    mkdirSync(join(storage, 'company-documents', 'driver-consents', 'background-disclosure'), { recursive: true });
    const foldered = join(storage, 'drivers', id, 'reports', 'mvr', `${randomUUID()}.pdf`); writeFileSync(foldered, pdf);
    const formLeftover = join(storage, 'company-documents', 'driver-consents', 'background-disclosure', `${randomUUID()}.pdf`); writeFileSync(formLeftover, pdf);
    const signedCopy = join(storage, 'drivers', id, 'signed', 'background-disclosure-v1.pdf'); writeFileSync(signedCopy, pdf);
    expect(await sweeper.sweep()).toBe(0);
    expect([file(replaced), file(unreferenced), report(uncommitted), unpublished, foldered, formLeftover].every(path => existsSync(path))).toBe(true);
    expect(await sweeper.sweep(later)).toBe(6);
    expect([existsSync(unpublished), existsSync(foldered), existsSync(formLeftover), existsSync(signedCopy)]).toEqual([false, false, false, true]);
    expect([existsSync(file(replaced)), existsSync(file(unreferenced)), existsSync(file(current)), existsSync(foreign)]).toEqual([false, false, true, true]);
    expect([existsSync(report(uncommitted)), existsSync(report(recorded))]).toEqual([false, true]);
    // A replaced scan Safety verified (a reopened application) is the record of what was checked.
    writeFileSync(file(replaced), pdf);
    await db.query(`UPDATE driver_documents SET "verifiedAt" = now() WHERE id = $1`, [replaced]);
    expect(await sweeper.sweep(later)).toBe(0);
    expect(existsSync(file(replaced))).toBe(true);
    // Owner-operator documents: a file no row names is a leftover; one a row names (current or replaced) is kept.
    mkdirSync(join(storage, 'drivers', id, 'owner-operator', 'insurance'), { recursive: true });
    const truck = (await db.query(`INSERT INTO driver_trucks ("driverId", unit, vin, year, make) VALUES ($1, 'T-1', '1FUJGLLB5CLDF1234', 2021, 'Fictional') RETURNING id`, [id]))[0].id as string;
    const kept = randomUUID(), orphan = randomUUID(), ownerFile = (documentId: string) => join(storage, 'drivers', id, 'owner-operator', 'insurance', `${documentId}.pdf`);
    writeFileSync(ownerFile(kept), pdf); writeFileSync(ownerFile(orphan), pdf);
    await db.query(`INSERT INTO driver_owner_documents (id, "driverId", "truckId", kind, "expiresOn", "pageCount", sha256, "byteSize", "replacedAt") VALUES ($1, $2, $3, 'INSURANCE', CURRENT_DATE, 1, repeat('0', 64), 1, now())`, [kept, id, truck]);
    expect(await sweeper.sweep(later)).toBe(1);
    expect([existsSync(ownerFile(kept)), existsSync(ownerFile(orphan))]).toEqual([true, false]);
  });

  /** A driver who submitted a complete application with every scan, now in Screening. */
  async function submitted() {
    const one = await applying();
    const documents = (await scanAll(one.agent)).documents as { id: string; kind: string }[];
    await one.agent.post('/api/driver/application/submit').set(headers).send({ version: 1, fields: complete, history: history(), ssn: '123456789' }).expect(201);
    return { ...one, documents, version: (await driver(one.id)).version as number };
  }
  const mvrPdf = async () => { const pdf = await PDFDocument.create(); pdf.addPage(); return Buffer.from(await pdf.save()).toString('base64'); };
  // Dates as the API sees them (the earliest US date), so no test date is "in the future" late in a UTC day.
  const today = () => usDay('earliest');
  const daysAgo = (days: number) => addDays(today(), -days);
  const check = (agent: Agent, id: string, key: string, body: Record<string, unknown>) => agent.post(`/api/safety/drivers/${id}/checks/${key}`).set(headers).send(body);
  const decide = (agent: Agent, id: string, body: Record<string, unknown>) => agent.post(`/api/safety/drivers/${id}/decision`).set(headers).send(body);
  /** A submitted driver with every scan verified, the MVR uploaded and every check passed, still in Screening. */
  async function screened() {
    const one = await submitted();
    for (const document of one.documents) await agents.lead.post(`/api/safety/drivers/${one.id}/documents/${document.id}/verify`).set(headers)
      .send({ version: 1, ...(document.kind === 'WORK_AUTHORIZATION' ? {} : { expiresOn: '2030-01-31' }) }).expect(201);
    let { version } = (await agents.lead.post(`/api/safety/drivers/${one.id}/mvr`).set(headers).send({ version: one.version, file: await mvrPdf(), pulledOn: today(), paperAuthorization: true }).expect(201)).body;
    for (const key of ['IDENTITY', 'PHONE_SCREEN', 'EXPERIENCE', 'HISTORY', 'MVR']) version = (await check(agents.lead, one.id, key, { version, result: 'PASS' }).expect(201)).body.version;
    return { ...one, version: version as number };
  }
  /** A screened driver handed to the Safety manager. */
  async function awaiting() {
    const one = await screened();
    const { version } = (await agents.lead.post(`/api/safety/drivers/${one.id}/send-for-decision`).set(headers).send({ version: one.version }).expect(201)).body;
    return { ...one, version: version as number };
  }

  it('screens a submitted driver: the checklist, the MVR and verified scans all come before the hand-off', async () => {
    const { id, documents, version } = await submitted();
    await check(agents.staff, id, 'IDENTITY', { version, result: 'PASS' }).expect(403);
    await check(agents.lead, id, 'CREDIT', { version, result: 'PASS' }).expect(404);
    expect((await check(agents.lead, id, 'EXPERIENCE', { version, result: 'CONCERN' }).expect(400)).body.message).toMatch(/Describe the concern/);
    expect((await check(agents.lead, id, 'MVR', { version, result: 'PASS' }).expect(400)).body.message).toBe('Upload the MVR first.');
    const refused = (await agents.lead.post(`/api/safety/drivers/${id}/send-for-decision`).set(headers).send({ version }).expect(400)).body;
    expect(refused.missing).toEqual(['check:IDENTITY', 'check:PHONE_SCREEN', 'check:EXPERIENCE', 'check:HISTORY', 'check:MVR', 'mvr', 'document:LICENSE', 'document:MEDICAL_CARD', 'document:WORK_AUTHORIZATION']);
    // The MVR: a readable PDF pulled within the last year, replaced by a newer one while the earlier file is kept.
    const upload = (body: Record<string, unknown>) => agents.lead.post(`/api/safety/drivers/${id}/mvr`).set(headers).send({ version, file: '', pulledOn: today(), paperAuthorization: true, ...body });
    await upload({ file: Buffer.from('not a pdf').toString('base64') }).expect(400);
    await upload({ file: Buffer.from('%PDF-1.7 broken').toString('base64') }).expect(400);
    expect((await upload({ file: await mvrPdf(), pulledOn: daysAgo(400) }).expect(400)).body.message).toMatch(/more than a year old/);
    await upload({ file: await mvrPdf(), pulledOn: daysAgo(-5) }).expect(400);
    await agents.staff.post(`/api/safety/drivers/${id}/mvr`).set(headers).send({ version, file: await mvrPdf(), pulledOn: today() }).expect(403);
    const first = (await upload({ file: await mvrPdf(), pulledOn: daysAgo(2) }).expect(201)).body;
    const firstReport = (await driver(id)).screening.mvr.id as string;
    await upload({ version: first.version, file: await mvrPdf() }).expect(201);
    const record = await driver(id);
    expect(record.screening.mvr).toMatchObject({ pulledOn: today(), pageCount: 1, uploadedBy: 'Fictional lead' });
    expect(existsSync(join(storage, 'drivers', id, 'reports', 'mvr', `${firstReport}.pdf`))).toBe(true);
    // Every Safety role may open it, and each view is recorded; nobody else may.
    await agents.staff.get(`/api/safety/drivers/${id}/reports/${record.screening.mvr.id}/file`).set(headers).expect(200).expect('content-type', 'application/pdf').expect('cache-control', 'no-store, private');
    await agents.dispatch.get(`/api/safety/drivers/${id}/reports/${record.screening.mvr.id}/file`).set(headers).expect(403);
    let current = record.version as number;
    current = (await check(agents.lead, id, 'IDENTITY', { version: current, result: 'PASS' }).expect(201)).body.version;
    await check(agents.lead, id, 'PHONE_SCREEN', { version: current - 1, result: 'PASS' }).expect(409);
    current = (await check(agents.lead, id, 'PHONE_SCREEN', { version: current, result: 'PASS' }).expect(201)).body.version;
    current = (await check(agents.lead, id, 'EXPERIENCE', { version: current, result: 'CONCERN', note: 'Two years, not five as stated.' }).expect(201)).body.version;
    current = (await check(agents.lead, id, 'HISTORY', { version: current, result: 'PASS' }).expect(201)).body.version;
    current = (await check(agents.manager, id, 'MVR', { version: current, result: 'PASS' }).expect(201)).body.version;
    // A check can be cleared and done again.
    current = (await check(agents.lead, id, 'MVR', { version: current, result: null }).expect(201)).body.version;
    expect((await agents.lead.post(`/api/safety/drivers/${id}/send-for-decision`).set(headers).send({ version: current }).expect(400)).body.missing)
      .toEqual(['check:MVR', 'document:LICENSE', 'document:MEDICAL_CARD', 'document:WORK_AUTHORIZATION']);
    current = (await check(agents.lead, id, 'MVR', { version: current, result: 'PASS', note: 'Clean' }).expect(201)).body.version;
    for (const document of documents) await agents.lead.post(`/api/safety/drivers/${id}/documents/${document.id}/verify`).set(headers)
      .send({ version: 1, ...(document.kind === 'WORK_AUTHORIZATION' ? {} : { expiresOn: '2030-01-31' }) }).expect(201);
    await agents.staff.post(`/api/safety/drivers/${id}/send-for-decision`).set(headers).send({ version: current }).expect(403);
    const sent = (await agents.lead.post(`/api/safety/drivers/${id}/send-for-decision`).set(headers).send({ version: current, note: 'Experience shorter than stated; otherwise fine.' }).expect(201)).body;
    const after = await driver(id, agents.staff);
    expect(after).toMatchObject({ status: 'AWAITING_DECISION', version: sent.version, screening: { missing: [], finalRejectionFrom: null } });
    expect(after.screening.checks.find((row: { key: string }) => row.key === 'EXPERIENCE')).toMatchObject({ result: 'CONCERN', note: 'Two years, not five as stated.', checkedBy: 'Fictional lead' });
    expect(after.screening.reviews).toEqual([expect.objectContaining({ action: 'SENT_FOR_DECISION', note: 'Experience shorter than stated; otherwise fine.', previousStatus: 'SCREENING', newStatus: 'AWAITING_DECISION', actor: 'Fictional lead' })]);
    // Screening is closed while the Safety manager decides.
    await check(agents.lead, id, 'MVR', { version: sent.version, result: null }).expect(409);
    await agents.lead.post(`/api/safety/drivers/${id}/mvr`).set(headers).send({ version: sent.version, file: await mvrPdf(), pulledOn: today() }).expect(409);
    const recorded = await events(id);
    expect(recorded.filter(row => row.event === 'SENT_FOR_DECISION').map(row => row.metadata)).toEqual([{ concerns: 1 }]);
    expect(recorded.filter(row => row.event === 'MVR_UPLOADED').map(row => row.metadata)).toEqual([{ replaced: false, authorization: 'PAPER' }, { replaced: true, authorization: 'PAPER' }]);
    expect(recorded.filter(row => row.event === 'MVR_VIEWED')).toHaveLength(1);
    expect(recorded.filter(row => row.event === 'SCREENING_CHECKED')[2].metadata).toEqual({ check: 'EXPERIENCE', result: 'CONCERN' });
    expect(JSON.stringify(recorded)).not.toMatch(/Two years|otherwise fine|Clean/);
    expect(await app.get(ScreeningService).waitingCount(users.manager)).toBe(1);
    expect(await app.get(ScreeningService).waitingCount(users.lead)).toBe(0);
    expect(await app.get(ScreeningService).waitingCount(users.staff)).toBeNull();
  });

  it('sends the application back to the driver with a message and a new link, and returns them to screening on resubmission', async () => {
    const { id, agent, version } = await submitted();
    await agents.staff.post(`/api/safety/drivers/${id}/corrections`).set(headers).send({ version, message: 'Fix the ZIP code.' }).expect(403);
    await agents.lead.post(`/api/safety/drivers/${id}/corrections`).set(headers).send({ version, message: '  ' }).expect(400);
    const returned = (await agents.lead.post(`/api/safety/drivers/${id}/corrections`).set(headers).send({ version, message: 'Your ZIP code doesn’t match your city. Check it and send again.' }).expect(201)).body;
    expect(returned.url).toMatch(/\/driver#[a-f0-9]{64}$/);
    expect(await driver(id)).toMatchObject({ status: 'APPLYING', link: { email: 'jordan.wheeler@example.test' },
      application: { status: 'DRAFT', submittedAt: null, correctionNote: 'Your ZIP code doesn’t match your city. Check it and send again.' } });
    // The session that submitted can't read the application any more; the new link verifies afresh.
    await agent.get('/api/driver/application').set(headers).expect(401);
    const again = request.agent(app.getHttpServer());
    const { challengeId } = (await again.post('/api/driver/begin').set(headers).send({ token: returned.url.split('#').pop(), email: 'jordan.wheeler@example.test' }).expect(201)).body;
    await settle();
    await again.post('/api/driver/verify').set(headers).send({ challengeId, code: sent.at(-1)!.code }).expect(201);
    const view = (await again.get('/api/driver/application').set(headers).expect(200)).body;
    expect(view).toMatchObject({ status: 'DRAFT', ssnLast4: '6789', correction: { message: 'Your ZIP code doesn’t match your city. Check it and send again.', requestedAt: expect.any(String) } });
    await again.post('/api/driver/application/submit').set(headers).send({ version: view.version, fields: { zip: '78701' } }).expect(201);
    const back = await driver(id);
    expect(back).toMatchObject({ status: 'SCREENING', application: { status: 'SUBMITTED', correctionNote: null, correctionRequestedAt: null, fields: { zip: '78701' } } });
    expect((await again.get('/api/driver/application').set(headers).expect(200)).body.correction).toBeNull();
    expect((await events(id)).filter(row => row.event === 'CORRECTIONS_REQUESTED').map(row => row.metadata)).toEqual([{}]);
    // Only a driver in screening can be sent back.
    await agents.lead.post(`/api/safety/drivers/${id}/corrections`).set(headers).send({ version: back.version - 1, message: 'Again' }).expect(409);
    // A withdrawal ends a round of corrections: reopened and sent a new link, the driver never sees the old message.
    const again2 = (await agents.lead.post(`/api/safety/drivers/${id}/corrections`).set(headers).send({ version: back.version, message: 'Check your license number.' }).expect(201)).body;
    const out = (await agents.lead.post(`/api/safety/drivers/${id}/withdraw`).set(headers).send({ version: again2.version, reason: 'Stopped replying' }).expect(201)).body;
    expect((await driver(id)).application).toMatchObject({ correctionNote: null, correctionRequestedAt: null });
    const lead = (await agents.lead.post(`/api/safety/drivers/${id}/reopen`).set(headers).send({ version: out.version }).expect(201)).body;
    await agents.lead.post(`/api/safety/drivers/${id}/link`).set(headers).send({ version: lead.version }).expect(201);
    expect((await driver(id)).application).toMatchObject({ status: 'DRAFT', correctionNote: null });
  });

  it('lets only the Safety manager decide: approval with conditions, more information, and a rejection in two recorded steps', async () => {
    const approved = await awaiting();
    await decide(agents.lead, approved.id, { version: approved.version, decision: 'APPROVE' }).expect(403);
    await decide(agents.staff, approved.id, { version: approved.version, decision: 'APPROVE' }).expect(403);
    await decide(agents.manager, approved.id, { version: approved.version, decision: 'MORE_INFO', conditions: 'x', note: 'x' }).expect(400);
    expect((await decide(agents.manager, approved.id, { version: approved.version, decision: 'MORE_INFO' }).expect(400)).body.message).toBe('Give the reason.');
    // More information sends the driver back to screening, and the lead sends them again.
    const back = (await decide(agents.manager, approved.id, { version: approved.version, decision: 'MORE_INFO', note: 'Call the last employer about the gap.' }).expect(201)).body;
    expect((await driver(approved.id)).status).toBe('SCREENING');
    const resent = (await agents.lead.post(`/api/safety/drivers/${approved.id}/send-for-decision`).set(headers).send({ version: back.version }).expect(201)).body;
    const done = (await decide(agents.manager, approved.id, { version: resent.version, decision: 'APPROVE', conditions: 'Road test before the first load.' }).expect(201)).body;
    const record = await driver(approved.id);
    expect(record).toMatchObject({ status: 'APPROVED', closedAt: null, version: done.version });
    expect(record.screening.reviews.map((row: { action: string }) => row.action)).toEqual(['APPROVED', 'SENT_FOR_DECISION', 'MORE_INFO', 'SENT_FOR_DECISION']);
    expect(record.screening.reviews[0]).toMatchObject({ conditions: 'Road test before the first load.', actor: 'Fictional manager', previousStatus: 'AWAITING_DECISION' });
    expect((await events(approved.id)).filter(row => ['APPROVED', 'MORE_INFO_REQUESTED'].includes(row.event)).map(row => [row.event, row.metadata]))
      .toEqual([['MORE_INFO_REQUESTED', {}], ['APPROVED', { conditional: true }]]);
    // The approved driver gets a safety staff owner; decisions are append-only.
    await agents.lead.post(`/api/safety/drivers/${approved.id}/owner`).set(headers).send({ version: done.version, ownerId: users.staff.id }).expect(201);
    await decide(agents.manager, approved.id, { version: done.version + 1, decision: 'APPROVE' }).expect(409);
    await expect(db.query(`UPDATE driver_reviews SET note = 'changed' WHERE "driverId" = $1`, [approved.id])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM driver_reviews WHERE "driverId" = $1`, [approved.id])).rejects.toThrow(/append-only/);
    await db.query('TRUNCATE drivers CASCADE');

    // A rejection: the pre-adverse notice first, then the final notice once the waiting period is over.
    const rejected = await awaiting();
    expect((await decide(agents.manager, rejected.id, { version: rejected.version, decision: 'REJECT', note: 'MVR', noticeSent: true, noticeSentOn: today() }).expect(409)).body.message).toMatch(/pre-adverse notice first/);
    const notice = { decision: 'PRE_ADVERSE', note: 'Two speeding violations in the last year on the MVR.' };
    expect((await decide(agents.manager, rejected.id, { version: rejected.version, ...notice, noticeSentOn: today() }).expect(400)).body.message).toMatch(/confirm/);
    await decide(agents.manager, rejected.id, { version: rejected.version, ...notice, noticeSent: true, noticeSentOn: daysAgo(-3) }).expect(400);
    await decide(agents.manager, rejected.id, { version: rejected.version, ...notice, noticeSent: true, noticeSentOn: daysAgo(45) }).expect(400);
    await decide(agents.manager, rejected.id, { version: rejected.version, decision: 'APPROVE', noticeSentOn: today() }).expect(400);
    // A notice can't be dated before the driver reached the Safety manager: a backdated one would end the wait at once.
    expect((await decide(agents.manager, rejected.id, { version: rejected.version, ...notice, noticeSent: true, noticeSentOn: daysAgo(20) }).expect(400)).body.message).toMatch(/before the driver was sent/);
    // As if the driver had been sent for a decision 25 days ago (the table is append-only, so the trigger is lifted here only).
    await db.query('ALTER TABLE driver_reviews DISABLE TRIGGER driver_reviews_append_only');
    await db.query(`UPDATE driver_reviews SET "createdAt" = now() - interval '25 days' WHERE "driverId" = $1 AND action = 'SENT_FOR_DECISION'`, [rejected.id]);
    await db.query('ALTER TABLE driver_reviews ENABLE TRIGGER driver_reviews_append_only');
    const pre = (await decide(agents.manager, rejected.id, { version: rejected.version, ...notice, noticeSent: true, noticeSentOn: daysAgo(20) }).expect(201)).body;
    const waiting = await driver(rejected.id);
    expect(waiting).toMatchObject({ status: 'PRE_ADVERSE', closedAt: null, screening: { finalRejectionFrom: earliestFinalRejection(daysAgo(20)) } });
    // The waiting period is over, so the final notice is waiting on the Safety manager.
    expect(await app.get(ScreeningService).waitingCount(users.manager)).toBe(1);
    await decide(agents.manager, rejected.id, { version: pre.version, ...notice, noticeSent: true, noticeSentOn: today() }).expect(409);
    // The final notice is dated on or after the end of the waiting period.
    expect((await decide(agents.manager, rejected.id, { version: pre.version, decision: 'REJECT', note: 'No response to the notice.', noticeSent: true, noticeSentOn: daysAgo(19) }).expect(409)).body.message).toMatch(/waiting period/);
    const final = (await decide(agents.manager, rejected.id, { version: pre.version, decision: 'REJECT', note: 'No response to the notice.', noticeSent: true, noticeSentOn: today() }).expect(201)).body;
    const closed = await driver(rejected.id);
    expect(closed).toMatchObject({ status: 'REJECTED', closedAt: expect.any(String), version: final.version, screening: { finalRejectionFrom: null } });
    expect(closed.screening.reviews.slice(0, 2).map((row: { action: string; noticeSentOn: string }) => [row.action, row.noticeSentOn])).toEqual([['REJECTED', today()], ['PRE_ADVERSE', daysAgo(20)]]);
    expect(JSON.stringify(await events(rejected.id))).not.toMatch(/speeding|No response/);
    // A closed record frees the phone and email for a new lead.
    await add(agents.lead).expect(201);
    await db.query('TRUNCATE drivers CASCADE');

    // During the waiting period the rejection can't be final; the manager can still approve or withdraw the driver.
    const disputed = await awaiting();
    const out = (await decide(agents.manager, disputed.id, { version: disputed.version, ...notice, noticeSent: true, noticeSentOn: today() }).expect(201)).body;
    expect((await decide(agents.manager, disputed.id, { version: out.version, decision: 'REJECT', note: 'x', noticeSent: true, noticeSentOn: today() }).expect(409)).body.message)
      .toContain(earliestFinalRejection(today()));
    // Still within the waiting period: nothing is waiting on the Safety manager yet.
    expect(await app.get(ScreeningService).waitingCount(users.manager)).toBe(0);
    await decide(agents.admin, disputed.id, { version: out.version, decision: 'APPROVE' }).expect(201);
    expect((await driver(disputed.id)).status).toBe('APPROVED');
  });

  /** Publishes a fictional consent form version and returns the response body after checking the status. */
  const publish = async (agent: Agent, kind: string, status: number, title = 'Fictional form') =>
    (await agent.post('/api/safety/consents').set(headers).send({ kind, title, file: await mvrPdf() }).expect(status)).body;
  const signature = () => `data:image/png;base64,${png(600, 180).toString('base64')}`;
  const sign = (agent: Agent, documentId: string, body: Record<string, unknown> = {}) => agent.post(`/api/driver/consents/${documentId}/sign`).set(headers)
    .send({ typedName: 'Jordan Wheeler', consent: true, agreed: true, signature: signature(), signatureMethod: 'DRAWN', ...body });
  const submit = (agent: Agent, version: number) => agent.post('/api/driver/application/submit').set(headers).send({ version, fields: complete, history: history(), ssn: '123456789' });

  it('lets only the Safety manager publish consent forms, as immutable versions every Safety role can read', async () => {
    await publish(agents.lead, 'BACKGROUND_AUTHORIZATION', 403);
    await publish(agents.staff, 'BACKGROUND_AUTHORIZATION', 403);
    await agents.dispatch.get('/api/safety/consents').set(headers).expect(403);
    await agents.manager.post('/api/safety/consents').set(headers).send({ kind: 'BACKGROUND_AUTHORIZATION', title: 'Form', file: Buffer.from('not a pdf').toString('base64') }).expect(400);
    await publish(agents.manager, 'CREDIT_CHECK', 400);
    const first = await publish(agents.manager, 'BACKGROUND_AUTHORIZATION', 201, 'Fictional authorization');
    const second = await publish(agents.admin, 'BACKGROUND_AUTHORIZATION', 201, 'Fictional authorization');
    expect([first.version, second.version]).toEqual([1, 2]);
    const list = (await agents.lead.get('/api/safety/consents').set(headers).expect(200)).body;
    expect(list).toMatchObject({ storageEnabled: true, canPublish: false });
    expect(list.kinds.map((kind: { kind: string; signature: boolean; versions: unknown[] }) => [kind.kind, kind.signature, kind.versions.length]))
      .toEqual([['BACKGROUND_DISCLOSURE', false, 0], ['BACKGROUND_AUTHORIZATION', true, 2], ['CLEARINGHOUSE_CONSENT', true, 0]]);
    expect((await agents.manager.get('/api/safety/consents').set(headers).expect(200)).body.canPublish).toBe(true);
    await agents.staff.get(`/api/safety/consents/${first.id}/file`).set(headers).expect(200).expect('content-type', 'application/pdf');
    await expect(db.query(`UPDATE driver_consent_documents SET title = 'Changed' WHERE id = $1`, [first.id])).rejects.toThrow(/append-only/);
  });

  it('has drivers open and sign the current version of every published form before submitting, with signing evidence', async () => {
    const disclosure = await publish(agents.manager, 'BACKGROUND_DISCLOSURE', 201, 'Fictional disclosure');
    const authorization = await publish(agents.manager, 'BACKGROUND_AUTHORIZATION', 201, 'Fictional authorization');
    const { id, agent } = await applying();
    await scanAll(agent);
    const view = (await agent.get('/api/driver/application').set(headers).expect(200)).body;
    expect(view.consents.required).toBe(true);
    expect(view.consents.items.map((item: { kind: string; requiresSignature: boolean; viewed: boolean; signed: unknown }) => [item.kind, item.requiresSignature, item.viewed, item.signed]))
      .toEqual([['BACKGROUND_DISCLOSURE', false, false, null], ['BACKGROUND_AUTHORIZATION', true, false, null]]);
    expect((await submit(agent, view.version).expect(400)).body.missing).toEqual(['consent:BACKGROUND_DISCLOSURE', 'consent:BACKGROUND_AUTHORIZATION']);
    // Fetching the file records nothing; only the explicit view request does.
    await agent.get(`/api/driver/consents/${authorization.id}/file`).set(headers).expect(200).expect('content-type', 'application/pdf');
    expect((await sign(agent, authorization.id).expect(400)).body.message).toMatch(/Open and read the full form/);
    await agent.post(`/api/driver/consents/${authorization.id}/view`).set(headers).send({}).expect(201);
    await sign(agent, authorization.id, { consent: false }).expect(400);
    await sign(agent, authorization.id, { signature: undefined, signatureMethod: undefined }).expect(400);
    await sign(agent, authorization.id).expect(201);
    await sign(agent, authorization.id).expect(409);
    // The disclosure is acknowledged without a signature image.
    await agent.post(`/api/driver/consents/${disclosure.id}/view`).set(headers).send({}).expect(201);
    await sign(agent, disclosure.id, { signature: undefined, signatureMethod: undefined }).expect(201);
    // A new version must be signed again; the earlier signature stays on record.
    const newer = await publish(agents.manager, 'BACKGROUND_AUTHORIZATION', 201, 'Fictional authorization');
    expect((await sign(agent, authorization.id).expect(409)).body.message).toMatch(/newer version/);
    const again = (await agent.get('/api/driver/application').set(headers).expect(200)).body;
    expect(again.consents.items[1]).toMatchObject({ id: newer.id, version: 2, current: false, signed: { documentId: authorization.id, version: 1 } });
    expect((await submit(agent, again.version).expect(400)).body.missing).toEqual(['consent:BACKGROUND_AUTHORIZATION']);
    await agent.post(`/api/driver/consents/${newer.id}/view`).set(headers).send({}).expect(201);
    await sign(agent, newer.id, { signatureMethod: 'TYPED' }).expect(201);
    await submit(agent, again.version).expect(201);
    // A submitted application can't be signed any more, nor a view recorded (it would later read as opened before signing),
    // but its signed copy can still be downloaded.
    await sign(agent, newer.id).expect(409);
    await agent.post(`/api/driver/consents/${newer.id}/view`).set(headers).send({}).expect(409);
    await agent.get(`/api/driver/consents/${newer.id}/signed`).set(headers).expect(200).expect('content-type', 'application/pdf');
    // Every Safety role sees what was signed and opens the signed copy; nobody else.
    const record = await driver(id, agents.staff);
    expect(record.consents).toMatchObject({ missing: [], authorizationSigned: true });
    expect(record.consents.signatures.map((row: { kind: string; version: number; typedName: string }) => [row.kind, row.version, row.typedName]))
      .toEqual([['BACKGROUND_AUTHORIZATION', 2, 'Jordan Wheeler'], ['BACKGROUND_AUTHORIZATION', 1, 'Jordan Wheeler'], ['BACKGROUND_DISCLOSURE', 1, 'Jordan Wheeler']]);
    const copy = await agents.staff.get(`/api/safety/drivers/${id}/consents/${newer.id}/signed`).set(headers).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    const text = await pdfText(copy.body as Buffer);
    expect(text).toContain('Electronic Signature Certificate');
    expect(text).toContain('Signature adopted from the typed name');
    // The driver's internal record ID is never printed as an application reference.
    expect(text).not.toContain(id);
    expect(text).not.toContain('Application reference');
    await agents.dispatch.get(`/api/safety/drivers/${id}/consents/${newer.id}/signed`).set(headers).expect(403);
    // Each signed form is also saved once into the driver's own folder.
    // A copy that can't be built (here its blank form is missing) waits before its next try and never holds back the others.
    const archive = app.get(DriverSignedCopies).archive, saved = (name: string) => existsSync(join(storage, 'drivers', id, 'signed', `${name}.pdf`));
    const blank = join(storage, 'company-documents', 'driver-consents', 'background-authorization', `${authorization.id}.pdf`);
    renameSync(blank, `${blank}.away`);
    const start = Date.now();
    expect(await archive.run(start)).toBeGreaterThanOrEqual(2);
    expect(['background-authorization-v1', 'background-authorization-v2', 'background-disclosure-v1'].map(saved)).toEqual([false, true, true]);
    renameSync(`${blank}.away`, blank);
    expect(await archive.run(start + RETRY_FIRST_MS - 1000)).toBe(0);
    expect(saved('background-authorization-v1')).toBe(false);
    expect(await archive.run(start + RETRY_FIRST_MS + 1000)).toBe(1);
    expect(saved('background-authorization-v1')).toBe(true);
    expect(await archive.run()).toBe(0);
    const [stored] = await db.query(`SELECT consent, statement, "documentSha256", "ipAddress" FROM driver_consent_signatures WHERE "documentId" = $1`, [newer.id]);
    expect(stored.statement).toBe('I have read the entire Fictional authorization (version 2) and I agree to it. I intend my typed name and my signature (drawn, or adopted from my typed name) to be my legally binding electronic signature.');
    expect(stored.consent).toMatch(/sign these forms electronically/);
    expect(stored.documentSha256).toBe(newer.sha256);
    await expect(db.query(`UPDATE driver_consent_signatures SET "typedName" = 'Someone' WHERE "documentId" = $1`, [newer.id])).rejects.toThrow(/append-only/);
    // A driver who signed can't be deleted while the signature evidence exists.
    await expect(db.query('DELETE FROM drivers WHERE id = $1', [id])).rejects.toThrow(/foreign key/);
    expect(record.consents.signatures.map((row: { kind: string; hasSignature: boolean }) => [row.kind, row.hasSignature]))
      .toEqual([['BACKGROUND_AUTHORIZATION', true], ['BACKGROUND_AUTHORIZATION', true], ['BACKGROUND_DISCLOSURE', false]]);
    expect((await events(id)).filter(row => row.event === 'CONSENT_SIGNED').map(row => row.metadata))
      .toEqual([{ kind: 'BACKGROUND_AUTHORIZATION' }, { kind: 'BACKGROUND_DISCLOSURE' }, { kind: 'BACKGROUND_AUTHORIZATION' }]);
    // With the authorization signed here, the MVR needs no paper confirmation.
    await agents.lead.post(`/api/safety/drivers/${id}/mvr`).set(headers).send({ version: record.version, file: await mvrPdf(), pulledOn: today() }).expect(201);
    expect((await driver(id)).screening.mvr).toMatchObject({ authorization: 'SIGNED' });
  });

  it('uploads an MVR only with the driver’s signed authorization or a confirmed paper one', async () => {
    const { id, version } = await submitted();
    const refused = (await agents.lead.post(`/api/safety/drivers/${id}/mvr`).set(headers).send({ version, file: await mvrPdf(), pulledOn: today() }).expect(400)).body;
    expect(refused).toMatchObject({ missing: ['authorization'] });
    expect(refused.message).toMatch(/background check authorization/);
    await agents.lead.post(`/api/safety/drivers/${id}/mvr`).set(headers).send({ version, file: await mvrPdf(), pulledOn: today(), paperAuthorization: true }).expect(201);
    expect((await driver(id)).screening.mvr).toMatchObject({ authorization: 'PAPER' });
  });

  it('keeps the address and work history with the draft and sends it only once it covers its years, with gaps explained', async () => {
    const { id, agent } = await applying();
    await scanAll(agent);
    const save = (version: number, body: Record<string, unknown>) => agent.patch('/api/driver/application').set(headers).send({ version, fields: complete, ...body });
    // Entries are checked when saved; coverage only at submission.
    const bad = history();
    bad.jobs[0] = { ...bad.jobs[0], state: 'ZZ' };
    await save(1, { history: bad }).expect(400);
    // The older job ends two months before the current one starts: a gap; and only the current address is given.
    const partial = history();
    partial.jobs[1] = { ...partial.jobs[1], toMonth: addMonths(now(), -33) };
    partial.addresses = [];
    let view = (await save(1, { history: partial, ssn: '123456789' }).expect(200)).body;
    expect(view.history.jobs).toHaveLength(2);
    const gap = `${addMonths(now(), -32)}_${addMonths(now(), -31)}`;
    expect((await agent.post('/api/driver/application/submit').set(headers).send({ version: view.version, fields: complete }).expect(400)).body.missing)
      .toEqual(['history:addresses', `history:gap:${gap}`]);
    // Sending no history keeps the saved one; explaining the gap and adding the address completes it.
    view = (await save(view.version, {}).expect(200)).body;
    expect(view.history.jobs).toHaveLength(2);
    const complete2 = { ...partial, addresses: history().addresses, gaps: [{ from: addMonths(now(), -32), to: addMonths(now(), -31), explanation: 'Looking for work.' }] };
    await agent.post('/api/driver/application/submit').set(headers).send({ version: view.version, fields: complete, history: complete2 }).expect(201);
    const record = await driver(id);
    expect(record.application.history.gaps).toEqual([{ from: addMonths(now(), -32), to: addMonths(now(), -31), explanation: 'Looking for work.' }]);
    expect(JSON.stringify(await events(id))).not.toContain('Prairie');
  });

  it('turns the DOT-regulated jobs of the last 3 years into previous employers at approval', async () => {
    const one = await awaiting();
    await decide(agents.manager, one.id, { version: one.version, decision: 'APPROVE' }).expect(201);
    const record = await driver(one.id);
    // Prairie Haulers (driving, DOT testing) is asked; the warehouse job isn't regulated.
    expect(record.clearance.employers.map((row: Record<string, unknown>) => [row.name, row.source, row.location, row.phone, row.toMonth, row.requestedOn]))
      .toEqual([['Prairie Haulers', 'APPLICATION', 'Tulsa, OK', '555-010-9100', now(), null]]);
    expect((await events(one.id)).filter(row => row.event === 'EMPLOYER_RECORDED').map(row => row.metadata)).toEqual([{ action: 'from-application', count: 1 }]);
  });

  it('clears an approved driver: the owner records results only, the previous employers, then Cleared', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    const item = (agent: Agent, key: string, body: Record<string, unknown>) => agent.post(`/api/safety/drivers/${id}/clearance/${key}`).set(headers).send(body);
    const employer = (agent: Agent, path: string, body: Record<string, unknown>) => agent.post(`/api/safety/drivers/${id}/employers${path}`).set(headers).send(body);
    expect((await item(agents.manager, 'DRUG_TEST', { version: 1, result: 'NEGATIVE', doneOn: today() }).expect(409)).body.message).toMatch(/once the Safety manager approves/);
    await db.query(`UPDATE drivers SET status = 'APPROVED' WHERE id = $1`, [id]);
    // Before an owner is assigned only the Safety manager and administrators work on it; never the Safety lead.
    await item(agents.staff, 'DRUG_TEST', { version: 1, result: 'NEGATIVE', doneOn: today() }).expect(403);
    await item(agents.lead, 'DRUG_TEST', { version: 1, result: 'NEGATIVE', doneOn: today() }).expect(403);
    let { version } = (await agents.lead.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 1, ownerId: users.staff.id }).expect(201)).body;
    await item(agents.staff2, 'DRUG_TEST', { version, result: 'NEGATIVE', doneOn: today() }).expect(403);
    await item(agents.staff, 'UNKNOWN', { version, status: 'COMPLETED' }).expect(404);
    // The drug test takes a result, which sets the status: not negative blocks it, only negative completes it.
    await item(agents.staff, 'DRUG_TEST', { version, status: 'COMPLETED', doneOn: today() }).expect(400);
    await item(agents.staff, 'DRUG_TEST', { version, result: 'NEGATIVE' }).expect(400);
    await item(agents.staff, 'DRUG_TEST', { version, result: 'NEGATIVE', doneOn: addDays(today(), 3) }).expect(400);
    await item(agents.staff, 'DRUG_TEST', { version, result: 'NO_VIOLATIONS', doneOn: today() }).expect(400);
    ({ version } = (await item(agents.staff, 'DRUG_TEST', { version, result: 'NOT_NEGATIVE', doneOn: today() }).expect(201)).body);
    expect((await driver(id)).clearance.items).toEqual([expect.objectContaining({ key: 'DRUG_TEST', status: 'BLOCKED', result: 'NOT_NEGATIVE', doneOn: today(), updatedBy: 'Fictional staff' })]);
    ({ version } = (await item(agents.staff, 'DRUG_TEST', { version, result: 'NEGATIVE', doneOn: today() }).expect(201)).body);
    // The others take a status: blocked needs a note, completed a date, and only some items can be not needed.
    await item(agents.staff, 'MEDICAL_REGISTRY', { version, status: 'BLOCKED' }).expect(400);
    await item(agents.staff, 'MEDICAL_REGISTRY', { version, status: 'COMPLETED' }).expect(400);
    expect((await item(agents.staff, 'MEDICAL_REGISTRY', { version, status: 'NOT_NEEDED', note: 'x' }).expect(400)).body.message).toBe('This item is needed for every driver.');
    await item(agents.staff, 'MEDICAL_REGISTRY', { version, result: 'NEGATIVE', doneOn: today() }).expect(400);
    ({ version } = (await item(agents.staff, 'MEDICAL_REGISTRY', { version, status: 'COMPLETED', doneOn: today() }).expect(201)).body);
    ({ version } = (await item(agents.manager, 'CLEARINGHOUSE', { version, result: 'NO_VIOLATIONS', doneOn: daysAgo(1) }).expect(201)).body);
    // Cleared only once every item is done.
    expect((await agents.staff.post(`/api/safety/drivers/${id}/clear`).set(headers).send({ version }).expect(400)).body.missing).toEqual(['clearance:PREVIOUS_EMPLOYERS', 'clearance:ROAD_TEST']);
    // Previous employers: removable until asked; an answer comes after the request.
    await employer(agents.staff, '', { version, name: 'Prairie Haulers', fromMonth: '2024-01', toMonth: '2023-12' }).expect(400);
    await employer(agents.staff, '', { version, name: 'Prairie Haulers', fromMonth: '2024-01', toMonth: '2999-01' }).expect(400);
    ({ version } = (await employer(agents.staff, '', { version, name: 'Prairie Haulers', fromMonth: '2024-01', toMonth: '2025-06', requestedOn: daysAgo(2) }).expect(201)).body);
    ({ version } = (await employer(agents.staff, '', { version, name: 'Lone Star Freight', fromMonth: '2022-03', toMonth: '2023-12' }).expect(201)).body);
    let [prairie] = (await driver(id)).clearance.employers as { id: string; name: string; requestedOn: string | null; answeredOn: string | null }[];
    const loneStar = ((await driver(id)).clearance.employers as { id: string; name: string }[])[1];
    expect([prairie.name, loneStar.name]).toEqual(['Prairie Haulers', 'Lone Star Freight']);
    expect((await employer(agents.staff, `/${prairie.id}/remove`, { version }).expect(409)).body.message).toMatch(/already asked/);
    ({ version } = (await employer(agents.staff, `/${loneStar.id}/remove`, { version }).expect(201)).body);
    await employer(agents.staff, `/${prairie.id}`, { version, answeredOn: daysAgo(3) }).expect(400);
    ({ version } = (await employer(agents.staff, `/${prairie.id}`, { version, answeredOn: today() }).expect(201)).body);
    [prairie] = (await driver(id)).clearance.employers;
    expect(prairie).toMatchObject({ requestedOn: daysAgo(2), answeredOn: today() });
    ({ version } = (await item(agents.staff, 'PREVIOUS_EMPLOYERS', { version, status: 'COMPLETED', doneOn: today() }).expect(201)).body);
    await item(agents.staff, 'ROAD_TEST', { version, status: 'NOT_NEEDED' }).expect(400);
    ({ version } = (await item(agents.staff, 'ROAD_TEST', { version, status: 'NOT_NEEDED', note: 'CDL accepted in place of the road test.' }).expect(201)).body);
    expect((await driver(id)).clearance.missing).toEqual([]);
    // The Safety lead can't clear; the owner can.
    await agents.lead.post(`/api/safety/drivers/${id}/clear`).set(headers).send({ version }).expect(403);
    await agents.staff.post(`/api/safety/drivers/${id}/clear`).set(headers).send({ version: version - 1 }).expect(409);
    ({ version } = (await agents.staff.post(`/api/safety/drivers/${id}/clear`).set(headers).send({ version }).expect(201)).body);
    const done = await driver(id);
    expect(done).toMatchObject({ status: 'CLEARED', clearedBy: { id: users.staff.id }, version });
    expect(done.clearedAt).toBeTruthy();
    // The checklist is read-only once cleared.
    expect((await item(agents.staff, 'ROAD_TEST', { version, status: 'IN_PROGRESS' }).expect(409)).body.message).toBe('This driver is already cleared.');
    const recorded = (await events(id)).filter(row => ['CLEARANCE_RECORDED', 'EMPLOYER_RECORDED', 'CLEARED'].includes(row.event));
    expect(recorded.map(row => [row.event, row.metadata])).toEqual([
      ['CLEARANCE_RECORDED', { item: 'DRUG_TEST', status: 'BLOCKED' }], ['CLEARANCE_RECORDED', { item: 'DRUG_TEST', status: 'COMPLETED' }],
      ['CLEARANCE_RECORDED', { item: 'MEDICAL_REGISTRY', status: 'COMPLETED' }], ['CLEARANCE_RECORDED', { item: 'CLEARINGHOUSE', status: 'COMPLETED' }],
      ['EMPLOYER_RECORDED', { action: 'added', requested: true }], ['EMPLOYER_RECORDED', { action: 'added', requested: false }], ['EMPLOYER_RECORDED', { action: 'removed' }],
      ['EMPLOYER_RECORDED', { action: 'answered' }], ['CLEARANCE_RECORDED', { item: 'PREVIOUS_EMPLOYERS', status: 'COMPLETED' }],
      ['CLEARANCE_RECORDED', { item: 'ROAD_TEST', status: 'NOT_NEEDED' }], ['CLEARED', {}]]);
    expect(JSON.stringify(recorded)).not.toMatch(/Prairie|CDL accepted|NEGATIVE/);
  });

  it('holds Cleared to current results, every employer followed up and an active owner', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    const item = (agent: Agent, key: string, body: Record<string, unknown>) => agent.post(`/api/safety/drivers/${id}/clearance/${key}`).set(headers).send(body);
    const employer = (path: string, body: Record<string, unknown>) => agents.staff.post(`/api/safety/drivers/${id}/employers${path}`).set(headers).send(body);
    const missing = async () => (await driver(id)).clearance.missing as string[];
    await db.query(`UPDATE drivers SET status = 'APPROVED' WHERE id = $1`, [id]);
    let { version } = (await agents.lead.post(`/api/safety/drivers/${id}/owner`).set(headers).send({ version: 1, ownerId: users.staff.id }).expect(201)).body;
    // Saving an item with nothing recorded and nothing chosen changes nothing.
    expect((await item(agents.staff, 'MEDICAL_REGISTRY', { version, status: null }).expect(201)).body.version).toBe(version);
    expect((await events(id)).filter(row => row.event === 'CLEARANCE_RECORDED')).toEqual([]);

    // Completed needs employers, every one followed up; not needed needs none listed.
    expect((await item(agents.staff, 'PREVIOUS_EMPLOYERS', { version, status: 'COMPLETED', doneOn: today() }).expect(400)).body.message).toMatch(/Add the employers/);
    ({ version } = (await employer('', { version, name: 'Prairie Haulers', fromMonth: '2024-01', toMonth: '2025-06', requestedOn: daysAgo(2) }).expect(201)).body);
    expect((await item(agents.staff, 'PREVIOUS_EMPLOYERS', { version, status: 'NOT_NEEDED', note: 'No DOT employer.' }).expect(400)).body.message).toMatch(/while employers are listed/);
    expect((await item(agents.staff, 'PREVIOUS_EMPLOYERS', { version, status: 'COMPLETED', doneOn: today() }).expect(400)).body.message).toMatch(/good-faith effort/);
    const [prairie] = (await driver(id)).clearance.employers as { id: string }[];
    // A recorded request stays, so an asked employer can't be made removable.
    expect((await employer(`/${prairie.id}`, { version, requestedOn: null, answeredOn: null }).expect(400)).body.message).toMatch(/request is kept/);
    await employer(`/${prairie.id}/remove`, { version }).expect(409);
    // A good-faith effort needs what was done, and can't come before the request.
    await employer(`/${prairie.id}`, { version, goodFaithOn: today() }).expect(400);
    await employer(`/${prairie.id}`, { version, goodFaithNote: 'Two calls.' }).expect(400);
    await employer(`/${prairie.id}`, { version, goodFaithOn: daysAgo(3), goodFaithNote: 'Two calls.' }).expect(400);
    ({ version } = (await employer(`/${prairie.id}`, { version, goodFaithOn: today(), goodFaithNote: 'Two calls and a letter.' }).expect(201)).body);
    expect((await driver(id)).clearance.employers[0]).toMatchObject({ goodFaithOn: today(), goodFaithNote: 'Two calls and a letter.' });
    ({ version } = (await item(agents.staff, 'PREVIOUS_EMPLOYERS', { version, status: 'COMPLETED', doneOn: today() }).expect(201)).body);
    expect((await events(id)).filter(row => row.event === 'EMPLOYER_RECORDED').at(-1)?.metadata).toEqual({ action: 'good-faith' });
    expect(JSON.stringify(await events(id))).not.toMatch(/Two calls/);

    // An employer added after the item was completed holds Cleared back until it is settled.
    for (const [key, body] of [['DRUG_TEST', { result: 'NEGATIVE', doneOn: today() }], ['CLEARINGHOUSE', { result: 'NO_VIOLATIONS', doneOn: today() }], ['MEDICAL_REGISTRY', { status: 'COMPLETED', doneOn: today() }], ['ROAD_TEST', { status: 'COMPLETED', doneOn: today() }]] as const)
      ({ version } = (await item(agents.staff, key, { version, ...body }).expect(201)).body);
    expect(await missing()).toEqual([]);
    ({ version } = (await employer('', { version, name: 'Lone Star Freight', fromMonth: '2022-03', toMonth: '2023-12' }).expect(201)).body);
    expect(await missing()).toEqual(['employers']);
    expect((await agents.staff.post(`/api/safety/drivers/${id}/clear`).set(headers).send({ version }).expect(400)).body.missing).toEqual(['employers']);
    const loneStar = ((await driver(id)).clearance.employers as { id: string; name: string }[]).find(row => row.name === 'Lone Star Freight')!;
    ({ version } = (await employer(`/${loneStar.id}/remove`, { version }).expect(201)).body);

    // A request from over a year ago can still get its answer: only a changed date is checked.
    await db.query(`UPDATE driver_previous_employers SET "requestedOn" = $2, "goodFaithOn" = NULL, "goodFaithNote" = NULL WHERE id = $1`, [prairie.id, daysAgo(400)]);
    await employer(`/${prairie.id}`, { version, requestedOn: daysAgo(380), answeredOn: today() }).expect(400);
    ({ version } = (await employer(`/${prairie.id}`, { version, requestedOn: daysAgo(400), answeredOn: today() }).expect(201)).body);

    // A result that has aged past a year since it was recorded has to be done again.
    await db.query(`UPDATE driver_clearance_items SET "doneOn" = $2 WHERE "driverId" = $1 AND key = 'DRUG_TEST'`, [id, daysAgo(366)]);
    expect((await agents.staff.post(`/api/safety/drivers/${id}/clear`).set(headers).send({ version }).expect(400)).body.missing).toEqual(['expired:DRUG_TEST']);
    ({ version } = (await item(agents.staff, 'DRUG_TEST', { version, result: 'NEGATIVE', doneOn: today() }).expect(201)).body);

    // An owner who is no longer active, or no longer safety staff, doesn't count.
    for (const change of [`status = 'INACTIVE'`, `role = 'SAFETY_LEAD'`]) {
      await db.query(`UPDATE users SET ${change} WHERE id = $1`, [users.staff.id]);
      expect((await agents.manager.post(`/api/safety/drivers/${id}/clear`).set(headers).send({ version }).expect(400)).body.missing).toEqual(['owner']);
      await db.query(`UPDATE users SET status = 'ACTIVE', role = 'SAFETY_STAFF' WHERE id = $1`, [users.staff.id]);
    }
    await agents.manager.post(`/api/safety/drivers/${id}/clear`).set(headers).send({ version }).expect(201);
  });

  it('lets the Safety manager send an approved driver with a failed clearance result to a pre-adverse notice', async () => {
    const { id } = (await add(agents.lead).expect(201)).body;
    await db.query(`UPDATE drivers SET status = 'APPROVED' WHERE id = $1`, [id]);
    await db.query(`INSERT INTO driver_reviews ("driverId", action, "previousStatus", "newStatus", "actorId") VALUES ($1, 'APPROVED', 'AWAITING_DECISION', 'APPROVED', $2)`, [id, users.manager.id]);
    expect(await app.get(ScreeningService).waitingCount(users.manager)).toBe(0);
    let { version } = (await agents.manager.post(`/api/safety/drivers/${id}/clearance/DRUG_TEST`).set(headers).send({ version: 1, result: 'NOT_NEGATIVE', doneOn: today() }).expect(201)).body;
    // It shows as waiting on the deciders, and withdrawing stays refused.
    expect(await app.get(ScreeningService).waitingCount(users.manager)).toBe(1);
    await agents.manager.post(`/api/safety/drivers/${id}/withdraw`).set(headers).send({ version, reason: 'Failed test' }).expect(409);
    const notice = { decision: 'PRE_ADVERSE', note: 'Clearance result.', noticeSent: true };
    await decide(agents.lead, id, { version, ...notice, noticeSentOn: today() }).expect(403);
    // Never dated before the approval, so the waiting period can't be cut short.
    expect((await decide(agents.manager, id, { version, ...notice, noticeSentOn: daysAgo(5) }).expect(400)).body.message).toMatch(/before the driver was approved/);
    ({ version } = (await decide(agents.manager, id, { version, ...notice, noticeSentOn: today() }).expect(201)).body);
    const record = await driver(id);
    expect(record).toMatchObject({ status: 'PRE_ADVERSE', closedAt: null, screening: { finalRejectionFrom: earliestFinalRejection(today()) } });
    expect(record.screening.reviews[0]).toMatchObject({ action: 'PRE_ADVERSE', previousStatus: 'APPROVED' });
    // The waiting period holds, and clearance stops while the notice is out.
    await decide(agents.manager, id, { version, decision: 'REJECT', note: 'x', noticeSent: true, noticeSentOn: today() }).expect(409);
    await agents.manager.post(`/api/safety/drivers/${id}/clearance/DRUG_TEST`).set(headers).send({ version, result: 'NEGATIVE', doneOn: today() }).expect(409);
    // A cleared driver can't get one here.
    await db.query(`UPDATE drivers SET status = 'CLEARED', "clearedAt" = now() WHERE id = $1`, [id]);
    await decide(agents.manager, id, { version, ...notice, noticeSentOn: today() }).expect(409);
  });


  /** A submitted driver whose scans were checked (the medical card already expired), then cleared and owned by safety staff. */
  async function clearedWithExpiredCard() {
    const one = await submitted(), day = usDay('latest');
    for (const document of one.documents) await agents.lead.post(`/api/safety/drivers/${one.id}/documents/${document.id}/verify`).set(headers)
      .send({ version: 1, ...(document.kind === 'LICENSE' ? { expiresOn: addDays(day, 400) } : document.kind === 'MEDICAL_CARD' ? { expiresOn: addDays(day, -3) } : {}) }).expect(201);
    await db.query(`UPDATE drivers SET status = 'CLEARED', "clearedAt" = now() - interval '30 days', version = version + 1 WHERE id = $1`, [one.id]);
    await db.query(`INSERT INTO driver_owners ("driverId", "ownerId", "startedAt") VALUES ($1, $2, now() - interval '30 days')`, [one.id, users.staff.id]);
    const medical = one.documents.find(row => row.kind === 'MEDICAL_CARD')!.id;
    return { ...one, medical, version: (await driver(one.id)).version as number };
  }
  const medicalFile = (id: string, documentId: string) => join(storage, 'drivers', id, 'documents', 'medical-card', `${documentId}.pdf`);
  /** Opens a renewal link in a new browser: true in `code` when the emailed code went out. */
  async function openRenewal(url: string, email = 'jordan.wheeler@example.test') {
    const agent = request.agent(app.getHttpServer()), token = url.split('#').pop() as string;
    const before = sent.length;
    const { challengeId } = (await agent.post('/api/driver/begin').set(headers).send({ token, email }).expect(201)).body;
    await settle();
    return { agent, challengeId: challengeId as string, code: sent.length > before ? sent.at(-1)!.code : null };
  }

  it('renews an expired medical card Safety has in hand: saved checked, the hold lifts and the earlier scan is kept', async () => {
    const { id, medical, version } = await clearedWithExpiredCard(), day = usDay('latest');
    expect((await driver(id, agents.manager)).hold).toMatchObject({ onHold: true, documents: true });
    expect((await driver(id)).renewals.find((row: { kind: string }) => row.kind === 'MEDICAL_CARD')).toMatchObject({ checked: { id: medical, expiresOn: addDays(day, -3), current: true }, link: null, scan: null });
    const renew = (agent: Agent, body: Record<string, unknown>) => agent.post(`/api/safety/drivers/${id}/documents/renew`).set(headers)
      .send({ version, kind: 'MEDICAL_CARD', pages: [page()], expiresOn: addDays(day, 700), confirmed: true, ...body });
    // Who: Safety leads, the manager, administrators and the owner; not another safety staff member or Dispatch.
    await renew(agents.staff2, {}).expect(403);
    await renew(agents.dispatch, {}).expect(403);
    // What: one PDF or photos, a date still to come, the confirmation, and never the work authorization.
    await renew(agents.staff, { expiresOn: addDays(day, -1) }).expect(400);
    await renew(agents.staff, { confirmed: false }).expect(400);
    await renew(agents.staff, { kind: 'WORK_AUTHORIZATION' }).expect(400);
    await renew(agents.staff, { file: await mvrPdf() }).expect(400);
    await renew(agents.staff, { pages: undefined, file: Buffer.from('not a pdf').toString('base64') }).expect(400);
    await renew(agents.staff, { version: version - 1 }).expect(409);
    await renew(agents.staff, { pages: undefined, file: await mvrPdf() }).expect(201);
    const record = await driver(id, agents.manager);
    expect(record.hold).toMatchObject({ onHold: false, documents: false });
    expect(record.version).toBe(version + 1);
    const renewed = record.documents.find((row: { kind: string }) => row.kind === 'MEDICAL_CARD');
    expect(renewed).toMatchObject({ uploadedBySafety: true, verifiedBy: 'Fictional staff', expiresOn: addDays(day, 700), pageCount: 1, unreadableAt: null });
    expect(existsSync(medicalFile(id, medical))).toBe(true);
    expect(existsSync(medicalFile(id, renewed.id))).toBe(true);
    expect((await events(id)).filter(row => row.event === 'DOCUMENT_RENEWED').map(row => row.metadata)).toEqual([{ kind: 'MEDICAL_CARD', pages: 1 }]);
    expect(JSON.stringify(await events(id))).not.toContain(addDays(day, 700));
    // The expiring list now counts the renewed card, which is far away.
    expect((await agents.staff.get('/api/safety/expiring').set(headers).expect(200)).body.items.filter((row: { driverId: string }) => row.driverId === id)).toEqual([]);
  });

  it('sends a renewal link: the driver scans only that document, which lifts nothing until a person checks it', async () => {
    const { id, version, medical } = await clearedWithExpiredCard(), day = usDay('latest');
    const link = (agent: Agent, body: Record<string, unknown>) => agent.post(`/api/safety/drivers/${id}/renewals`).set(headers).send({ kind: 'MEDICAL_CARD', ...body });
    await link(agents.staff2, { version }).expect(403);
    const first = (await link(agents.staff, { version }).expect(201)).body;
    expect(first.url).toMatch(/\/driver#[a-f0-9]{64}$/);
    // A new link for the same document stops the first one.
    const second = (await link(agents.lead, { version: first.version }).expect(201)).body;
    expect((await openRenewal(first.url)).code).toBeNull();
    const renewal = await openRenewal(second.url);
    expect((await renewal.agent.post('/api/driver/verify').set(headers).send({ challengeId: renewal.challengeId, code: renewal.code }).expect(201)).body).toEqual({ verified: true, purpose: 'RENEWAL' });
    // The session opens only the renewal: never the application or its scans.
    await renewal.agent.get('/api/driver/application').set(headers).expect(401);
    await renewal.agent.post('/api/driver/documents/medical-card').set(headers).send({ pages: [page()] }).expect(401);
    expect((await renewal.agent.get('/api/driver/renewal').set(headers).expect(200)).body).toMatchObject({ kind: 'MEDICAL_CARD', email: 'jordan.wheeler@example.test', sentAt: null, document: null });
    const scanned = (await renewal.agent.post('/api/driver/renewal').set(headers).send({ pages: [page(), page()] }).expect(201)).body;
    expect(scanned).toMatchObject({ kind: 'MEDICAL_CARD', sentAt: expect.any(String), document: { pageCount: 2 } });
    await renewal.agent.post('/api/driver/renewal').set(headers).send({ pages: [page()] }).expect(409);
    // Sending it moved the driver's version on, so a page Safety opened before can't replace the scan without seeing it.
    await agents.staff.post(`/api/safety/drivers/${id}/documents/renew`).set(headers)
      .send({ version: second.version, kind: 'MEDICAL_CARD', pages: [page()], expiresOn: addDays(day, 700), confirmed: true }).expect(409);
    // Waiting for its check: the expired card still holds them, and both the list and the profile say so.
    let record = await driver(id, agents.manager);
    const waiting = record.renewals.find((row: { kind: string }) => row.kind === 'MEDICAL_CARD');
    expect(waiting).toMatchObject({ checked: { id: medical, current: false }, link: null, scan: { pageCount: 2, unreadable: false, version: 1 } });
    expect(record.hold).toMatchObject({ onHold: true, documents: true });
    const listed = (await agents.staff.get('/api/safety/expiring').set(headers).expect(200)).body.items.find((row: { driverId: string; kind: string }) => row.driverId === id && row.kind === 'MEDICAL_CARD');
    expect(listed).toMatchObject({ documentId: medical, expired: true, version: record.version, email: 'jordan.wheeler@example.test', renewal: { link: null, scan: { id: waiting.scan.id } } });
    // Not readable: never checked, and the next scan replaces it (its file goes; the checked card's stays).
    await agents.staff2.post(`/api/safety/drivers/${id}/documents/${waiting.scan.id}/unreadable`).set(headers).send({ version: 1 }).expect(403);
    await agents.staff.post(`/api/safety/drivers/${id}/documents/${waiting.scan.id}/unreadable`).set(headers).send({ version: 1 }).expect(201);
    await agents.lead.post(`/api/safety/drivers/${id}/documents/${waiting.scan.id}/verify`).set(headers).send({ version: 2, expiresOn: addDays(day, 700) }).expect(409);
    const third = (await link(agents.staff, { version: record.version }).expect(201)).body;
    // The new link is out while the unreadable scan is still the current one: the profile reports both.
    expect((await driver(id)).renewals.find((row: { kind: string }) => row.kind === 'MEDICAL_CARD')).toMatchObject({ link: { expired: false }, scan: { id: waiting.scan.id, unreadable: true } });
    const again = await openRenewal(third.url);
    await again.agent.post('/api/driver/verify').set(headers).send({ challengeId: again.challengeId, code: again.code }).expect(201);
    await again.agent.post('/api/driver/renewal').set(headers).send({ pages: [page()] }).expect(201);
    expect(existsSync(medicalFile(id, waiting.scan.id))).toBe(false);
    expect(existsSync(medicalFile(id, medical))).toBe(true);
    // Checked: the date a person read lifts the hold.
    record = await driver(id, agents.manager);
    const next = record.renewals.find((row: { kind: string }) => row.kind === 'MEDICAL_CARD').scan;
    // A date that has passed means they photographed the old card: refused, so the scan can still be marked not readable.
    expect((await agents.staff.post(`/api/safety/drivers/${id}/documents/${next.id}/verify`).set(headers).send({ version: 1, expiresOn: addDays(day, -1) }).expect(400)).body.message).toMatch(/not readable/);
    await agents.staff.post(`/api/safety/drivers/${id}/documents/${next.id}/verify`).set(headers).send({ version: 1, expiresOn: addDays(day, 700) }).expect(201);
    record = await driver(id, agents.manager);
    expect(record.hold).toMatchObject({ onHold: false, documents: false });
    expect(record.renewals.find((row: { kind: string }) => row.kind === 'MEDICAL_CARD')).toMatchObject({ checked: { id: next.id, current: true }, scan: null });
    expect((await events(id)).filter(row => ['RENEWAL_LINK_SENT', 'RENEWAL_OPENED', 'DOCUMENT_UNREADABLE'].includes(row.event) || (row.event === 'DOCUMENT_UPLOADED' && row.metadata.renewal)).map(row => [row.event, row.metadata]))
      .toEqual([['RENEWAL_LINK_SENT', { kind: 'MEDICAL_CARD', resent: false }], ['RENEWAL_LINK_SENT', { kind: 'MEDICAL_CARD', resent: true }], ['RENEWAL_OPENED', { kind: 'MEDICAL_CARD' }],
        ['DOCUMENT_UPLOADED', { kind: 'MEDICAL_CARD', pages: 2, renewal: true }], ['DOCUMENT_UNREADABLE', { kind: 'MEDICAL_CARD' }], ['RENEWAL_LINK_SENT', { kind: 'MEDICAL_CARD', resent: false }],
        ['RENEWAL_OPENED', { kind: 'MEDICAL_CARD' }], ['DOCUMENT_UPLOADED', { kind: 'MEDICAL_CARD', pages: 1, renewal: true }]]);
  });

  it('keeps a scan the driver sent with their application when a renewal replaces it, and never treats it as a renewal scan', async () => {
    const one = await submitted(), day = usDay('latest');
    // The medical card from the application is never checked (as for a DL driver, for whom it is optional).
    for (const document of one.documents.filter(row => row.kind !== 'MEDICAL_CARD')) await agents.lead.post(`/api/safety/drivers/${one.id}/documents/${document.id}/verify`).set(headers)
      .send({ version: 1, ...(document.kind === 'LICENSE' ? { expiresOn: addDays(day, 400) } : {}) }).expect(201);
    await db.query(`UPDATE drivers SET status = 'CLEARED', "clearedAt" = now(), version = version + 1 WHERE id = $1`, [one.id]);
    await db.query(`INSERT INTO driver_owners ("driverId", "ownerId", "startedAt") VALUES ($1, $2, now())`, [one.id, users.staff.id]);
    const medical = one.documents.find(row => row.kind === 'MEDICAL_CARD')!.id, { version } = await driver(one.id);
    // Not a scan waiting for a renewal check, so it can't be marked not readable.
    expect((await driver(one.id)).renewals.find((row: { kind: string }) => row.kind === 'MEDICAL_CARD')).toMatchObject({ checked: null, scan: null });
    await agents.staff.post(`/api/safety/drivers/${one.id}/documents/${medical}/unreadable`).set(headers).send({ version: 1 }).expect(409);
    await agents.staff.post(`/api/safety/drivers/${one.id}/documents/renew`).set(headers)
      .send({ version, kind: 'MEDICAL_CARD', pages: [page()], expiresOn: addDays(day, 700), confirmed: true }).expect(201);
    // Its file stays, also through the sweep of leftover scans.
    expect(existsSync(medicalFile(one.id, medical))).toBe(true);
    await app.get(ScanSweeper).sweep(Date.now() + LEFTOVER_SCAN_AGE_MS + 60_000);
    expect(existsSync(medicalFile(one.id, medical))).toBe(true);
  });

  it('stops renewal links when they are cancelled, the email changes or the driver leaves, and offers them only once approved', async () => {
    const { id, version } = await clearedWithExpiredCard();
    const link = (body: Record<string, unknown>) => agents.lead.post(`/api/safety/drivers/${id}/renewals`).set(headers).send({ kind: 'LICENSE', ...body });
    const cancel = (body: Record<string, unknown>) => agents.lead.post(`/api/safety/drivers/${id}/renewals/cancel`).set(headers).send({ kind: 'LICENSE', ...body });
    // Cancelled: no code goes out any more, and cancelling again is refused.
    const cancelled = (await link({ version }).expect(201)).body;
    const { version: afterCancel } = (await cancel({ version: cancelled.version }).expect(201)).body;
    expect((await openRenewal(cancelled.url)).code).toBeNull();
    await cancel({ version: afterCancel }).expect(409);
    // The bound email changes: the link stops.
    const bound = (await link({ version: afterCancel }).expect(201)).body;
    const { version: changed } = (await agents.lead.patch(`/api/safety/drivers/${id}`).set(headers).send({ version: bound.version, email: 'jordan.w@example.test' }).expect(200)).body;
    expect((await openRenewal(bound.url)).code).toBeNull();
    // Leaving revokes it too.
    const last = (await link({ version: changed }).expect(201)).body;
    await agents.manager.post(`/api/safety/drivers/${id}/left`).set(headers).send({ version: last.version, leftOn: usDay('latest'), reason: 'Fictional move' }).expect(201);
    expect((await openRenewal(last.url, 'jordan.w@example.test')).code).toBeNull();
    // Before approval there is nothing to renew.
    const fresh = (await add(agents.lead, { ...lead, phone: '555 010 4444', email: 'riley.lead@example.test' }).expect(201)).body;
    expect((await agents.lead.post(`/api/safety/drivers/${fresh.id}/renewals`).set(headers).send({ version: 1, kind: 'LICENSE' }).expect(409)).body.message).toMatch(/approved/);
  });
  it('lets Safety correct a work authorization’s type, and lists only work permits as expiring', async () => {
    const { id, documents } = await submitted(), day = usDay('latest');
    const work = documents.find(row => row.kind === 'WORK_AUTHORIZATION')!.id;
    const verify = (body: Record<string, unknown>) => agents.lead.post(`/api/safety/drivers/${id}/documents/${work}/verify`).set(headers).send(body);
    const expiring = async () => (await agents.lead.get('/api/safety/expiring').set(headers).expect(200)).body.items.filter((row: { driverId: string }) => row.driverId === id);
    // A type only on a work authorization, and only one of the four.
    await agents.lead.post(`/api/safety/drivers/${id}/documents/${documents.find(row => row.kind === 'LICENSE')!.id}/verify`).set(headers).send({ version: 1, subtype: 'WORK_PERMIT', expiresOn: addDays(day, 400) }).expect(400);
    await verify({ version: 1, subtype: 'VISA' }).expect(400);
    // A work permit needs its date, even from a page that sends none.
    await verify({ version: 1, subtype: 'WORK_PERMIT' }).expect(400);
    // The driver scanned a green card; Safety sees a work permit and records its date: listed 60 days before.
    await verify({ version: 1, subtype: 'WORK_PERMIT', expiresOn: addDays(day, 20) }).expect(201);
    expect((await driver(id)).documents.find((row: { kind: string }) => row.kind === 'WORK_AUTHORIZATION')).toMatchObject({ subtype: 'WORK_PERMIT', expiresOn: addDays(day, 20) });
    expect((await expiring()).map((row: { kind: string }) => row.kind)).toEqual(['WORK_AUTHORIZATION']);
    // Back to a green card: no date is kept, and it drops out of the list.
    await verify({ version: 2, subtype: 'GREEN_CARD', expiresOn: addDays(day, 20) }).expect(201);
    expect((await driver(id)).documents.find((row: { kind: string }) => row.kind === 'WORK_AUTHORIZATION')).toMatchObject({ subtype: 'GREEN_CARD', expiresOn: null });
    expect(await expiring()).toEqual([]);
    // An older page sends no type: the recorded one stays.
    await verify({ version: 3, expiresOn: '' }).expect(201);
    expect((await driver(id)).documents.find((row: { kind: string }) => row.kind === 'WORK_AUTHORIZATION')).toMatchObject({ subtype: 'GREEN_CARD' });
    expect((await events(id)).filter(row => row.event === 'DOCUMENT_VERIFIED').map(row => row.metadata))
      .toEqual([{ kind: 'WORK_AUTHORIZATION', again: false, typeChanged: true }, { kind: 'WORK_AUTHORIZATION', again: true, typeChanged: true }, { kind: 'WORK_AUTHORIZATION', again: true }]);
  });

  it('publishes notice letters and fills one in for a driver, with their MVR behind the pre-adverse notice', async () => {
    const one = await awaiting();
    const letterPdf = async (pages = 2) => { const pdf = await PDFDocument.create(); for (let n = 0; n < pages; n++) pdf.addPage([612, 792]); return Buffer.from(await pdf.save()).toString('base64'); };
    const fields = [{ page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.02, kind: 'NAME', signer: 'SIGNER' }, { page: 1, x: 0.1, y: 0.14, width: 0.5, height: 0.02, kind: 'ADDRESS', signer: 'SIGNER' },
      { page: 1, x: 0.6, y: 0.05, width: 0.25, height: 0.02, kind: 'DATE', signer: 'SIGNER' }];
    const letter = (agent: Agent, kind: string) => agent.get(`/api/safety/drivers/${one.id}/letters/${kind}`).set(headers).buffer(true).parse((res, done) => { const parts: Buffer[] = []; res.on('data', (part: Buffer) => parts.push(part)); res.on('end', () => done(null, Buffer.concat(parts))); });
    // Nothing published yet.
    await letter(agents.manager, 'pre-adverse').expect(404);
    // Only the Safety manager and administrators publish; a letter takes name, address and date, never a signature.
    await agents.lead.post('/api/safety/letters').set(headers).send({ kind: 'PRE_ADVERSE', title: 'Fictional pre-adverse notice', file: await letterPdf(), fields }).expect(403);
    await agents.manager.post('/api/safety/letters').set(headers).send({ kind: 'PRE_ADVERSE', title: 'Fictional pre-adverse notice', file: await letterPdf(),
      fields: [{ ...fields[0], kind: 'SIGNATURE' }] }).expect(400);
    // A letter takes the name, address and date only: no day, month or year on their own.
    await agents.manager.post('/api/safety/letters').set(headers).send({ kind: 'PRE_ADVERSE', title: 'Fictional pre-adverse notice', file: await letterPdf(), fields: [{ ...fields[2], kind: 'DAY' }] }).expect(400);
    // An address belongs on a letter only, never on a consent form.
    await agents.manager.post('/api/safety/consents').set(headers).send({ kind: 'CLEARINGHOUSE_CONSENT', title: 'Fictional consent', file: await letterPdf(1), fields: [fields[1]] }).expect(400);
    const published = (await agents.manager.post('/api/safety/letters').set(headers).send({ kind: 'PRE_ADVERSE', title: 'Fictional pre-adverse notice', file: await letterPdf(), fields }).expect(201)).body;
    expect(published).toMatchObject({ kind: 'PRE_ADVERSE', version: 1, pageCount: 2 });
    const list = (await agents.staff.get('/api/safety/consents').set(headers).expect(200)).body;
    expect(list.letters.map((row: { kind: string; versions: unknown[] }) => [row.kind, row.versions.length])).toEqual([['PRE_ADVERSE', 1], ['FINAL', 0]]);
    expect((await driver(one.id, agents.manager)).noticeLetters).toEqual({ PRE_ADVERSE: { version: 1, pageCount: 2 }, FINAL: null });
    // Only those who can download a letter are told which ones exist.
    expect((await driver(one.id, agents.lead)).noticeLetters).toBeUndefined();
    // The driver's letter: only the deciders, only while a decision is open, the letter's two pages plus the MVR's one.
    await letter(agents.lead, 'pre-adverse').expect(403);
    await letter(agents.manager, 'final').expect(409);
    await letter(agents.manager, 'other').expect(404);
    // A crafted name is just an unknown letter.
    await letter(agents.manager, 'constructor').expect(404);
    const filled = await letter(agents.manager, 'pre-adverse').expect(200).expect('content-type', 'application/pdf').expect('cache-control', 'no-store, private');
    expect((await PDFDocument.load(filled.body)).getPageCount()).toBe(3);
    expect((await events(one.id)).filter(row => row.event === 'NOTICE_LETTER_DOWNLOADED').map(row => row.metadata)).toEqual([{ kind: 'PRE_ADVERSE', withMvr: true }]);
    // Once the pre-adverse notice is recorded, the final letter follows (when published).
    await decide(agents.manager, one.id, { version: one.version, decision: 'PRE_ADVERSE', note: 'Fictional reason', noticeSent: true, noticeSentOn: today() }).expect(201);
    await letter(agents.manager, 'final').expect(404);
    await agents.manager.post('/api/safety/letters').set(headers).send({ kind: 'FINAL', title: 'Fictional final notice', file: await letterPdf(1), fields: [fields[0]] }).expect(201);
    expect((await PDFDocument.load((await letter(agents.manager, 'final').expect(200)).body)).getPageCount()).toBe(1);
    // Published versions never change.
    await expect(db.query(`UPDATE driver_notice_letters SET title = 'x' WHERE id = $1`, [published.id])).rejects.toThrow();
  });

  it('keeps the migrations from discarding driver documents, applications, driver records or Safety accounts', async () => {
    const { id, agent } = await applying();
    await scan(agent, 'license').expect(201);
    await publish(agents.manager, 'CLEARINGHOUSE_CONSENT', 201);
    await db.undoLastMigration(); // NewAuthenticator, with none here
    // A notice letter downloaded (or one published) keeps NoticeLetters.
    await db.query(`INSERT INTO driver_events ("driverId", event, metadata) VALUES ($1, 'NOTICE_LETTER_DOWNLOADED', '{}')`, [id]);
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard notice letters');
    await db.query(`DELETE FROM driver_events WHERE event = 'NOTICE_LETTER_DOWNLOADED'`);
    await db.undoLastMigration(); // NoticeLetters, with none here
    // A renewal Safety uploaded (or a renewal link, or a scan marked as not readable) keeps DocumentRenewals.
    await db.query(`UPDATE driver_documents SET "uploadedBy" = $1 WHERE "driverId" = $2`, [users.staff.id, id]);
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard document renewals');
    await db.query(`UPDATE driver_documents SET "uploadedBy" = NULL WHERE "driverId" = $1`, [id]);
    await db.undoLastMigration(); // DocumentRenewals, with none here
    await db.query(`INSERT INTO driver_events ("driverId", event, metadata) VALUES ($1, 'TRUCK_SAVED', '{}')`, [id]);
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard owner-operator trucks or documents');
    await db.query(`DELETE FROM driver_events WHERE event = 'TRUCK_SAVED'`);
    await db.undoLastMigration(); // OwnerOperatorTrucks, with none here
    await db.query(`INSERT INTO driver_events ("driverId", event, metadata) VALUES ($1, 'INCIDENT_RECORDED', '{}')`, [id]);
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard recorded driver incidents');
    await db.query(`DELETE FROM driver_events WHERE event = 'INCIDENT_RECORDED'`);
    await db.undoLastMigration(); // DriverIncidents, with none here
    await db.query(`INSERT INTO driver_events ("driverId", event, metadata) VALUES ($1, 'TEST_RECORDED', '{}')`, [id]);
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard recorded drug and alcohol test results');
    await db.query(`DELETE FROM driver_events WHERE event = 'TEST_RECORDED'`);
    await db.undoLastMigration(); // DriverTesting, with none here
    await db.query(`INSERT INTO driver_events ("driverId", event, metadata) VALUES ($1, 'ANNUAL_REVIEW_RECORDED', '{}')`, [id]);
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard yearly driver reviews');
    await db.query(`DELETE FROM driver_events WHERE event = 'ANNUAL_REVIEW_RECORDED'`);
    await db.undoLastMigration(); // DriverAnnualReviews, with none here
    await db.query(`UPDATE drivers SET status = 'LEFT', "closedAt" = now() WHERE id = $1`, [id]);
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard drivers marked as left');
    await db.query(`UPDATE drivers SET status = 'LEAD', "closedAt" = NULL WHERE id = $1`, [id]);
    await db.undoLastMigration(); // DriverLeft, with none here
    await db.undoLastMigration(); // TeamLeadSignIns, with none here

    await db.undoLastMigration(); // WholeTeamSupports, with none here
    await db.undoLastMigration(); // AccountDetails, with none here
    await db.undoLastMigration(); // SupportTypes, with none here
    await db.undoLastMigration(); // DocumentAmericanName, with none here
    await db.undoLastMigration(); // MissingDetails, with none here
    await db.undoLastMigration(); // DocumentFields, with none placed here
    await db.undoLastMigration(); // ExistingDispatchers, with none added here
    await db.undoLastMigration(); // DispatcherOffboarding, with nothing offboarded here
    await db.query("UPDATE driver_applications SET history = '{}'");
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard driver address and work history');
    await db.query('UPDATE driver_applications SET history = NULL');
    await db.undoLastMigration(); // DriverHistory, with no history left
    await db.query(`UPDATE drivers SET status = 'APPROVED' WHERE id = $1`, [id]);
    await db.query(`INSERT INTO driver_clearance_items ("driverId", key, status, "updatedAt") VALUES ($1, 'ROAD_TEST', 'IN_PROGRESS', now())`, [id]);
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard driver clearance or dispatch assignments');
    await db.query('TRUNCATE driver_clearance_items');
    await db.query(`UPDATE drivers SET status = 'APPLYING' WHERE id = $1`, [id]);
    await db.undoLastMigration(); // DriverClearance, with nothing recorded yet
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard files stored in the per-person folders');
    // Mark this test's files as flat-layout to step past StorageFolders and reach the older refusals.
    await db.query(`TRUNCATE signed_copies; UPDATE driver_documents SET "storageLayout" = 1; UPDATE driver_reports SET "storageLayout" = 1;
      ALTER TABLE driver_consent_documents DISABLE TRIGGER driver_consent_documents_append_only; UPDATE driver_consent_documents SET "storageLayout" = 1;
      ALTER TABLE driver_consent_documents ENABLE TRIGGER driver_consent_documents_append_only`);
    await db.undoLastMigration(); // StorageFolders
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard driver consent forms or signatures');
    await db.query('TRUNCATE driver_consent_documents CASCADE');
    await db.undoLastMigration(); // DriverConsents, with nothing recorded yet
    await db.query(`INSERT INTO driver_screening_checks ("driverId", key, result, "checkedAt") VALUES ($1, 'IDENTITY', 'PASS', now())`, [id]);
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard driver screening, reports or decisions');
    await db.query('TRUNCATE driver_screening_checks');
    await db.undoLastMigration(); // DriverScreening, with nothing recorded yet
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
    expect((await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name).toBe('NewAuthenticator1793120000000');
  });
});
