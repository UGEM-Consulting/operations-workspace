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
import { AnnouncementsModule } from '../src/modules/announcements/announcements.module';
import { AnnouncementsService } from '../src/modules/announcements/announcements.service';
import { DispatchModule } from '../src/modules/dispatch/dispatch.module';
import { completeMfa, enrolForTest } from './mfa-helpers';
type Agent = ReturnType<typeof request.agent>;
type Key = 'admin' | 'manager' | 'lead' | 'it';
type Row = Record<string, unknown>;
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Announcements to team groups (disposable PostgreSQL)', () => {
  let app: INestApplication, db: DataSource, closeSessions: () => Promise<void>, telegram: Server;
  let env: ReturnType<typeof validateEnvironment>, headers: Record<string, string>;
  const password = randomBytes(24).toString('base64url'), botToken = `12345678:${randomBytes(24).toString('base64url')}`;
  // A local fake of the Telegram Bot API: a chat in blocked answers 403 (bot removed), one in down answers 500.
  const messages: { chat_id: string; text: string; message_id: number }[] = [], deleted: { chat_id: string; message_id: number }[] = [];
  const blocked = new Set<string>(), down = new Set<string>();
  let nextMessage = 500;
  const users: Record<Key, User> = {} as never, agents: Record<Key, Agent> = {} as never;
  let red: string, blue: string, green: string, mc: string;
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params))[0];
  const group = (teamId: string, chatId: string, title: string) => one(`INSERT INTO telegram_groups ("chatId", title, purpose, "teamId", "linkedBy") VALUES ($1, $2, 'TEAM', $3, $4) RETURNING id`, [chatId, title, teamId, users.admin.id]);
  const post = (key: Key, body: Row) => agents[key].post('/api/announcements').set(headers).send(body);

  beforeAll(async () => {
    telegram = createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      const input = JSON.parse(body || '{}'), method = req.url?.split('/').pop(), reply = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url?.split('/')[1] !== `bot${botToken}`) return reply(401, { ok: false });
      const chat = String(input.chat_id);
      if (blocked.has(chat)) return reply(403, { ok: false });
      if (down.has(chat)) return reply(500, { ok: false });
      if (method === 'sendMessage') { const message_id = nextMessage++; messages.push({ chat_id: chat, text: input.text, message_id }); return reply(200, { ok: true, result: { message_id } }); }
      if (method === 'deleteMessage') { deleted.push({ chat_id: chat, message_id: input.message_id }); return reply(200, { ok: true, result: true }); }
      reply(404, { ok: false }); }); });
    await new Promise<void>(resolve => telegram.listen(0, '127.0.0.1', resolve));
    env = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/operations_m2_test', CORS_ORIGINS: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), SESSION_TTL_SECONDS: 3600, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      TELEGRAM_DELIVERY: 'bot', TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_BOT_USERNAME: 'ugem_updates_bot', TELEGRAM_API_BASE: `http://127.0.0.1:${(telegram.address() as AddressInfo).port}` });
    headers = { 'x-workspace-key': env.BFF_SHARED_SECRET, origin: env.WEB_ORIGIN, 'x-csrf-protection': '1' };
    if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
    db = await new DataSource(databaseOptions(env)).initialize(); await db.runMigrations();
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), TypeOrmModule.forRoot(databaseOptions(env)), AuthModule, DispatchModule, AnnouncementsModule] }).compile();
    app = module.createNestApplication(); closeSessions = installSessions(app, env); configureApp(app, env.CORS_ORIGINS); await app.init();
  }, 30000);
  beforeEach(async () => {
    messages.length = 0; deleted.length = 0; blocked.clear(); down.clear();
    await db.query('TRUNCATE users, staff_sessions, login_attempts, mcs, teams, dispatch_members, telegram_groups, team_announcements, team_announcement_deliveries CASCADE');
    const passwordHash = await hashPassword(password);
    for (const [key, role] of [['admin', Role.SYSTEM_ADMIN], ['manager', Role.DISPATCHER_MANAGER], ['lead', Role.TEAM_LEAD], ['it', Role.IT_SPECIALIST]] as const)
      users[key] = await db.getRepository(User).save({ firstName: key === 'lead' ? 'Jordan' : 'Avery', lastName: key === 'lead' ? 'Avery' : key, email: `announce.${key}@example.test`, role, status: UserStatus.ACTIVE, passwordHash });
    ({ id: mc } = await one(`INSERT INTO mcs (name, "nameKey") VALUES ('Northwind Freight', 'northwind freight') RETURNING id`));
    [red, blue, green] = await Promise.all(['Red', 'Blue', 'Green'].map(async name => (await one(`INSERT INTO teams (name, "nameKey", "mcId") VALUES ($1, $2, $3) RETURNING id`, [`${name} team`, `${name.toLowerCase()} team`, mc])).id));
    // Jordan leads Red team through their dispatcher record.
    const lead = await one(`INSERT INTO dispatch_members ("firstName", "lastName", position, status, "joinedAt", "accountUserId") VALUES ('Jordan', 'Avery', 'DISPATCHER', 'ACTIVE', now(), $1) RETURNING id`, [users.lead.id]);
    await db.query(`UPDATE teams SET "leadMemberId" = $1 WHERE id = $2`, [lead.id, red]);
    await group(red, '-2001', 'Red dispatch'); await group(blue, '-2002', 'Blue dispatch');
    for (const key of ['admin', 'manager', 'lead', 'it'] as const) {
      agents[key] = request.agent(app.getHttpServer());
      const secret = key === 'admin' ? await enrolForTest(db, env.MFA_ENCRYPTION_KEY!, users[key].id) : null;
      await agents[key].post('/api/auth/login').set(headers).send({ email: users[key].email, password }).expect(200);
      if (secret) expect((await completeMfa(agents[key], headers, db, users[key].id, secret)).status).toBe(200);
    }
  });
  afterAll(async () => { if (closeSessions) await closeSessions(); if (app) await app.close(); if (db?.isInitialized) { await db.query('TRUNCATE team_announcements, telegram_groups, teams, mcs, dispatch_members, users CASCADE'); await db.destroy(); } telegram?.close(); });

  it('sends a manager’s announcement to each chosen team’s group, headed by who wrote it, and records each delivery', async () => {
    const options = (await agents.manager.get('/api/announcements/options').set(headers).expect(200)).body;
    expect(options.teams.map((team: Row) => [team.name, team.linked])).toEqual([['Blue team', true], ['Green team', false], ['Red team', true]]);
    const text = 'Weekly check-in moves to Thursday 10:00 Central.\nRiley Santos covers Jordan’s drivers on Friday.';
    const sent = (await post('manager', { teamIds: [red, blue], text: `  ${text}  ` }).expect(201)).body;
    expect(sent).toMatchObject({ text, authorName: 'Avery manager', authorRole: 'Dispatch manager', canTakeBack: true });
    expect(sent.deliveries.map((d: Row) => [d.team, d.groupTitle, d.status, d.retrying])).toEqual([['Blue team', 'Blue dispatch', 'SENT', false], ['Red team', 'Red dispatch', 'SENT', false]]);
    expect(messages.map(m => m.chat_id).sort()).toEqual(['-2001', '-2002']);
    expect(messages[0].text).toBe(`Announcement from Avery manager, Dispatch manager\n\n${text}`);
    const list = (await agents.admin.get('/api/announcements').set(headers).expect(200)).body.items;
    expect(list).toEqual([expect.objectContaining({ id: sent.id, teams: ['Blue team', 'Red team'], delivered: 2, groups: 2, sending: 0 })]);
    // The team's page shows its latest announcement.
    const team = (await agents.manager.get(`/api/dispatch/teams/${red}`).set(headers).expect(200)).body;
    expect(team.telegramGroup.latestAnnouncement).toMatchObject({ id: sent.id, authorName: 'Avery manager' });
  });

  it('refuses teams without a group, empty or long text, SSN-like text, and roles that don’t write', async () => {
    const refused = (await post('manager', { teamIds: [red, green], text: 'Hello team' }).expect(400)).body;
    expect(refused.message).toContain('Green team has no Telegram group linked');
    await post('manager', { teamIds: [], text: 'Hello' }).expect(400);
    await post('manager', { teamIds: [red], text: '   ' }).expect(400);
    await post('manager', { teamIds: [red], text: 'x'.repeat(1001) }).expect(400);
    await post('manager', { teamIds: [red], text: 'New hire SSN 123-45-6789' }).expect(400);
    await post('it', { teamIds: [red], text: 'Hello' }).expect(403);
    await agents.it.get('/api/announcements').set(headers).expect(403);
    expect(messages).toHaveLength(0);
    expect(await one(`SELECT count(*)::integer AS n FROM team_announcements`)).toEqual({ n: 0 });
  });

  it('lets a team lead write to the teams they lead only, and see only those', async () => {
    expect((await agents.lead.get('/api/announcements/options').set(headers).expect(200)).body.teams.map((team: Row) => team.name)).toEqual(['Red team']);
    await post('lead', { teamIds: [blue], text: 'Hello Blue' }).expect(403);
    const mine = (await post('lead', { teamIds: [red], text: 'Truck 214 is back from the shop.' }).expect(201)).body;
    expect(messages.at(-1)?.text).toBe('Announcement from Jordan Avery, Team lead\n\nTruck 214 is back from the shop.');
    // A manager's announcement to Red and Blue: the lead sees it with Red's delivery only, and can't take it back.
    const managers = (await post('manager', { teamIds: [red, blue], text: 'Holiday schedule soon.' }).expect(201)).body;
    const blueOnly = (await post('manager', { teamIds: [blue], text: 'Blue only.' }).expect(201)).body;
    const list = (await agents.lead.get('/api/announcements').set(headers).expect(200)).body.items;
    expect(list.map((item: Row) => item.id)).toEqual([managers.id, mine.id]);
    expect(list[0]).toMatchObject({ teams: ['Red team'], groups: 1 });
    const seen = (await agents.lead.get(`/api/announcements/${managers.id}`).set(headers).expect(200)).body;
    expect(seen.deliveries.map((d: Row) => d.team)).toEqual(['Red team']);
    expect(seen.canTakeBack).toBe(false);
    await agents.lead.get(`/api/announcements/${blueOnly.id}`).set(headers).expect(404);
    await agents.lead.post(`/api/announcements/${managers.id}/take-back`).set(headers).send({}).expect(403);
    expect((await agents.lead.post(`/api/announcements/${mine.id}/take-back`).set(headers).send({}).expect(200)).body.takenBackAt).toBeTruthy();
    // Someone who leads nothing anymore is refused.
    await db.query(`UPDATE teams SET "leadMemberId" = NULL`);
    await agents.lead.get('/api/announcements').set(headers).expect(403);
  });

  it('takes an announcement back from every group within 48 hours, and keeps it listed as taken back', async () => {
    const sent = (await post('manager', { teamIds: [red, blue], text: 'Wrong day.' }).expect(201)).body;
    const back = (await agents.manager.post(`/api/announcements/${sent.id}/take-back`).set(headers).send({ reason: 'It’s Wednesday.' }).expect(200)).body;
    expect(back).toMatchObject({ takeBackReason: 'It’s Wednesday.', takenBackBy: 'Avery manager', canTakeBack: false });
    expect(back.deliveries.map((d: Row) => d.status)).toEqual(['TAKEN_BACK', 'TAKEN_BACK']);
    expect(deleted.map(d => d.message_id).sort()).toEqual(messages.map(m => m.message_id).sort());
    await agents.manager.post(`/api/announcements/${sent.id}/take-back`).set(headers).send({}).expect(409);
    expect((await agents.manager.get(`/api/dispatch/teams/${red}`).set(headers).expect(200)).body.telegramGroup.latestAnnouncement).toBeNull();
    // After 48 hours Telegram won't delete it, so the workspace doesn't offer to.
    const old = (await post('manager', { teamIds: [red], text: 'Old news.' }).expect(201)).body;
    await db.query(`UPDATE team_announcements SET "createdAt" = now() - interval '49 hours' WHERE id = $1`, [old.id]);
    expect((await agents.manager.get(`/api/announcements/${old.id}`).set(headers).expect(200)).body.canTakeBack).toBe(false);
    await agents.manager.post(`/api/announcements/${old.id}/take-back`).set(headers).send({}).expect(409);
  });

  it('marks a group lost when the bot was removed, and retries one Telegram couldn’t take', async () => {
    blocked.add('-2001'); down.add('-2002');
    const sent = (await post('manager', { teamIds: [red, blue], text: 'Check-in moved.' }).expect(201)).body;
    expect(sent.deliveries.map((d: Row) => [d.team, d.status, d.failureCode])).toEqual([['Blue team', 'PENDING', null], ['Red team', 'FAILED', 'FORBIDDEN']]);
    expect((await one(`SELECT "lostAt" FROM telegram_groups WHERE "chatId" = '-2001'`)).lostAt).toBeTruthy();
    expect((await agents.manager.get('/api/announcements/options').set(headers).expect(200)).body.teams.find((team: Row) => team.id === red).linked).toBe(false);
    // The sweeper sends it once Telegram answers again.
    down.clear();
    await db.query(`UPDATE team_announcement_deliveries SET "claimedAt" = now() - interval '2 minutes' WHERE status = 'PENDING'`);
    await app.get(AnnouncementsService).sweep();
    expect((await agents.manager.get(`/api/announcements/${sent.id}`).set(headers).expect(200)).body.deliveries.map((d: Row) => d.status)).toEqual(['SENT', 'FAILED']);
    // A taken-back announcement still waiting is never sent.
    down.add('-2002');
    const second = (await post('manager', { teamIds: [blue], text: 'Never mind.' }).expect(201)).body;
    await agents.manager.post(`/api/announcements/${second.id}/take-back`).set(headers).send({}).expect(200);
    down.clear();
    await db.query(`UPDATE team_announcement_deliveries SET "claimedAt" = now() - interval '2 minutes' WHERE status = 'PENDING'`);
    await app.get(AnnouncementsService).sweep();
    expect(messages.some(m => m.text.endsWith('Never mind.'))).toBe(false);
    // Red's group never got the first one, so the team page doesn't show it as the latest there.
    expect((await agents.manager.get(`/api/dispatch/teams/${red}`).set(headers).expect(200)).body.telegramGroup.latestAnnouncement).toBeNull();
  });

  it('tries a take-back again when Telegram couldn’t delete it, until it can', async () => {
    const sent = (await post('manager', { teamIds: [blue], text: 'Wrong truck.' }).expect(201)).body;
    down.add('-2002');
    const back = (await agents.manager.post(`/api/announcements/${sent.id}/take-back`).set(headers).send({}).expect(200)).body;
    expect(back.deliveries.map((d: Row) => [d.status, d.failureCode, d.retrying])).toEqual([['SENT', 'DELETE_SERVER', true]]);
    // Not again before five minutes have passed since the last try.
    down.clear();
    await app.get(AnnouncementsService).sweep();
    expect(deleted).toHaveLength(0);
    await db.query(`UPDATE team_announcement_deliveries SET "claimedAt" = now() - interval '6 minutes'`);
    await app.get(AnnouncementsService).sweep();
    expect(deleted.map(d => d.chat_id)).toEqual(['-2002']);
    expect((await agents.manager.get(`/api/announcements/${sent.id}`).set(headers).expect(200)).body.deliveries.map((d: Row) => [d.status, d.retrying])).toEqual([['TAKEN_BACK', false]]);
  });

  it('sends a waiting delivery to the group that replaced the one it was written for', async () => {
    down.add('-2002');
    const sent = (await post('manager', { teamIds: [blue], text: 'New group test.' }).expect(201)).body;
    await db.query(`UPDATE telegram_groups SET "unlinkedAt" = now() WHERE "chatId" = '-2002'`);
    const replacement = await group(blue, '-2003', 'Blue dispatch 2');
    down.clear();
    await db.query(`UPDATE team_announcement_deliveries SET "claimedAt" = now() - interval '2 minutes' WHERE status = 'PENDING'`);
    await app.get(AnnouncementsService).sweep();
    expect(messages.filter(m => m.text.endsWith('New group test.')).map(m => m.chat_id)).toEqual(['-2003']);
    expect(await one(`SELECT status, "groupId" FROM team_announcement_deliveries WHERE "announcementId" = $1`, [sent.id])).toEqual({ status: 'SENT', groupId: replacement.id });
  });

  it('never sends again a delivery whose claim nobody finished, since it may already be in the group', async () => {
    const sent = (await post('manager', { teamIds: [red], text: 'Maybe sent.' }).expect(201)).body;
    messages.length = 0;
    await db.query(`UPDATE team_announcement_deliveries SET status = 'SENDING', "sentAt" = NULL, "messageId" = NULL, "claimedAt" = now() - interval '11 minutes' WHERE "announcementId" = $1`, [sent.id]);
    await app.get(AnnouncementsService).sweep();
    expect(messages).toHaveLength(0);
    expect(await one(`SELECT status, "failureCode" FROM team_announcement_deliveries WHERE "announcementId" = $1`, [sent.id])).toEqual({ status: 'FAILED', failureCode: 'UNCONFIRMED' });
  });

  it('refuses a rollback while announcements are recorded', async () => {
    await post('manager', { teamIds: [red], text: 'Hello.' }).expect(201);
    const runner = db.createQueryRunner();
    const { TeamAnnouncements1793330000000: Migration } = await import('../src/database/migrations/1793330000000-TeamAnnouncements');
    await expect(new Migration().down(runner)).rejects.toThrow('Refusing to roll back while team announcements are recorded.');
    await runner.release();
  });
});
