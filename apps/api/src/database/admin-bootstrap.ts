import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { DataSource } from 'typeorm';
import { EnvironmentError, hasDatabaseUrlTlsOverride, validateEnvironment } from '../config/environment';
import { databaseOptions } from './options';
import { bootstrapAdmin, bootstrapIdentity, BootstrapError } from './bootstrap-admin';

// readline still handles editing/raw-mode cleanup, but its terminal output
// (including typed/pasted characters) is discarded instead of echoed.
export async function promptPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new BootstrapError('An interactive terminal is required. Use a Render shell or run locally; passwords in arguments, environment variables and piped input are not supported.');
  }
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  rl.on('SIGINT', cancel);
  rl.on('close', cancel);
  try {
    process.stderr.write('Initial password (hidden, 12–128 characters): ');
    const password = await rl.question('', { signal: controller.signal });
    process.stderr.write('\nConfirm password (hidden): ');
    const confirmation = await rl.question('', { signal: controller.signal });
    process.stderr.write('\n');
    if (password !== confirmation) throw new BootstrapError('Passwords do not match. No account was created.');
    return password;
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError('Password entry cancelled. No account was created.');
  } finally {
    rl.off('close', cancel);
    rl.close();
    process.stdin.pause();
    output.destroy();
  }
}

async function main() {
  if (process.argv.length !== 2) throw new BootstrapError('This command accepts no arguments. Set the three BOOTSTRAP_ADMIN_* identity variables and enter the password at the hidden prompt.');
  bootstrapIdentity(process.env);
  const env = validateEnvironment(process.env);
  // pg connection-string ssl parameters can override explicit TLS verification.
  // Require the normal configuration switch and prohibit URL overrides here.
  const url = new URL(env.DATABASE_URL);
  if (hasDatabaseUrlTlsOverride(url)) {
    throw new BootstrapError('Remove SSL parameters from DATABASE_URL and configure DATABASE_SSL instead. External connections require DATABASE_SSL=true.');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !env.DATABASE_SSL) {
    throw new BootstrapError('External database connections require DATABASE_SSL=true with certificate verification.');
  }
  let password = await promptPassword();
  const db = new DataSource({ ...databaseOptions(env), logging: false });
  try {
    await db.initialize();
    await bootstrapAdmin(db, process.env, password);
    console.log('First SYSTEM_ADMIN created successfully. No other accounts were changed.');
  } finally {
    password = ''; // Best effort only: JavaScript strings cannot be securely zeroed.
    if (db.isInitialized) await db.destroy();
  }
}

if (require.main === module) void main().catch((error: unknown) => {
  // Environment messages name settings and rules only, never values.
  console.error(error instanceof BootstrapError || error instanceof EnvironmentError ? error.message : 'Administrator bootstrap failed. Check configuration, connectivity and applied migrations privately. No error details are logged.');
  process.exitCode = 1;
});
