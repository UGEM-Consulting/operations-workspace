import { randomBytes } from 'node:crypto';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { applyPendingMigrations, deploymentMigrationLogger } from '../src/database/deploy-migrations';
import { databaseOptions } from '../src/database/options';
import { validateEnvironment } from '../src/config/environment';
import { startAfterMigrations, startupFailureReason } from '../src/start-render';

describe('Render startup ordering', () => {
  it('starts the API only after migrations succeed', async () => {
    const events: string[] = [];
    await startAfterMigrations(async () => { events.push('migrated'); }, async () => { events.push('started'); });
    expect(events).toEqual(['migrated', 'started']);
  });
  it('blocks startup on migration failure', async () => {
    const start = jest.fn();
    await expect(startAfterMigrations(async () => { throw new Error('test failure'); }, start)).rejects.toThrow('test failure');
    expect(start).not.toHaveBeenCalled();
  });
});
describe('Render startup failure reasons', () => {
  const secret = randomBytes(16).toString('hex');
  const base = { NODE_ENV: 'production', DATABASE_URL: `postgresql://user:${secret}@db.example.test/operations`, WEB_ORIGIN: 'https://workspace.example.test', CORS_ORIGINS: 'https://workspace.example.test', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex') };
  const reasonFor = (input: Record<string, unknown>) => { try { validateEnvironment(input); return 'accepted'; } catch (error) { return startupFailureReason(error); } };
  it('names the rejected configuration rule without values', () => {
    const reasons = [reasonFor({ ...base, DEMO_EMAIL_MODE: 'true' }), reasonFor({ ...base, EMAIL_DELIVERY: 'smtp' }), reasonFor({ ...base, SESSION_SECRET: 'short' })];
    expect(reasons[0]).toMatch(/^configuration: The fictional demo deployment was retired/);
    expect(reasons[1]).toBe('configuration: SMTP delivery requires SMTP_HOST and a valid EMAIL_FROM');
    expect(reasons[2]).toBe('configuration: Invalid environment: SESSION_SECRET (string.min)');
    for (const reason of reasons) expect(reason).not.toContain(secret);
  });
  it('shows fixed migration guard texts but only codes for other database failures', () => {
    expect(startupFailureReason(Object.assign(new Error('This database belongs to the retired fictional demo deployment; use a fresh production database'), { code: 'P0001' })))
      .toBe('migration refused: This database belongs to the retired fictional demo deployment; use a fresh production database');
    expect(startupFailureReason(Object.assign(new Error(`password authentication failed for user ${secret}`), { code: '28P01' }))).toBe('database error SQLSTATE 28P01');
    expect(startupFailureReason(Object.assign(new Error(`connect ECONNREFUSED ${secret}`), { code: 'ECONNREFUSED' }))).toBe('database connection failed: ECONNREFUSED');
    expect(startupFailureReason(new Error(secret))).toBe('unexpected error (details suppressed)');
  });
});

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Deployment migration locking (dedicated PostgreSQL test database)', () => {
  let db: DataSource;
  let other: DataSource;
  let schema: string;
  let fail: boolean;
  let failWithSensitiveMessage: boolean;
  const sensitiveMarker = randomBytes(24).toString('hex');
  beforeEach(async () => {
    const url = process.env.TEST_DATABASE_URL!;
    if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated *_test database required');
    schema = `migration_test_${randomBytes(8).toString('hex')}`;
    fail = false;
    failWithSensitiveMessage = false;
    class DeploymentProbe1792660000000 implements MigrationInterface {
      async up(runner: QueryRunner) {
        await runner.query(`CREATE TABLE "${schema}".probe (id integer PRIMARY KEY)`);
        await runner.query(`INSERT INTO "${schema}".probe VALUES (1)`);
        if (fail) await runner.query('SELECT 1/0');
        if (failWithSensitiveMessage) throw new Error(sensitiveMarker);
      }
      async down(runner: QueryRunner) { await runner.query(`DROP TABLE "${schema}".probe`); }
    }
    const options = { ...databaseOptions(validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: url,
      WEB_ORIGIN: 'http://localhost:3000', CORS_ORIGINS: 'http://localhost:3000',
      SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex') })),
    entities: [], migrations: [DeploymentProbe1792660000000], schema, logging: false as const,
    logger: deploymentMigrationLogger,
    extra: { max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 } };
    db = await new DataSource(options).initialize();
    await db.query(`CREATE SCHEMA "${schema}"`);
    other = await new DataSource(options).initialize();
  });
  afterEach(async () => {
    if (other?.isInitialized) await other.destroy();
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.destroy();
    }
  });
  it('applies a pending migration once and skips it on the next restart', async () => {
    expect(await applyPendingMigrations(db)).toBe(1);
    expect(await applyPendingMigrations(db)).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS count FROM "${schema}".probe`))[0].count).toBe(1);
  });
  it('serializes simultaneous migration runners before checking migration history', async () => {
    const counts = await Promise.all([applyPendingMigrations(db), applyPendingMigrations(other)]);
    expect(counts.sort()).toEqual([0, 1]);
  });
  it('rolls back failed migrations and releases the lock so a corrected release can retry', async () => {
    fail = true;
    await expect(applyPendingMigrations(db)).rejects.toThrow();
    expect((await db.query('SELECT to_regclass($1) IS NULL AS absent', [`${schema}.probe`]))[0].absent).toBe(true);
    fail = false;
    expect(await applyPendingMigrations(other)).toBe(1);
  });
  it('does not log raw migration errors, even when TypeORM emits a migration log', async () => {
    const logs = [jest.spyOn(console, 'log').mockImplementation(() => undefined),
      jest.spyOn(console, 'error').mockImplementation(() => undefined),
      jest.spyOn(console, 'warn').mockImplementation(() => undefined)];
    try {
      failWithSensitiveMessage = true;
      await expect(applyPendingMigrations(db)).rejects.toThrow();
      expect(logs.some(log => log.mock.calls.some(args => args.some(value => String(value).includes(sensitiveMarker))))).toBe(false);
      failWithSensitiveMessage = false;
      expect(await applyPendingMigrations(other)).toBe(1);
    } finally { logs.forEach(log => log.mockRestore()); }
  });
});
