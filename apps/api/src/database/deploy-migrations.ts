import 'reflect-metadata';
import 'dotenv/config';
import { DataSource, MigrationExecutor, type Logger } from 'typeorm';
import { validateEnvironment } from '../config/environment';
import { databaseOptions } from './options';

// TypeORM logs migration exception messages even when logging=false. Never let
// raw migration/driver messages (which can contain data) reach deployment logs.
export const deploymentMigrationLogger: Logger = {
  logQuery: () => undefined, logQueryError: () => undefined,
  logQuerySlow: () => undefined, logSchemaBuild: () => undefined,
  logMigration: () => undefined, log: () => undefined,
};

// Use the same connection for the lock, history checks and migrations. A lost
// lock connection must also stop the migration transaction, not leave it running.
export async function applyPendingMigrations(db: DataSource): Promise<number> {
  const lock = db.createQueryRunner();
  let acquired = false;
  try {
    await lock.connect();
    await lock.query('SELECT pg_advisory_lock(42002027)');
    acquired = true;
    const executor = new MigrationExecutor(db, lock);
    executor.transaction = 'all';
    return (await executor.executePendingMigrations()).length;
  } finally {
    try {
      if (acquired && !lock.isReleased) await lock.query('SELECT pg_advisory_unlock(42002027)');
    } finally {
      await lock.release();
    }
  }
}

export async function runDeploymentMigrations(): Promise<void> {
  const options = databaseOptions(validateEnvironment(process.env));
  const db = new DataSource({ ...options, logging: false, logger: deploymentMigrationLogger,
    extra: { ...options.extra, statement_timeout: 60000, max: 1 } });
  try {
    await db.initialize();
    const count = await applyPendingMigrations(db);
    console.log(`Database migrations complete: ${count} applied.`);
  } finally {
    if (db.isInitialized) await db.destroy();
  }
}

if (require.main === module) void runDeploymentMigrations().catch(() => {
  console.error('Database migration failed. Startup blocked; sensitive details suppressed.');
  process.exitCode = 1;
});
