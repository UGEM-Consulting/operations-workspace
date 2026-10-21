const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 12) || major === 24)) {
  console.error(`Operations Workspace requires Node 22.12+ (22.x) or 24.x; currently running ${process.version}.`);
  console.error('From the repository root, run: nvm install && nvm use');
  console.error('Then restart with: npm run dev');
  process.exit(1);
}
