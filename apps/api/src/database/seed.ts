import 'reflect-metadata';
import 'dotenv/config';
import { isEmail } from 'class-validator';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../config/environment';
import { databaseOptions } from './options';
import { Role, User, UserStatus } from '../modules/users/user.entity';
import { hashPassword } from '../modules/auth/password';
export async function seedDemo(db: DataSource, input: NodeJS.ProcessEnv): Promise<number> {
  if (input.NODE_ENV === 'production' || input.ALLOW_DEMO_SEED !== 'true') throw new Error('Demo seeding requires ALLOW_DEMO_SEED=true in a non-production environment');
  const specs = [
    { prefix: 'ADMIN', firstName: 'Avery', lastName: 'Demo', role: Role.SYSTEM_ADMIN },
    { prefix: 'MANAGER', firstName: 'Morgan', lastName: 'Demo', role: Role.DISPATCHER_MANAGER },
    { prefix: 'IT', firstName: 'Taylor', lastName: 'Demo', role: Role.IT_SPECIALIST },
  ];
  const accounts = specs.map(spec => {
    const email = input[`DEMO_${spec.prefix}_EMAIL`]?.trim().toLowerCase();
    const password = input[`DEMO_${spec.prefix}_PASSWORD`];
    if (!email || !isEmail(email) || !email.endsWith('@example.test') || !password || password.length < 12 || password.length > 128) throw new Error('Demo accounts require unique example.test emails and 12–128 character passwords supplied through environment variables');
    return { ...spec, email, password };
  });
  if (new Set(accounts.map(account => account.email)).size !== 3) throw new Error('Demo emails must be distinct');
  return db.transaction(async manager => {
    await manager.query('SELECT pg_advisory_xact_lock(42002026)');
    let created = 0;
    for (const account of accounts) {
      const repo = manager.getRepository(User);
      const existing = await repo.findOneBy({ email: account.email });
      if (existing) {
        if (existing.role !== account.role) throw new Error('An existing demo email has a different role; no changes applied');
        continue; // Never reset an existing password, reactivate users, or elevate privileges.
      }
      await repo.save(repo.create({ firstName: account.firstName, lastName: account.lastName, email: account.email,
        passwordHash: await hashPassword(account.password), role: account.role, status: UserStatus.ACTIVE }));
      created++;
    }
    return created;
  });
}
async function main() {
  const env = validateEnvironment(process.env);
  const db = new DataSource(databaseOptions(env));
  try { await db.initialize(); console.log(`Created ${await seedDemo(db, process.env)} fictional demo accounts. Existing accounts unchanged.`); }
  finally { if (db.isInitialized) await db.destroy(); }
}
if (require.main === module) void main().catch(() => { console.error('Demo seed failed. Check configuration, migrations, and demo email uniqueness.'); process.exitCode = 1; });
