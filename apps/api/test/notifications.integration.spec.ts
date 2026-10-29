import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { EmailService } from '../src/modules/email/email.service';
import { Notifications1792800000000 } from '../src/database/migrations/1792800000000-Notifications';
type Agent = ReturnType<typeof request.agent>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('New-hire and staff notifications (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>, telegram: Server;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url'), botToken = `12345678:${randomBytes(24).toString('base64url')}`;
  // A local fake of the Telegram Bot API and a captured mailbox; background work is awaited by settle().
  const updates: { update_id: number; message: unknown }[] = [], messages: { chat_id: string; text: string }[] = [];
  const codes: { code: string }[] = [], emails: { to: string; subject: string; text: string }[] = [], tasks: Promise<void>[] = [];
  const email = { enabled: true, staffCodesEnabled: false, onModuleInit: () => undefined, onApplicationShutdown: async () => undefined,
    sendVerificationCode: async (_to: string, code: string) => { codes.push({ code }); return true; },
    sendStatusUpdate: async (to: string, content: { subject: string; text: string }) => { emails.push({ to, subject: content.subject, text: content.text }); return true as const; },
    runInBackground: (task: () => Promise<void>) => { tasks.push(task()); } };
  const settle = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  const users: Record<'manager' | 'it' | 'it2', User> = {} as never;
  const agents: Record<'manager' | 'it' | 'it2', Agent> = {} as never;
  const answers = { firstName: 'Fictional', lastName: 'Applicant', personalPhoneNumber: '+1 202 555 0123', preferredAmericanFirstName: 'Alex', preferredAmericanLastName: 'Demo',
    telegram: 'fictional_demo', mcName: 'Independent', teamLead: 'Independent', jobTitle: 'Dispatcher' };
  let nextUpdate = 500;
  const send = (text: string, chat: number) => updates.push({ update_id: nextUpdate++, message: { text, chat: { id: chat, type: 'private' }, from: { username: `fictional_${chat}` } } });
  async function connectStaff(key: 'manager' | 'it' | 'it2', chat: number) {
    const link = await agents[key].post('/api/staff/telegram/connect').set(headers).send({}).expect(200);
    send(`/start ${link.body.url.split('start=')[1]}`, chat);
    return (await agents[key].post('/api/staff/telegram/check').set(headers).send({}).expect(200)).body;
  }
  async function submitted(address: string) {
    const inv = await agents.manager.post('/api/onboarding/invitations').set(headers).send({}).expect(201);
    const applicant = request.agent(app.getHttpServer()), token = inv.body.url.split('#').pop() as string;
    const begin = await applicant.post('/api/applicant/begin').set(headers).send({ token, email: address }).expect(201); await settle();
    const verified = await applicant.post('/api/applicant/verify').set(headers).send({ challengeId: begin.body.challengeId, code: codes.at(-1)!.code }).expect(201);
    await applicant.patch('/api/applicant/draft').set(headers).send({ version: 0, ...answers }).expect(200);
    await applicant.post('/api/applicant/submit').set(headers).send({ version: 1, ...answers, accurate: true }).expect(201);
    await settle();
    return { applicant, id: verified.body.applicationId as string };
  }
  const approve = (id: string) => agents.manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers)
    .send({ version: 2, decisionType: 'APPROVE', confirmed: true, employmentConfirmed: true, employment: { mcName: 'Independent', teamLead: 'Independent', jobTitle: 'Dispatcher' } }).expect(201);
  const deliveries = () => db.query(`SELECT kind, "recipientId", "applicationId", channel, status, "failureCode" FROM notification_deliveries ORDER BY "createdAt", kind, channel`);

  beforeAll(async () => {
    telegram = createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      const input = JSON.parse(body || '{}'), method = req.url?.split('/').pop(), reply = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url?.split('/')[1] !== `bot${botToken}`) return reply(401, { ok: false });
      if (method === 'getUpdates') return reply(200, { ok: true, result: updates.filter(update => update.update_id >= input.offset).slice(0, input.limit ?? 100) });
      if (method === 'sendMessage') { messages.push({ chat_id: String(input.chat_id), text: input.text }); return reply(200, { ok: true, result: {} }); }
      reply(404, { ok: false }); }); });
    await new Promise<void>(resolve => telegram.listen(0, '127.0.0.1', resolve));
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600,
      EMAIL_DELIVERY: 'smtp', SMTP_HOST: 'localhost', SMTP_PORT: '1025', EMAIL_FROM: 'Operations <sender@example.test>',
      TELEGRAM_DELIVERY: 'bot', TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_BOT_USERNAME: 'ugem_updates_bot', TELEGRAM_API_BASE: `http://127.0.0.1:${(telegram.address() as AddressInfo).port}` });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, OnboardingModule, ItModule] })
      .overrideProvider(EmailService).useValue(email).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    await settle(); emails.length = 0; messages.length = 0;
    await db.query('TRUNCATE users, staff_sessions, applicant_sessions, login_attempts, invitations CASCADE');
    await db.query(`UPDATE telegram_poll_state SET "updateOffset" = $1`, [nextUpdate]);
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST], ['it2', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: 'Staff', email: `notify.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
    }
  });
  afterAll(async () => { await settle(); if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations CASCADE'); await db.destroy(); } telegram?.close(); });

  it('connects a staff member’s Telegram once per link and alerts the assigned manager when an application is submitted', async () => {
    expect((await agents.manager.get('/api/staff/telegram').set(headers).expect(200)).body).toEqual({ available: true, connected: false, username: null, alerts: ['REVIEW_WAITING'] });
    expect((await agents.it.get('/api/staff/telegram').set(headers).expect(200)).body.alerts).toEqual(['IT_SETUP_WAITING']);
    expect(await connectStaff('manager', 901)).toMatchObject({ connected: true, username: 'fictional_901' });
    expect(messages).toEqual([{ chat_id: '901', text: expect.stringMatching(/^Connected\. You will get UGEM Workspace alerts here/) }]);
    messages.length = 0;
    const { id } = await submitted('notify.hire@example.test');
    expect(messages).toEqual([{ chat_id: '901', text: `An application is waiting for your review in UGEM Workspace.\n\nhttp://localhost:3000/onboarding/applications/${id}` }]);
    // No names, phone numbers or other answers in the alert.
    expect(messages[0].text).not.toMatch(/Fictional|Alex|555|Independent/);
    expect(await deliveries()).toEqual([{ kind: 'REVIEW_WAITING', recipientId: users.manager.id, applicationId: null, channel: 'TELEGRAM', status: 'SENT', failureCode: null }]);
  });

  it('alerts each connected IT specialist on approval and records the others as not connected', async () => {
    await connectStaff('it', 902);
    const { id } = await submitted('notify.approved@example.test');
    messages.length = 0;
    await approve(id); await settle();
    const [request] = await db.query(`SELECT id FROM it_onboarding_requests WHERE "applicationId" = $1`, [id]);
    expect(messages).toEqual([{ chat_id: '902', text: `A new IT setup checklist is waiting in UGEM Workspace.\n\nhttp://localhost:3000/it/tasks/${request.id}` }]);
    const rows = (await deliveries()).filter((row: { kind: string }) => row.kind === 'IT_SETUP_WAITING');
    expect(rows).toEqual(expect.arrayContaining([
      { kind: 'IT_SETUP_WAITING', recipientId: users.it.id, applicationId: null, channel: 'TELEGRAM', status: 'SENT', failureCode: null },
      { kind: 'IT_SETUP_WAITING', recipientId: users.it2.id, applicationId: null, channel: 'TELEGRAM', status: 'SKIPPED', failureCode: 'NOT_CONNECTED' }]));
    // The manager never connected Telegram, so the review alert was skipped, not sent.
    expect((await deliveries()).find((row: { kind: string }) => row.kind === 'REVIEW_WAITING')).toMatchObject({ status: 'SKIPPED', failureCode: 'NOT_CONNECTED' });
  });

  it('tells the new hire their accounts are ready, on their chosen channels, when IT completes setup', async () => {
    const { applicant, id } = await submitted('notify.ready@example.test');
    await applicant.patch('/api/applicant/updates').set(headers).send({ email: true, telegram: true }).expect(200);
    const link = await applicant.post('/api/applicant/updates/telegram').set(headers).send({}).expect(201);
    send(`/start ${link.body.url.split('start=')[1]}`, 903);
    await applicant.post('/api/applicant/updates/telegram/check').set(headers).send({}).expect(201);
    await approve(id); await settle();
    const [request] = await db.query(`SELECT id FROM it_onboarding_requests WHERE "applicationId" = $1`, [id]);
    emails.length = 0; messages.length = 0;
    let data = await agents.it.patch(`/api/it/onboarding/${request.id}/contact`).set(headers)
      .send({ version: 0, workPhoneVerified: false, assignedRingCentralPhoneNumber: '+1 202 555 0190', companyEmail: 'alex.demo@example.test' }).expect(200);
    for (const task of data.body.tasks) {
      data = await agents.it.patch(`/api/it/onboarding/${request.id}/tasks/${task.key}`).set(headers).send({ version: data.body.request.version, status: 'COMPLETED' }).expect(200);
      if (!data.body.request.completedAt) { await settle(); expect(emails).toHaveLength(0); }
    }
    await settle();
    expect(emails).toEqual([{ to: 'notify.ready@example.test', subject: 'Your UGEM work accounts are ready', text: expect.stringContaining('Look for an invitation email from Google') }]);
    expect(messages).toEqual([{ chat_id: '903', text: expect.stringContaining('check your Spam folder') }]);
    // Never the company address, names or phone numbers.
    for (const text of [emails[0].text, messages[0].text]) expect(text).not.toMatch(/alex\.demo|Alex|555|Fictional/);
  });

  it('stops, moves and refuses connections safely, and does not alert someone who left', async () => {
    await connectStaff('manager', 904);
    // Connecting the same chat to another account moves it; /stop removes it.
    await connectStaff('it', 904);
    expect((await agents.manager.get('/api/staff/telegram').set(headers).expect(200)).body.connected).toBe(false);
    send('/stop', 904);
    expect((await agents.it.post('/api/staff/telegram/check').set(headers).send({}).expect(200)).body.connected).toBe(false);
    // Disconnect, and a deactivated manager receives nothing.
    await connectStaff('manager', 905);
    await db.query(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [users.manager.id]);
    messages.length = 0;
    await db.query(`INSERT INTO notification_deliveries (kind, "recipientId", "referenceId", channel, status, "createdAt") VALUES ('REVIEW_WAITING', $1, gen_random_uuid(), 'TELEGRAM', 'PENDING', now() - interval '1 hour')`, [users.manager.id]);
    app.get((await import('../src/modules/updates/notifications.service')).NotificationsService).sweep(); await settle();
    expect(messages).toHaveLength(0);
    expect((await deliveries()).at(-1)).toMatchObject({ status: 'FAILED', failureCode: 'INACTIVE' });
    await agents.it.post('/api/staff/telegram/disconnect').set({ ...headers, 'x-csrf-protection': '' }).send({}).expect(403);
    const runner = db.createQueryRunner();
    try { await expect(new Notifications1792800000000().down(runner)).rejects.toThrow('Cannot discard staff Telegram connections'); } finally { await runner.release(); }
  });
});
