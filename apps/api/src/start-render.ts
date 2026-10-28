import { runDeploymentMigrations } from './database/deploy-migrations';
import { startupFailureReason } from './startup-failure';
export { startupFailureReason };

export async function startAfterMigrations(migrate: () => Promise<void>, start: () => Promise<unknown>): Promise<void> {
  await migrate();
  await start();
}

// main is imported only after migrations, and its bootstrap is awaited here so Nest initialization and listen
// failures also reach this sanitised handler instead of an unhandled rejection with raw database details.
if (require.main === module) void startAfterMigrations(runDeploymentMigrations, async () => (await import('./main')).bootstrap()).catch((error: unknown) => {
  console.error(`Render startup failed: ${startupFailureReason(error)}`);
  process.exitCode = 1;
  // Open connections must not keep a failed instance alive.
  setTimeout(() => process.exit(1), 5000).unref();
});
