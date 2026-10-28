import 'reflect-metadata';
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { DataSource } from 'typeorm';
import { hasDatabaseUrlTlsOverride, type Environment } from '../config/environment';
import { databaseOptions } from './options';

// One-time operator command for a database that was converted to the retired fictional demo.
// It deletes the fictional demo records, keeps the starter operator administrator, and removes
// the demo marking so RetireDemoDeployment1792690000000 can then drop the demo schema on deploy.
// Never run from startup, migrations or HTTP. Prints counts only, never addresses or record data.
export class RetirementError extends Error {}
// All workflow, session and demo-mailbox data. Every row was created under the demo's
// fictional-address triggers. One TRUNCATE without CASCADE fails rather than reaching other tables.
const DEMO_DATA_TABLES = ['portal_notifications', 'it_onboarding_activity', 'it_onboarding_tasks', 'it_onboarding_requests',
  'application_submissions', 'application_reviews', 'application_activity', 'demo_mailbox', 'applicant_challenges',
  'dispatcher_applications', 'invitations', 'applicant_sessions', 'staff_sessions', 'login_attempts'];
const FICTIONAL = /^[^@]+@example\.test$/;
export interface RetirementReport { keptAdministrator: boolean; deletedStaff: number; invitations: number; applications: number; itRequests: number; notifications: number; }

export async function retireDemoDatabase(db: DataSource, apply: boolean): Promise<RetirementReport> {
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction('READ COMMITTED');
  try {
    if (!(await runner.query(`SELECT to_regclass('public.deployment_identity') AS name`))[0].name) throw new RetirementError('This database has no demo marking. Nothing to retire; nothing was changed.');
    // Serialize with administrator updates/bootstrap and with deployment migration runners.
    await runner.query('SELECT pg_advisory_xact_lock(42002026)');
    await runner.query('SELECT pg_advisory_xact_lock(42002027)');
    await runner.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const [marking] = await runner.query('SELECT purpose, mode, "operatorAdminId" FROM deployment_identity WHERE id=true FOR UPDATE');
    if (marking?.purpose !== 'demo') throw new RetirementError('This database is not marked as the demo deployment. Nothing to retire; nothing was changed.');
    const operatorId: string | null = marking.mode === 'starter' ? marking.operatorAdminId : null;
    const users: { id: string; email: string; role: string; status: string }[] = await runner.query('SELECT id, email, role, status FROM users');
    const operator = users.find(user => user.id === operatorId);
    if (operatorId && (!operator || operator.role !== 'SYSTEM_ADMIN' || operator.status !== 'ACTIVE')) throw new RetirementError('The preserved demo operator is missing or no longer an active administrator. Nothing was changed.');
    const others = users.filter(user => user.id !== operatorId);
    if (others.some(user => !FICTIONAL.test(user.email))) throw new RetirementError('Found a staff account with a non-fictional address besides the preserved administrator. Refusing to delete it; nothing was changed.');
    const count = async (table: string) => Number((await runner.query(`SELECT count(*)::integer AS n FROM ${table}`))[0].n);
    const report: RetirementReport = { keptAdministrator: !!operator, deletedStaff: others.length, invitations: await count('invitations'),
      applications: await count('dispatcher_applications'), itRequests: await count('it_onboarding_requests'), notifications: await count('portal_notifications') };
    if (!apply) { await runner.rollbackTransaction(); return report; }
    await runner.query(`TRUNCATE ${DEMO_DATA_TABLES.join(', ')}`);
    await runner.query('DELETE FROM users WHERE id <> ALL($1::uuid[])', [operatorId ? [operatorId] : []]);
    // Sessions were truncated; the version bump also rejects any in-flight login.
    if (operatorId) await runner.query('UPDATE users SET "authVersion" = "authVersion" + 1 WHERE id = $1', [operatorId]);
    await runner.query(`UPDATE deployment_identity SET purpose='production', mode='isolated', "operatorAdminId"=NULL, "deploymentId"=NULL, "webOrigin"=NULL WHERE id=true`);
    await runner.commitTransaction();
    return report;
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

function connection(input: NodeJS.ProcessEnv) {
  let url: URL;
  try { url = new URL(input.DATABASE_URL ?? ''); } catch { throw new RetirementError('Set DATABASE_URL to the database to clean up.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new RetirementError('DATABASE_URL must be a PostgreSQL URL.');
  if (hasDatabaseUrlTlsOverride(url)) throw new RetirementError('Remove SSL parameters from DATABASE_URL and set DATABASE_SSL=true instead.');
  const ssl = input.DATABASE_SSL === 'true';
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !ssl) throw new RetirementError('External database connections require DATABASE_SSL=true with certificate verification.');
  return { url, env: { DATABASE_URL: url.toString(), DATABASE_SSL: ssl } as Environment };
}
const summary = (report: RetirementReport) => [
  `  Administrator account kept: ${report.keptAdministrator ? 'yes (you will need to sign in again)' : 'none (run admin:bootstrap afterwards)'}`,
  `  Fictional staff accounts deleted: ${report.deletedStaff}`,
  `  Invitations: ${report.invitations}, applications: ${report.applications}, IT requests: ${report.itRequests}, notifications: ${report.notifications}`,
].join('\n');

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) throw new RetirementError('Usage: demo:retire-database [--apply]. Without --apply it only reports what would be deleted.');
  const apply = args[0] === '--apply';
  const { url, env } = connection(process.env);
  const name = decodeURIComponent(url.pathname.slice(1));
  const db = new DataSource({ ...databaseOptions(env), logging: false });
  await db.initialize();
  try {
    const preview = await retireDemoDatabase(db, false);
    console.log(`Demo database "${name}" would be cleaned up:\n${summary(preview)}`);
    if (!apply) { console.log('Dry run only: nothing was changed. Take a backup, then rerun with --apply.'); return; }
    if (!process.stdin.isTTY) throw new RetirementError('--apply needs an interactive terminal to confirm. Nothing was changed.');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const typed = await rl.question(`Type the database name (${name}) to permanently delete this demo data: `).finally(() => rl.close());
    if (typed.trim() !== name) throw new RetirementError('Confirmation did not match. Nothing was changed.');
    const result = await retireDemoDatabase(db, true);
    console.log(`Done. Deleted:\n${summary(result)}\nThe demo marking is removed. Deploy the API: its migration drops the remaining demo tables.`);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) void main().catch((error: unknown) => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  console.error(error instanceof RetirementError ? error.message
    : `Demo database cleanup failed${/^[0-9A-Z]{5}$|^E[A-Z]+$/.test(code) ? ` (${code})` : ''}. Nothing was committed; details suppressed.`);
  process.exitCode = 1;
});
