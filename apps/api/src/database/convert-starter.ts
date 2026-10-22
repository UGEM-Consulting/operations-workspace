import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../config/environment';
import { convertStarterIdentity } from '../modules/demo-email/isolation';
import { databaseOptions } from './options';
import { deploymentMigrationLogger } from './deploy-migrations';
async function main() {
  if (process.argv.length !== 2) throw new Error('Invalid arguments');
  const env = validateEnvironment(process.env);
  if (!env.DEMO_STARTER_MODE || !env.DEMO_EMAIL_MODE || env.DEPLOYMENT_PURPOSE !== 'demo') throw new Error('Demo configuration required');
  const db = await new DataSource({ ...databaseOptions(env), logger: deploymentMigrationLogger, logging: false }).initialize();
  try {
    await db.transaction(em => convertStarterIdentity(em, env));
    console.log('Starter converted to demo. Existing administrator preserved; sessions revoked. No onboarding data deleted.');
  } finally { await db.destroy(); }
}
if (require.main === module) void main().catch(() => {
  console.error('Starter conversion refused. Check demo configuration, migrations and starter eligibility privately. No data was changed.');
  process.exitCode = 1;
});
