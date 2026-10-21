import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('loads the verification command with ts-node lazy type checking', () => {
  // A full tsc/Jest program can mask missing augmentation imports in standalone commands.
  // Importing the command does not execute its main block or issue any verification codes.
  expect(() => execFileSync(process.execPath, [
    '-r', require.resolve('ts-node/register'),
    '-e', "require('./src/database/demo-verification')",
  ], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, TS_NODE_FILES: 'false', TS_NODE_TRANSPILE_ONLY: 'false' },
    stdio: 'pipe',
    timeout: 20000,
  })).not.toThrow();
}, 25000);
