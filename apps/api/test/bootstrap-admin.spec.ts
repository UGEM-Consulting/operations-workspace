import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { bootstrapAdmin, bootstrapIdentity, BootstrapError } from '../src/database/bootstrap-admin';
import { validateEnvironment } from '../src/config/environment';
import { databaseOptions } from '../src/database/options';
import { hashPassword, verifyPassword } from '../src/modules/auth/password';
import { Role, User, UserStatus } from '../src/modules/users/user.entity';

const input = { BOOTSTRAP_ADMIN_EMAIL: '  FIRST.ADMIN@EXAMPLE.TEST ', BOOTSTRAP_ADMIN_FIRST_NAME: ' Avery ', BOOTSTRAP_ADMIN_LAST_NAME: ' Fictional ' };
const password = randomBytes(24).toString('base64url');
describe('Bootstrap input validation', () => {
  it('normalizes email and trims names', () => {
    expect(bootstrapIdentity(input)).toEqual({ email: 'first.admin@example.test', firstName: 'Avery', lastName: 'Fictional' });
  });
  it.each([
    { BOOTSTRAP_ADMIN_EMAIL: '' }, { BOOTSTRAP_ADMIN_EMAIL: 'invalid' },
    { BOOTSTRAP_ADMIN_EMAIL: 'a'.repeat(255) + '@example.test' },
    { BOOTSTRAP_ADMIN_FIRST_NAME: '   ' }, { BOOTSTRAP_ADMIN_LAST_NAME: '' },
    { BOOTSTRAP_ADMIN_FIRST_NAME: 'a'.repeat(101) }, { BOOTSTRAP_ADMIN_LAST_NAME: 'A\nB' },
  ])('rejects invalid identity %j', override => {
    expect(() => bootstrapIdentity({ ...input, ...override })).toThrow(BootstrapError);
  });
  it.each(['', 'short', ' '.repeat(12), 'x'.repeat(129), 'a'.repeat(12) + '\n'])('rejects invalid passwords before accessing the database', async invalid => {
    await expect(bootstrapAdmin({} as DataSource, input, invalid)).rejects.toThrow(BootstrapError);
  });
});

describe('Bootstrap CLI boundary', () => {
  function cli(args: string[] = [], overrides: Record<string, string> = {}) {
    return spawnSync(process.execPath, ['-r', 'ts-node/register', 'src/database/admin-bootstrap.ts', ...args], {
      cwd: resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', NODE_ENV: 'test',
        ...input, DATABASE_URL: 'postgresql://localhost:9/unreachable_test', DATABASE_SSL: 'false',
        SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'),
        WEB_ORIGIN: 'http://localhost:3000', CORS_ORIGINS: 'http://localhost:3000', ...overrides },
    });
  }
  it('rejects arguments without echoing their contents', () => {
    const marker = randomBytes(24).toString('hex');
    const result = cli([marker]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('accepts no arguments');
    expect(result.stdout + result.stderr).not.toContain(marker);
  });
  it('refuses DATABASE_URL TLS overrides with the shared rule, without printing the URL', () => {
    const marker = randomBytes(12).toString('hex');
    const result = cli([], { DATABASE_URL: `postgresql://user:${marker}@localhost:9/unreachable_test?sslmode=disable` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('configure TLS with DATABASE_SSL');
    expect(result.stdout + result.stderr).not.toContain(marker);
  });
  it('fails closed without an interactive terminal before connecting to PostgreSQL', () => {
    const result = cli();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('interactive terminal is required');
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('postgresql');
  });
});

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Administrator bootstrap PostgreSQL integration (disposable test database)', () => {
  let db: DataSource;
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL!;
    if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated *_test database required');
    db = await new DataSource(databaseOptions(validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: url,
      SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'),
      WEB_ORIGIN: 'http://localhost:3000', CORS_ORIGINS: 'http://localhost:3000' }))).initialize();
    await db.runMigrations();
  });
  beforeEach(async () => { await db.query('TRUNCATE users CASCADE'); });
  afterAll(async () => { if (db?.isInitialized) await db.destroy(); });
  const users = () => db.getRepository(User);
  async function existing(role = Role.DISPATCHER_MANAGER, status = UserStatus.ACTIVE) {
    return users().save(users().create({ email: 'existing@example.test', firstName: 'Existing', lastName: 'Fictional', role, status, passwordHash: await hashPassword(password) }));
  }
  it('creates the first active administrator using Argon2id and the existing verifier', async () => {
    await bootstrapAdmin(db, input, password);
    const user = await users().createQueryBuilder('user').addSelect('user.passwordHash').getOneOrFail();
    // The administrator chose the password at the hidden prompt, so no forced change follows.
    expect({ email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role, status: user.status, lastLoginAt: user.lastLoginAt, mustChangePassword: user.mustChangePassword }).toEqual({ email: 'first.admin@example.test', firstName: 'Avery', lastName: 'Fictional', role: Role.SYSTEM_ADMIN, status: UserStatus.ACTIVE, lastLoginAt: null, mustChangePassword: false });
    expect(user.passwordHash?.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(user.passwordHash!, password)).toBe(true);
    expect(await verifyPassword(user.passwordHash!, randomBytes(16).toString('hex'))).toBe(false);
  });
  it.each([UserStatus.ACTIVE, UserStatus.INACTIVE])('refuses bootstrap when an administrator is %s', async status => {
    await existing(Role.SYSTEM_ADMIN, status);
    const before = await db.query('SELECT * FROM users');
    await expect(bootstrapAdmin(db, input, password)).rejects.toThrow('SYSTEM_ADMIN already exists');
    expect(JSON.stringify(await db.query('SELECT * FROM users')) === JSON.stringify(before)).toBe(true);
  });
  it('rejects duplicate emails without elevating, resetting or reactivating an existing user', async () => {
    await existing(Role.IT_SPECIALIST, UserStatus.INACTIVE);
    const before = await db.query('SELECT * FROM users');
    await expect(bootstrapAdmin(db, { ...input, BOOTSTRAP_ADMIN_EMAIL: ' EXISTING@EXAMPLE.TEST ' }, password)).rejects.toThrow('email belongs to an existing user');
    expect(JSON.stringify(await db.query('SELECT * FROM users')) === JSON.stringify(before)).toBe(true);
  });
  it('preserves unrelated existing users when bootstrapping', async () => {
    const user = await existing();
    const before = await db.query('SELECT * FROM users WHERE id=$1', [user.id]);
    await bootstrapAdmin(db, input, password);
    expect(JSON.stringify(await db.query('SELECT * FROM users WHERE id=$1', [user.id])) === JSON.stringify(before)).toBe(true);
    expect(await users().count()).toBe(2);
  });
  it('permits exactly one concurrent execution with distinct emails', async () => {
    const results = await Promise.allSettled([bootstrapAdmin(db, input, password), bootstrapAdmin(db, { ...input, BOOTSTRAP_ADMIN_EMAIL: 'second@example.test' }, password)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BootstrapError);
    expect(await users().countBy({ role: Role.SYSTEM_ADMIN })).toBe(1);
  });
});
