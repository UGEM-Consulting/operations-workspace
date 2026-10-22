import { runDeploymentMigrations } from './database/deploy-migrations';

export async function startAfterMigrations(migrate: () => Promise<void>, start: () => Promise<unknown>): Promise<void> {
  await migrate();
  await start();
}

if (require.main === module) void startAfterMigrations(runDeploymentMigrations, () => import('./main')).catch(() => {
  console.error('Render startup failed. Check configuration and migrations privately; sensitive details suppressed.');
  process.exitCode = 1;
});
