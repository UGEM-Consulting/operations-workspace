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
import { TelegramGroupsService } from '../src/modules/updates/groups.service';
import { alertTargets, queueGroupOnly } from '../src/modules/updates/groups';
import { completeMfa, enrolForTest } from './mfa-helpers';
type Agent = ReturnType<typeof request.agent>;
type Key = 'admin' | 'manager' | 'it';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Telegram groups (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>, telegram: Server;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url'), botToken = `12345678:${randomBytes(24).toString('base64url')}`;
  // A local fake of the Telegram Bot API; a chat listed in blocked answers 403, as when the bot was removed from a group.
  const updates: { update_id: number; message: unknown }[] = [], messages: { chat_id: string; text: string; button: string | null }[] = [], blocked = new Set<string>();
  const tasks: Promise<void>[] = [], codes: { code: string }[] = [];
  const email = { enabled: true, staffCodesEnabled: false, onModuleInit: () => undefined, onApplicationShutdown: async () => undefined,
    sendVerificationCode: async (_to: string, code: string) => { codes.push({ code }); return true; }, sendStatusUpdate: async () => true as const,
    runInBackground: (task: () => Promise<void>) => { tasks.push(task()); } };
  const settle = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  let nextUpdate = 900;
  const say = (text: string, chat: { id: number; type: string; title?: string }) => updates.push({ update_id: nextUpdate++, message: { text, chat, from: { username: 'fictional_admin' } } });
  const itGroup = { id: -1001, type: 'supergroup', title: 'UGEM IT' };
  /** Links a group the way an administrator does: a code, typed in the group, then the page checks. */
  async function link(purpose: string, chat: { id: number; type: string; title?: string }, extra: Record<string, unknown> = {}) {
    const code = (await agents.admin.post('/api/telegram/groups/codes').set(headers).send({ purpose, ...extra }).expect(201)).body;
    say(code.command, chat);
    return (await agents.admin.post(`/api/telegram/groups/codes/${code.id}/check`).set(headers).send({}).expect(200)).body;
  }
  /** Group alerts wait a little so ones arriving together are combined; this ages them and runs the sender. */
  async function sendGroups() {
    await db.query(`UPDATE telegram_group_deliveries SET "createdAt" = now() - interval '2 minutes' WHERE status = 'PENDING'`);
    await app.get(TelegramGroupsService).send();
  }

  beforeAll(async () => {
    telegram = createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      const input = JSON.parse(body || '{}'), method = req.url?.split('/').pop(), reply = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url?.split('/')[1] !== `bot${botToken}`) return reply(401, { ok: false });
      if (method === 'getUpdates') return reply(200, { ok: true, result: updates.filter(update => update.update_id >= input.offset).slice(0, input.limit ?? 100) });
      if (method === 'sendMessage') {
        if (blocked.has(String(input.chat_id))) return reply(403, { ok: false, description: 'Forbidden: bot was kicked from the supergroup chat' });
        messages.push({ chat_id: String(input.chat_id), text: input.text, button: input.reply_markup?.inline_keyboard?.[0]?.[0]?.url ?? null }); return reply(200, { ok: true, result: {} });
      }
      reply(404, { ok: false }); }); });
    await new Promise<void>(resolve => telegram.listen(0, '127.0.0.1', resolve));
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
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
    await settle(); messages.length = 0; blocked.clear();
    await db.query('TRUNCATE users, staff_sessions, login_attempts, invitations, telegram_groups, telegram_group_link_codes, telegram_alert_routes, telegram_group_deliveries, notification_deliveries CASCADE');
    await db.query(`UPDATE telegram_poll_state SET "updateOffset" = $1`, [nextUpdate]);
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['admin', Role.SYSTEM_ADMIN], ['manager', Role.DISPATCHER_MANAGER], ['it', Role.IT_SPECIALIST]] as const) {
      users[key] = await db.getRepository(User).save({ firstName: 'Fictional', lastName: key, email: `groups.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
      agents[key] = request.agent(app.getHttpServer());
      const secret = key === 'admin' ? await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users[key].id) : null;
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
      if (secret) expect((await completeMfa(agents[key], headers, db, users[key].id, secret)).status).toBe(200);
    }
  });
  afterAll(async () => { await settle(); if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE invitations, telegram_groups, telegram_alert_routes, users CASCADE'); await db.destroy(); } telegram?.close(); });

  it('links a group with a one-time code typed in that group, and only there', async () => {
    const code = (await agents.admin.post('/api/telegram/groups/codes').set(headers).send({ purpose: 'IT' }).expect(201)).body;
    expect(code.command).toMatch(/^\/link \d{3} \d{3}$/);
    // Sent in a private chat, it links nothing; a wrong code in a group says so.
    say(code.command, { id: 555, type: 'private' });
    say('/link 000 000', itGroup);
    expect((await agents.admin.post(`/api/telegram/groups/codes/${code.id}/check`).set(headers).send({}).expect(200)).body).toEqual({ linked: null, expired: false });
    expect(messages.map(message => message.chat_id)).toEqual(['555', '-1001']);
    expect(messages[0].text).toContain('not here');
    say(code.command.replace('/link', '/link@ugem_updates_bot'), itGroup);
    expect((await agents.admin.post(`/api/telegram/groups/codes/${code.id}/check`).set(headers).send({}).expect(200)).body).toMatchObject({ linked: { title: 'UGEM IT', purpose: 'IT' } });
    expect(messages.at(-1)).toMatchObject({ chat_id: '-1001', text: expect.stringContaining('alerts for IT') });
    // The code worked once.
    say(code.command, { id: -1002, type: 'group', title: 'Other' });
    await agents.admin.post(`/api/telegram/groups/codes/${code.id}/check`).set(headers).send({}).expect(200);
    const view = (await agents.admin.get('/api/telegram/groups').set(headers).expect(200)).body;
    expect(view.groups).toEqual([expect.objectContaining({ title: 'UGEM IT', purpose: 'IT', linkedBy: 'Fictional admin' })]);
    expect(view.routes.find((route: { alert: string }) => route.alert === 'IT_SETUP')).toMatchObject({ sendTo: 'BOTH', groupLinked: true });
    // Only administrators.
    await agents.manager.get('/api/telegram/groups').set(headers).expect(403);
    await agents.it.post('/api/telegram/groups/codes').set(headers).send({ purpose: 'IT' }).expect(403);
  });

  it('sends a group what is waiting, combined and naming no one, as each alert’s route says', async () => {
    await link('IT', itGroup);
    messages.length = 0;
    const [{ id: requestOne }] = await db.query(`SELECT gen_random_uuid() AS id`), [{ id: requestTwo }] = await db.query(`SELECT gen_random_uuid() AS id`);
    // Both: the IT specialists and the group; the specialist never connected, so their row is skipped.
    const { NotificationsService } = await import('../src/modules/updates/notifications.service');
    const notifications = app.get(NotificationsService);
    await db.transaction(em => notifications.queueItSetupWaiting(em, { id: requestOne }));
    await db.transaction(em => notifications.queueItRemoval(em, { id: requestTwo }, 'IT_REMOVAL_WAITING'));
    expect((await db.query(`SELECT kind, status FROM notification_deliveries ORDER BY kind`))).toEqual([{ kind: 'IT_REMOVAL_WAITING', status: 'SKIPPED' }, { kind: 'IT_SETUP_WAITING', status: 'SKIPPED' }]);
    await sendGroups();
    expect(messages).toEqual([{ chat_id: '-1001', text: 'UGEM Workspace\n\n1 IT setup checklist waiting.\nSomeone has left: accounts to remove.', button: 'http://localhost:3000/it/tasks' }]);
    expect(await db.query(`SELECT status FROM telegram_group_deliveries`)).toEqual([{ status: 'SENT' }, { status: 'SENT' }]);
    // Group only: no person rows at all.
    await agents.admin.patch('/api/telegram/routes/IT_SETUP').set(headers).send({ sendTo: 'GROUP' }).expect(200);
    await db.transaction(em => notifications.queueItSetupWaiting(em, { id: requestTwo }));
    expect((await db.query(`SELECT count(*)::integer AS n FROM notification_deliveries WHERE kind = 'IT_SETUP_WAITING'`))[0].n).toBe(1);
    // Some alerts allow only one way: daily Safety reminders stay with people, sign-ins go to IT's group.
    await agents.admin.patch('/api/telegram/routes/SAFETY_DAILY').set(headers).send({ sendTo: 'GROUP' }).expect(400);
    await agents.admin.patch('/api/telegram/routes/IT_SIGN_IN').set(headers).send({ sendTo: 'PEOPLE' }).expect(400);
    await agents.admin.patch('/api/telegram/routes/NOT_AN_ALERT').set(headers).send({ sendTo: 'PEOPLE' }).expect(404);
    await queueGroupOnly(db.manager, 'IT_SIGN_IN_WAITING', null);
    messages.length = 0; await sendGroups();
    expect(messages.map(message => message.text)).toEqual(['UGEM Workspace\n\n1 IT setup checklist waiting.\n1 team lead sign-in to create or turn off.']);
  });

  it('falls back to people when a group-only alert has no group, and stops a group the bot was removed from', async () => {
    await agents.admin.patch('/api/telegram/routes/IT_LEAVE').set(headers).send({ sendTo: 'GROUP' }).expect(200);
    expect(await alertTargets(db.manager, 'IT_LEAVE_SUSPEND')).toEqual({ people: true, groupId: null });
    // Team lead sign-ins never went to people, so with no group they reach no one, as before.
    expect(await alertTargets(db.manager, 'IT_SIGN_IN_WAITING')).toEqual({ people: false, groupId: null });
    const linked = await link('IT', itGroup);
    expect(await alertTargets(db.manager, 'IT_LEAVE_SUSPEND')).toEqual({ people: false, groupId: linked.linked.id });
    // A test message, then the bot is removed: the group is marked and nothing more waits for it.
    await agents.admin.post(`/api/telegram/groups/${linked.linked.id}/test`).set(headers).send({}).expect(200);
    expect(messages.at(-1)).toMatchObject({ chat_id: '-1001', text: expect.stringContaining('Test message') });
    blocked.add('-1001');
    await agents.admin.post(`/api/telegram/groups/${linked.linked.id}/test`).set(headers).send({}).expect(409);
    expect((await db.query(`SELECT "lostAt" IS NOT NULL AS lost FROM telegram_groups`))[0].lost).toBe(true);
    expect(await alertTargets(db.manager, 'IT_LEAVE_SUSPEND')).toEqual({ people: true, groupId: null });
  });

  it('links a team’s group to the team, replaces a department’s earlier group, and unlinks', async () => {
    await db.query(`INSERT INTO mcs (name, "nameKey") VALUES ('Northwind Freight', 'northwind freight')`);
    const [team] = await db.query(`INSERT INTO teams (name, "nameKey", "mcId") SELECT 'Avery team', 'avery team', id FROM mcs RETURNING id`);
    await agents.admin.post('/api/telegram/groups/codes').set(headers).send({ purpose: 'TEAM' }).expect(400);
    await agents.admin.post('/api/telegram/groups/codes').set(headers).send({ purpose: 'IT', teamId: team.id }).expect(400);
    expect((await link('TEAM', { id: -2001, type: 'group', title: 'Avery team' }, { teamId: team.id })).linked).toMatchObject({ purpose: 'TEAM' });
    const first = await link('IT', itGroup), second = await link('IT', { id: -1003, type: 'supergroup', title: 'IT (new)' });
    const open = await db.query(`SELECT id, title FROM telegram_groups WHERE "unlinkedAt" IS NULL ORDER BY title`);
    expect(open.map((row: { title: string }) => row.title)).toEqual(['Avery team', 'IT (new)']);
    expect(open.some((row: { id: string }) => row.id === first.linked.id)).toBe(false);
    await agents.admin.post(`/api/telegram/groups/${second.linked.id}/unlink`).set(headers).send({}).expect(200);
    await agents.admin.post(`/api/telegram/groups/${second.linked.id}/unlink`).set(headers).send({}).expect(404);
  });

  it('refuses a rollback while groups or routes are recorded', async () => {
    await agents.admin.patch('/api/telegram/routes/REVIEW').set(headers).send({ sendTo: 'BOTH' }).expect(200);
    const runner = db.createQueryRunner();
    const { TelegramGroups1793290000000: Migration } = await import('../src/database/migrations/1793290000000-TelegramGroups');
    await expect(new Migration().down(runner)).rejects.toThrow('Refusing to roll back while Telegram groups');
    await runner.release();
  });
});
