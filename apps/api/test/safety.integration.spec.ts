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
import { SafetyModule } from '../src/modules/safety/safety.module';
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
  const events = async (id: string) => (await db.query(`SELECT event, metadata FROM driver_events WHERE "driverId" = $1 ORDER BY "createdAt"`, [id])) as { event: string; metadata: Record<string, unknown> }[];

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, SafetyModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, staff_mfa, drivers CASCADE');
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
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE drivers CASCADE'); await db.query(`DELETE FROM users WHERE role::text LIKE 'SAFETY_%'`); await db.destroy(); } });

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

  it('keeps the migration from discarding driver records or Safety accounts', async () => {
    await add(agents.lead).expect(201);
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard driver records or Safety accounts');
    await db.query('TRUNCATE drivers CASCADE');
    await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard driver records or Safety accounts');
    expect((await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name).toBe('SafetyDrivers1792860000000');
  });
});
