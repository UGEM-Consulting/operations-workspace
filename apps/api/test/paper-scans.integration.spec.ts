import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../src/config/environment';
import { databaseOptions } from '../src/database/options';
import { configureApp } from '../src/common/configure-app';
import { TrustedDevicesPaperScans1793170000000 } from '../src/database/migrations/1793170000000-TrustedDevicesPaperScans';
import { AuthModule } from '../src/modules/auth/auth.module';
import { installSessions } from '../src/modules/auth/session';
import { hashPassword } from '../src/modules/auth/password';
import { User, Role, UserStatus } from '../src/modules/users/user.entity';
import { OnboardingModule } from '../src/modules/onboarding/onboarding.module';
import { ItModule } from '../src/modules/it/it.module';
import { WorkspaceModule } from '../src/modules/workspace/workspace.module';
import { DispatchModule } from '../src/modules/dispatch/dispatch.module';
import { paperScanKey, StorageService } from '../src/modules/storage/storage.service';
import { ScanSweeper } from '../src/modules/safety/scan-sweeper';
import { jpeg } from './documents.fixtures';
import { issueDemoCode } from '../src/database/demo-verification';

type Agent = ReturnType<typeof request.agent>;
type Key = 'manager' | 'other' | 'it';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
/** A small unencrypted PDF with the given number of pages. */
async function pdf(pages = 2) { const doc = await PDFDocument.create(); for (let i = 0; i < pages; i += 1) doc.addPage([612, 792]); return Buffer.from(await doc.save()).toString('base64'); }

