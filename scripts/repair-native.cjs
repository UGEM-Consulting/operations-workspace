// Some macOS prebuilt Argon2 binaries crash when loaded by early Node 22.
// Keep the same package and hashing implementation; rebuild only when needed.
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const installing = process.argv.includes('--install');
const needsMacBuild = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) === 22;
if (!installing && !needsMacBuild) process.exit(0);
const root = path.resolve(__dirname, '..');
// Web-only installations need no API native dependency.
if (!installing) {
  try { require.resolve('argon2', { paths: [path.join(root, 'apps/api')] }); } catch { process.exit(0); }
}
function canLoad() {
  return spawnSync(process.execPath, ['-e', "require('argon2')"], {
    cwd: path.join(root, 'apps/api'), stdio: 'ignore', timeout: 15000,
  }).status === 0;
}
if (!installing && canLoad()) process.exit(0);
if (!installing) console.log('Rebuilding Argon2 for the current Node 22/macOS runtime.');
const env = { ...process.env };
if (needsMacBuild) {
  const sdk = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8', timeout: 10000 });
  if (sdk.status !== 0) {
    console.error('Native repair requires Xcode Command Line Tools and Python. Install them, then run npm run repair:native.');
    process.exit(1);
  }
  const headers = path.join(sdk.stdout.trim(), 'usr/include/c++/v1');
  if (!installing) env.npm_config_build_from_source = 'true';
  // Some Command Line Tools installations omit this SDK directory from C++ search paths.
  if (existsSync(headers)) env.CXXFLAGS = `${env.CXXFLAGS || ''} -isystem "${headers}"`;
}
if (!process.env.npm_execpath) {
  console.error('Run this repair using npm run repair:native.');
  process.exit(1);
}
const result = spawnSync(process.execPath, [process.env.npm_execpath, ...(installing ? ['ci', '--prefer-offline'] : ['rebuild', 'argon2'])], {
  cwd: root, env, stdio: 'inherit', timeout: 300000,
});
if (result.status !== 0 || (!installing && !canLoad())) {
  console.error(installing ? 'Dependency installation failed. Resolve the npm error above, then rerun npm run setup:dependencies.' : 'Argon2 native repair failed. Check the local compiler/Python installation, then run npm run repair:native again.');
  process.exit(1);
}
console.log(installing ? 'Dependencies installed successfully.' : 'Argon2 now loads successfully.');
