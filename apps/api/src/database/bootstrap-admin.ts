import 'reflect-metadata';
import { isEmail } from 'class-validator';
import { DataSource } from 'typeorm';
import { hashPassword } from '../modules/auth/password';
import { Role, User, UserStatus } from '../modules/users/user.entity';

export class BootstrapError extends Error {}
const hasControlCharacters = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export function bootstrapIdentity(input: NodeJS.ProcessEnv) {
  const email = input.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const firstName = input.BOOTSTRAP_ADMIN_FIRST_NAME?.trim();
  const lastName = input.BOOTSTRAP_ADMIN_LAST_NAME?.trim();
  if (!email || email.length > 254 || !isEmail(email)
    || !firstName || firstName.length > 100 || !lastName || lastName.length > 100
    || hasControlCharacters(firstName + lastName)) {
    throw new BootstrapError('Provide a valid BOOTSTRAP_ADMIN_EMAIL and non-empty first/last names (maximum 100 characters each).');
  }
  if ((input.DEPLOYMENT_PURPOSE === 'demo' || input.DEMO_EMAIL_MODE === 'true') && !email.endsWith('@example.test')) {
    throw new BootstrapError('Demo administrator bootstrap requires a fictional example.test email.');
  }
  return { email, firstName, lastName };
}

export async function bootstrapAdmin(db: DataSource, input: NodeJS.ProcessEnv, password: string): Promise<void> {
  const identity = bootstrapIdentity(input);
  if (typeof password !== 'string' || password.length < 12 || password.length > 128 || !password.trim()
    || hasControlCharacters(password)) {
    throw new BootstrapError('The initial password must contain 12–128 characters without control characters.');
  }
  const passwordHash = await hashPassword(password);
  await db.transaction('READ COMMITTED', async manager => {
    // Same lock as administrator updates/demo seed, followed by a table lock to
    // serialize even writers that do not participate in the advisory protocol.
    await manager.query('SELECT pg_advisory_xact_lock(42002026)');
    await manager.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const repo = manager.getRepository(User);
    if (await repo.existsBy({ role: Role.SYSTEM_ADMIN })) {
      throw new BootstrapError('Bootstrap refused: a SYSTEM_ADMIN already exists, regardless of status.');
    }
    if (await repo.existsBy({ email: identity.email })) {
      throw new BootstrapError('Bootstrap refused: the email belongs to an existing user. No account was changed.');
    }
    await repo.insert({ ...identity, passwordHash, role: Role.SYSTEM_ADMIN, status: UserStatus.ACTIVE });
  });
}