integration('Paper scans for people added by hand (section 38, disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const storage = mkdtempSync(join(tmpdir(), 'paper-scans-')), storageDir = storage;
  const password = randomBytes(24).toString('base64url');
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  const member = async (id: string) => (await agents.manager.get(`/api/dispatch/members/${id}`).set(headers).expect(200)).body;
  const addOne = async (name: string, extra: Record<string, unknown> = { ndaSignedOn: '2024-03-04' }) => {
    const { body } = await agents.manager.post('/api/dispatch/existing/add').set(headers).send({ rows: [{ row: 2, firstName: name, lastName: 'Fictional', mc: 'Northwind Freight', team: 'Red team', jobTitle: 'Dispatcher', startedOn: '2024-03-04', ...extra }] }).expect(201);
    return body.members[0].id as string;
  };
  const upload = (agent: Agent, id: string, body: Record<string, unknown>) => agent.post(`/api/dispatch/members/${id}/paper-scans`).set(headers).send({ kind: 'NDA', confirmed: true, ...body });

  beforeAll(async () => {
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: storage });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, OnboardingModule, ItModule, WorkspaceModule, DispatchModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, mcs, job_titles, dispatch_events, dispatch_members, teams, member_assignments, notification_deliveries, it_removal_requests CASCADE');
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['manager', Role.DISPATCHER_MANAGER], ['other', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `paper.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    }
    const [mc] = await db.query(`INSERT INTO mcs (name,"nameKey") VALUES ('Northwind Freight','northwind freight') RETURNING id`);
    await db.query(`INSERT INTO teams (name,"nameKey","mcId") VALUES ('Red team','red team',$1)`, [mc.id]);
    await db.query(`INSERT INTO job_titles (name,"nameKey") VALUES ('Dispatcher','dispatcher')`);
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, mcs, dispatch_events, dispatch_members, it_removal_requests, users CASCADE'); await db.destroy(); } rmSync(storage, { recursive: true, force: true }); });

  it('adds a scan to a paper copy, shows it on the page and opens it for any dispatch manager, recording each view', async () => {
    const id = await addOne('Riley');
    let profile = await member(id);
    expect(profile.existing.paperScans).toBe(true);
    expect(profile.existing.paper).toEqual([expect.objectContaining({ kind: 'NDA', signedOn: '2024-03-04', scan: null, earlierScans: [] })]);
    const { body } = await upload(agents.manager, id, { version: profile.version, pages: [jpeg().toString('base64'), jpeg({ width: 480, height: 640 }).toString('base64')] }).expect(201);
    profile = await member(id);
    expect(profile.version).toBe(body.version);
    const scan = profile.existing.paper[0].scan;
    expect(scan).toEqual({ id: body.scanId, pageCount: 2, createdAt: expect.any(String), uploadedBy: 'Fictional manager' });
    // Stored under the member, named by IDs only; photos became one PDF.
    expect(existsSync(join(storage, ...paperScanKey({ id: scan.id, kind: 'NDA', memberId: id }).split('/')))).toBe(true);
    const file = await agents.other.get(`/api/dispatch/members/${id}/paper-scans/${scan.id}/file`).set(headers).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['cache-control']).toBe('no-store, private');
    expect((await PDFDocument.load(file.body as Buffer)).getPageCount()).toBe(2);
    const events = await db.query(`SELECT event, "actorId", metadata FROM dispatch_events WHERE "memberId" = $1 AND event LIKE 'PAPER_SCAN_%' ORDER BY "createdAt"`, [id]);
    expect(events).toEqual([{ event: 'PAPER_SCAN_ADDED', actorId: users.manager.id, metadata: { kind: 'NDA', pages: 2, replaced: false, dateChanged: false } },
      { event: 'PAPER_SCAN_VIEWED', actorId: users.other.id, metadata: { kind: 'NDA' } }]);
    // IT never sees it; another member's ID never reaches it.
    await agents.it.get(`/api/dispatch/members/${id}/paper-scans/${scan.id}/file`).set(headers).expect(403);
    await agents.manager.get(`/api/dispatch/members/${randomUUID()}/paper-scans/${scan.id}/file`).set(headers).expect(404);
  });

  it('replaces a scan and keeps the earlier one, and can correct the paper date with it', async () => {
    const id = await addOne('Dana');
    let profile = await member(id);
    const first = (await upload(agents.manager, id, { version: profile.version, file: await pdf(1) }).expect(201)).body;
    const second = (await upload(agents.manager, id, { version: first.version, file: await pdf(3), signedOn: '2024-03-05' }).expect(201)).body;
    profile = await member(id);
    expect(profile.existing.paper[0]).toEqual(expect.objectContaining({ signedOn: '2024-03-05', scan: expect.objectContaining({ id: second.scanId, pageCount: 3 }),
      earlierScans: [expect.objectContaining({ id: first.scanId, pageCount: 1, replacedAt: expect.any(String) })] }));
    expect(existsSync(join(storage, ...paperScanKey({ id: first.scanId, kind: 'NDA', memberId: id }).split('/')))).toBe(true);
    await agents.manager.get(`/api/dispatch/members/${id}/paper-scans/${first.scanId}/file`).set(headers).expect(200);
    expect((await db.query(`SELECT metadata FROM dispatch_events WHERE event = 'PAPER_SCAN_ADDED' ORDER BY "createdAt" DESC LIMIT 1`))[0].metadata).toEqual({ kind: 'NDA', pages: 3, replaced: true, dateChanged: true });
    // The paper record stays while a scan belongs to it.
    await agents.manager.patch(`/api/dispatch/members/${id}/existing`).set(headers).send({ version: second.version, ndaSignedOn: '' }).expect(409);
  });

  it('takes a real-sized scan through the upload body limit', async () => {
    const id = await addOne('Morgan');
    // About 800 KB of PDF is about 1.1 MB once encoded: above the API's 100 kB default body limit.
    const doc = await PDFDocument.create(); doc.addPage([612, 792]); await doc.attach(randomBytes(800_000), 'scan-data.bin', { mimeType: 'application/octet-stream' });
    const file = Buffer.from(await doc.save()).toString('base64');
    expect(file.length).toBeGreaterThan(1_000_000);
    await upload(agents.manager, id, { version: (await member(id)).version, file }).expect(201);
  });

  it('corrects the paper date by Edit recorded details’ rules: a history entry, and never for a document signed in the workspace', async () => {
    const id = await addOne('Avery', { ndaSignedOn: '2024-03-04', personalEmail: 'avery.home@example.test' });
    let { version } = await member(id);
    version = (await upload(agents.manager, id, { version, file: await pdf(), signedOn: '2024-03-06' }).expect(201)).body.version;
    expect((await db.query(`SELECT event, metadata FROM dispatch_events WHERE "memberId" = $1 AND event = 'EXISTING_UPDATED'`, [id]))).toEqual([{ event: 'EXISTING_UPDATED', metadata: { fields: ['NDA'] } }]);
    // Someone who then signed the NDA through their catch-up link: the paper date can't be changed with a scan either.
    const [nda] = await db.query(`INSERT INTO company_documents (kind,version,title,sha256,"pageCount","byteSize","uploadedBy") VALUES ('NDA',1,'NDA',$1,1,100,$2) RETURNING id`, [randomBytes(32).toString('hex'), users.manager.id]);
    const { url } = (await agents.manager.post('/api/dispatch/paperwork/links').set(headers).send({ memberIds: [id] }).expect(201)).body.items[0];
    const applicant = request.agent(app.getHttpServer());
    const begin = await applicant.post('/api/applicant/begin').set(headers).send({ token: url.split('#').pop(), email: 'avery.home@example.test' }).expect(201);
    const verified = await applicant.post('/api/applicant/verify').set(headers).send({ challengeId: begin.body.challengeId, code: await issueDemoCode(db, begin.body.challengeId, 'test') }).expect(201);
    await db.query(`INSERT INTO document_signatures ("applicationId","documentId","signerRole","typedName",consent,statement,"documentSha256") VALUES ($1,$2,'APPLICANT','Avery Fictional','consent','statement',$3)`,
      [verified.body.applicationId, nda.id, randomBytes(32).toString('hex')]);
    version = (await member(id)).version;
    await upload(agents.manager, id, { version, file: await pdf(), signedOn: '2024-03-07' }).expect(409);
    // The same date (or none) still takes a new scan.
    await upload(agents.manager, id, { version, file: await pdf(), signedOn: '2024-03-06' }).expect(201);
  });

  it('lets the cleanup job remove a scan file no record names, and never a recorded one', async () => {
    rmSync(join(storageDir, 'members'), { recursive: true, force: true }); // Files of earlier tests, whose rows were truncated.
    const id = await addOne('Quinn');
    const { scanId } = (await upload(agents.manager, id, { version: (await member(id)).version, file: await pdf() }).expect(201)).body;
    const storage = app.get(StorageService, { strict: false }), orphan = { id: randomUUID(), kind: 'SOP', memberId: id };
    await storage.put(paperScanKey(orphan), Buffer.from(await pdf(), 'base64'), 'application/pdf');
    const sweeper = new ScanSweeper(db, storage);
    expect(await sweeper.sweep()).toBe(0); // Too new: it may be an upload still committing.
    expect(await sweeper.sweep(Date.now() + 2 * 86_400_000)).toBe(1);
    expect(existsSync(join(storageDir, ...paperScanKey(orphan).split('/')))).toBe(false);
    expect(existsSync(join(storageDir, ...paperScanKey({ id: scanId, kind: 'NDA', memberId: id }).split('/')))).toBe(true);
  });

  it('refuses scans without the statement, for a document not on paper, for a stale version, for nothing or both, and leaves no file behind', async () => {
    const id = await addOne('Sage');
    const { version } = await member(id);
    await upload(agents.manager, id, { version, file: await pdf(), confirmed: false }).expect(400);
    await upload(agents.manager, id, { version, kind: 'SOP', file: await pdf() }).expect(400);
    await upload(agents.manager, id, { version, kind: 'CONTACT_LIST', file: await pdf() }).expect(400);
    await upload(agents.manager, id, { version }).expect(400);
    await upload(agents.manager, id, { version, pages: null }).expect(400);
    await upload(agents.manager, id, { version, file: await pdf(), pages: [jpeg().toString('base64')] }).expect(400);
    await upload(agents.manager, id, { version, file: await pdf(), signedOn: '2999-01-01' }).expect(400);
    await upload(agents.manager, id, { version: version + 5, file: await pdf() }).expect(409);
    await upload(agents.it, id, { version, file: await pdf() }).expect(403);
    expect(await db.query(`SELECT 1 FROM member_paper_scans`)).toHaveLength(0);
    // Every refusal comes before a file is stored.
    const folder = join(storage, 'members', id);
    expect(existsSync(folder) ? readdirSync(folder, { recursive: true }).filter(name => String(name).endsWith('.pdf')) : []).toEqual([]);
  });

  it('refuses a scan for someone who came through onboarding or has left, and refuses rolling back while scans exist', async () => {
    // Someone with no record added by hand (as after onboarding) has no paper copies to scan.
    const onboarded = await addOne('Jamie');
    await db.query(`DELETE FROM existing_member_records WHERE "memberId" = $1`, [onboarded]);
    await upload(agents.manager, onboarded, { version: (await member(onboarded)).version, file: await pdf() }).expect(404);
    const id = await addOne('Rowan');
    const { version } = await member(id);
    await upload(agents.manager, id, { version, file: await pdf() }).expect(201);
    await db.query(`UPDATE dispatch_members SET status = 'LEFT', "leftAt" = now() WHERE id = $1`, [id]);
    await upload(agents.manager, id, { version: version + 1, file: await pdf() }).expect(409);
    const runner = db.createQueryRunner();
    try { await expect(new TrustedDevicesPaperScans1793170000000().down(runner)).rejects.toThrow('Refusing to roll back'); } finally { await runner.release(); }
  });
});
