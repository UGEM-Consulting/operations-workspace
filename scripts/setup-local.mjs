import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
function load(path, example) { return existsSync(path) ? readFileSync(path, 'utf8') : readFileSync(example, 'utf8'); }
function value(text, key) { return text.split('\n').find(line => line.startsWith(`${key}=`))?.slice(key.length + 1); }
function ensure(text, key, fallback) { return value(text, key) ? text : text.replace(new RegExp(`^${key}=.*$`, 'm'), '').trimEnd() + `\n${key}=${fallback}\n`; }
const apiExisted = existsSync('apps/api/.env');
let api = load('apps/api/.env', 'apps/api/.env.example');
if (!apiExisted) api = api.replace('ALLOW_DEMO_SEED=false', 'ALLOW_DEMO_SEED=true');
let web = load('apps/web/.env.local', 'apps/web/.env.example');
if (value(api, 'NODE_ENV') === 'production') throw new Error('Local setup refuses production configuration');
const bff = value(api, 'BFF_SHARED_SECRET') || value(web, 'BFF_SHARED_SECRET') || randomBytes(32).toString('hex');
if (value(api, 'BFF_SHARED_SECRET') && value(web, 'BFF_SHARED_SECRET') && value(api, 'BFF_SHARED_SECRET') !== value(web, 'BFF_SHARED_SECRET')) throw new Error('Existing BFF secrets differ; reconcile them manually');
api = ensure(api, 'SESSION_SECRET', randomBytes(32).toString('hex'));
api = ensure(api, 'BFF_SHARED_SECRET', bff);
api = ensure(api, 'WEB_ORIGIN', 'http://localhost:3000');
api = ensure(api, 'SESSION_TTL_SECONDS', '28800');
web = ensure(web, 'BFF_SHARED_SECRET', bff);
web = ensure(web, 'WEB_ORIGIN', value(api, 'WEB_ORIGIN'));
api = ensure(api, 'ALLOW_DEMO_SEED', 'true');
for (const [role, email] of [['ADMIN', 'admin@example.test'], ['MANAGER', 'manager@example.test'], ['IT', 'it@example.test']]) {
  api = ensure(api, `DEMO_${role}_EMAIL`, email);
  api = ensure(api, `DEMO_${role}_PASSWORD`, randomBytes(24).toString('base64url'));
}
writeFileSync('apps/api/.env', api, { mode: 0o600 });
writeFileSync('apps/web/.env.local', web, { mode: 0o600 });
console.log('Local configuration ready. Read demo credentials privately in apps/api/.env; no secrets were printed. Existing values were preserved.');
