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
import { AuthModule } from '../src/modules/auth/auth.module';
import { installSessions } from '../src/modules/auth/session';
import { hashPassword } from '../src/modules/auth/password';
import { User, Role, UserStatus } from '../src/modules/users/user.entity';
import { DispatchModule } from '../src/modules/dispatch/dispatch.module';
import { DocumentsModule } from '../src/modules/documents/documents.module';
import { SafetyModule } from '../src/modules/safety/safety.module';
import { SearchModule } from '../src/modules/search/search.module';
import { ViewModule } from '../src/modules/view/view.module';
import { completeMfa, enrolForTest } from './mfa-helpers';
type Agent = ReturnType<typeof request.agent>;
type Key = 'admin' | 'manager' | 'director' | 'viewer';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Section 39: view-only access across Dispatch and Safety. Fictional people only.
integration('View-only access (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>, riley: string, driverId: string;
  const password = randomBytes(24).toString('base64url');
  const users = {} as Record<Key, User>, agents = {} as Record<Key, Agent>, secrets = {} as Record<Key, string>;
  const ROLES: Record<Key, Role> = { admin: Role.SYSTEM_ADMIN, manager: Role.DISPATCHER_MANAGER, director: Role.SAFETY_MANAGER, viewer: Role.VIEWER };
  // Signs in again, enrolled in two-step verification first unless told not to (someone it isn't required for yet).
  const signIn = async (key: Key, enrol = true) => {
    if (enrol) secrets[key] ??= await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users[key].id);
    agents[key] = request.agent(app.getHttpServer());
    const login = await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    if (login.body.mfa) expect((await completeMfa(agents[key], headers, db, users[key].id, secrets[key])).status).toBe(200);
  };
  const grant = (key: Key, viewAccess: unknown, status = 200) => agents.admin.patch(`/api/users/${users[key].id}`).set(headers).send({ viewAccess }).expect(status);

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, DispatchModule, DocumentsModule, SafetyModule, SearchModule, ViewModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, staff_mfa, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, drivers CASCADE');
    await db.query(`INSERT INTO load_board_accounts (provider, name, "nameKey", placeholder) VALUES ('DAT', 'DAT account not recorded', 'dat account not recorded', true), ('TRUCKSTOP', 'Truckstop account not recorded', 'truckstop account not recorded', true) ON CONFLICT DO NOTHING`);
    const passwordHash = await hashPassword(password);
    for (const key of Object.keys(ROLES) as Key[]) {
      users[key] = await db.getRepository(User).save({ firstName: key[0].toUpperCase() + key.slice(1), lastName: 'Example', email: `view.${key}@example.test`, role: ROLES[key], status: UserStatus.ACTIVE, passwordHash });
      delete secrets[key];
    }
    await signIn('admin'); await signIn('manager', false); await signIn('director', false);
    await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Northwind Freight','northwind freight')`);
    await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Dispatcher','dispatcher')`);
    const added = await agents.manager.post('/api/dispatch/existing/add').set(headers).send({ rows: [{ row: 2, firstName: 'Riley', lastName: 'Santos', mc: 'Northwind Freight', jobTitle: 'Dispatcher', startedOn: '2024-03-04',
      personalEmail: 'riley.home@example.test', personalPhone: '+1 214 555 0177', companyEmail: 'riley.santos@example.test', ringCentralNumber: '+1 469 555 0142', telegram: '@rileysantos' }] }).expect(201);
    riley = added.body.members[0].id;
    [{ id: driverId }] = await db.query(`INSERT INTO drivers ("firstName","lastName",phone,"phoneKey","driverType","licenseType",status,"clearedAt") VALUES ('Dana','Okafor','+1 469 555 0190','4695550190','COMPANY','CDL_A','APPROVED',NULL) RETURNING id`);
    await db.query(`INSERT INTO driver_clearance_items ("driverId", key, status, result, "doneOn", "updatedAt") VALUES ($1, 'DRUG_TEST', 'COMPLETED', 'NEGATIVE', current_date, now())`, [driverId]);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, drivers, users CASCADE'); await db.destroy(); } });

  it('gives and takes view access only as the rules allow, recording each change', async () => {
    await grant('director', [{ department: 'SAFETY', withFiles: false }], 400);
    await agents.admin.patch(`/api/users/${users.admin.id}`).set(headers).send({ viewAccess: [{ department: 'DISPATCH', withFiles: false }] }).expect(400);
    await agents.admin.post('/api/users').set(headers).send({ firstName: 'Pat', lastName: 'Grant', email: 'pat.grant@example.test', role: 'VIEWER' }).expect(400);
    const created = await agents.admin.post('/api/users').set(headers).send({ firstName: 'Pat', lastName: 'Grant', email: 'pat.grant@example.test', role: 'VIEWER', viewAccess: [{ department: 'SAFETY', withFiles: true }] }).expect(201);
    expect(created.body.viewAccess).toEqual([{ department: 'SAFETY', withFiles: true }]);
    await grant('director', [{ department: 'DISPATCH', withFiles: false }]);
    const list = (await agents.admin.get('/api/users').set(headers).expect(200)).body as { id: string; viewAccess: unknown }[];
    expect(list.find(user => user.id === users.director.id)!.viewAccess).toEqual([{ department: 'DISPATCH', withFiles: false }]);
    // An edit that says nothing about it keeps it.
    await agents.admin.patch(`/api/users/${users.director.id}`).set(headers).send({ firstName: 'Sloane' }).expect(200);
    expect((await db.query(`SELECT department FROM staff_view_access WHERE "userId" = $1`, [users.director.id])).map((row: { department: string }) => row.department)).toEqual(['DISPATCH']);
    await grant('director', []);
    const events = await db.query(`SELECT metadata FROM staff_security_events WHERE "userId" = $1 AND type = 'USER_VIEW_ACCESS_CHANGED' ORDER BY "createdAt"`, [users.director.id]);
    expect(events.map((row: { metadata: unknown }) => row.metadata)).toEqual([{ added: ['DISPATCH'], removed: [], files: [], withFiles: [] }, { added: [], removed: ['DISPATCH'], files: [], withFiles: [] }]);
  });

  it('requires two-step verification, adds the department to the menu and admits only the read routes', async () => {
    await grant('director', [{ department: 'DISPATCH', withFiles: false }]);
    // The session from before the grant had no second step: it ends once the grant makes one required.
    await agents.director.get('/api/auth/me').set(headers).expect(401);
    await signIn('director');
    const me = (await agents.director.get('/api/auth/me').set(headers).expect(200)).body;
    expect(me.navigation.filter((item: { section: string }) => item.section === 'Dispatch · view only').map((item: { href: string }) => item.href))
      .toEqual(['/view/dispatch/teams', '/view/dispatch/dispatchers', '/view/dispatch/drivers']);
    expect(me.landingPage).toBe('/safety/drivers');
    // Dispatch's own pages and every change stay closed.
    await agents.director.get('/api/dispatch/members').set(headers).expect(403);
    await agents.director.patch(`/api/dispatch/members/${riley}`).set(headers).send({ version: 1 }).expect(403);
    await agents.director.get('/api/access/viewdispatchers').set(headers).expect(200);
    await agents.director.get('/api/access/dispatchers').set(headers).expect(403);
    // A department not given stays closed to the view routes too.
    await agents.manager.get('/api/view/dispatch/members').set(headers).expect(403);
    await agents.director.get(`/api/view/safety/drivers/${driverId}`).set(headers).expect(403);
  });

  it('shows dispatchers with work details only: never personal contacts, by search or on the page', async () => {
    await grant('director', [{ department: 'DISPATCH', withFiles: false }]);
    await signIn('director');
    const list = await agents.director.get('/api/view/dispatch/members?status=ALL').set(headers).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ firstName: 'Riley', companyEmail: 'riley.santos@example.test', ringCentralNumber: '+1 469 555 0142', telegram: 'rileysantos' });
    for (const text of [JSON.stringify(list.body), JSON.stringify((await agents.director.get(`/api/view/dispatch/members/${riley}`).set(headers).expect(200)).body)]) {
      expect(text).not.toContain('riley.home@example.test');
      expect(text).not.toContain('555 0177');
      expect(text).not.toContain('personalEmail');
    }
    // A personal email or phone finds nobody; a work email does.
    expect((await agents.director.get('/api/view/dispatch/members?status=ALL&search=riley.home').set(headers).expect(200)).body.total).toBe(0);
    expect((await agents.director.get('/api/view/dispatch/members?status=ALL&search=2145550177').set(headers).expect(200)).body.total).toBe(0);
    expect((await agents.director.get('/api/view/dispatch/members?status=ALL&search=riley.santos@').set(headers).expect(200)).body.total).toBe(1);
    const found = (await agents.director.get('/api/search?q=riley.home').set(headers).expect(200)).body.groups;
    expect(found.find((group: { key: string }) => group.key === 'dispatchers')).toBeUndefined();
    const named = (await agents.director.get('/api/search?q=Riley').set(headers).expect(200)).body.groups;
    expect(named.find((group: { key: string }) => group.key === 'dispatchers').items[0].href).toBe(`/view/dispatch/dispatchers/${riley}`);
    // History without reasons, notes or who opened files.
    const profile = (await agents.director.get(`/api/view/dispatch/members/${riley}`).set(headers).expect(200)).body;
    expect(profile.timeline.entries.every((entry: { body: unknown; category: string }) => entry.body === null && !['VIEWS', 'IT'].includes(entry.category))).toBe(true);
    expect(profile.withFiles).toBe(false);
    expect(profile.files).toBeNull();
  });

  it('opens photos and documents only when they were given, and records each one', async () => {
    await grant('director', [{ department: 'DISPATCH', withFiles: false }]);
    await signIn('director');
    const scan = `/api/view/dispatch/members/${riley}/paper-scans/${randomUUID()}/file`, signed = `/api/view/dispatch/members/${riley}/documents/${randomUUID()}/signed`;
    await agents.director.get(scan).set(headers).expect(403);
    await agents.director.get(signed).set(headers).expect(403);
    await grant('director', [{ department: 'DISPATCH', withFiles: true }]);
    // Given: the route checks the file itself (none exists here).
    await agents.director.get(scan).set(headers).expect(404);
    await agents.director.get(signed).set(headers).expect(404);
    expect((await agents.director.get(`/api/view/dispatch/members/${riley}`).set(headers).expect(200)).body.files).toMatchObject({ idPhoto: false, signed: [], scans: [] });
  });

  it('shows Safety to a View only account without results, notes or files', async () => {
    await grant('viewer', [{ department: 'SAFETY', withFiles: false }]);
    await signIn('viewer');
    const me = (await agents.viewer.get('/api/auth/me').set(headers).expect(200)).body;
    expect(me.landingPage).toBe('/view/safety/drivers');
    expect(me.navigation.map((item: { key: string }) => item.key)).toEqual(['viewdrivers', 'viewunits', 'viewexpiring', 'security']);
    const driver = (await agents.viewer.get(`/api/view/safety/drivers/${driverId}`).set(headers).expect(200)).body;
    expect(driver.clearance.find((item: { key: string }) => item.key === 'DRUG_TEST')).toEqual({ key: 'DRUG_TEST', status: 'RESTRICTED' });
    expect(JSON.stringify(driver)).not.toContain('NEGATIVE');
    expect(driver).not.toHaveProperty('application');
    expect(driver).not.toHaveProperty('notes');
    expect(driver.consents).toBeNull();
    // A failed test never puts a driver on hold for a viewer, in the list or on the page: a hold with no visible reason would
    // itself say that a test failed (49 CFR 40.321).
    await db.query(`UPDATE drivers SET status = 'CLEARED', "clearedAt" = now() WHERE id = $1`, [driverId]);
    await db.query(`INSERT INTO driver_tests ("driverId", kind, reason, "testedOn", result) VALUES ($1, 'DRUG', 'RANDOM', current_date, 'NOT_NEGATIVE')`, [driverId]);
    const held = (await agents.viewer.get(`/api/view/safety/drivers/${driverId}`).set(headers).expect(200)).body;
    expect(held.hold).toEqual({ onHold: false, review: false, documents: false });
    const listed = (await agents.viewer.get('/api/view/safety/drivers').set(headers).expect(200)).body.items;
    expect(listed.find((item: { id: string }) => item.id === driverId).onHold).toBe(false);
    await db.query(`DELETE FROM driver_tests WHERE "driverId" = $1`, [driverId]);
    await db.query(`UPDATE drivers SET status = 'APPROVED', "clearedAt" = NULL WHERE id = $1`, [driverId]);
    // View only accounts get no workspace alerts, so there is no Telegram connection to make.
    await agents.viewer.get('/api/staff/telegram').set(headers).expect(403);
    await agents.viewer.get(`/api/view/safety/drivers/${driverId}/documents/${randomUUID()}/file`).set(headers).expect(403);
    await agents.viewer.get('/api/view/safety/units').set(headers).expect(200);
    await agents.viewer.get('/api/view/safety/expiring').set(headers).expect(200);
    await agents.viewer.get('/api/view/dispatch/members').set(headers).expect(403);
    await agents.viewer.get('/api/safety/drivers').set(headers).expect(403);
    await agents.viewer.post('/api/safety/drivers').set(headers).send({ firstName: 'New', lastName: 'Lead', phone: '+1 469 555 0100', driverType: 'COMPANY' }).expect(403);
    // Taking it away works at once, without a new sign-in.
    await grant('viewer', [{ department: 'DISPATCH', withFiles: false }]);
    await agents.viewer.get(`/api/view/safety/drivers/${driverId}`).set(headers).expect(403);
    await agents.viewer.get('/api/view/dispatch/members').set(headers).expect(200);
  });
});
