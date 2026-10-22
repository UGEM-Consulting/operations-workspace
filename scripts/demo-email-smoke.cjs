// Explicit local-only fictional end-to-end check. Builds must exist; no hosted targets.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { DataSource } = require('typeorm');
const { databaseOptions } = require('../apps/api/dist/database/options');
const { validateEnvironment } = require('../apps/api/dist/config/environment');
const { initializeDemoIdentity, convertStarterIdentity } = require('../apps/api/dist/modules/demo-email/isolation');
const { User, Role } = require('../apps/api/dist/modules/users/user.entity');
const { hashPassword } = require('../apps/api/dist/modules/auth/password');
const { deploymentMigrationLogger } = require('../apps/api/dist/database/deploy-migrations');
let stage = 'configuration', db, api, web, directory;
const starter = process.env.DEMO_SMOKE_STARTER === 'true';
const origin = starter ? 'https://workspace.example.test' : 'https://workspace-demo.example.test';
const accountEmail = role => starter && role === Role.SYSTEM_ADMIN ? 'operator@company.example' : `${role.toLowerCase()}@example.test`;
const frontend = 'http://127.0.0.1:3012';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function client() {
  const cookies = new Map();
  return async (path, method = 'GET', body) => {
    const response = await fetch(frontend + path, { method, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { origin, 'content-type': 'application/json', 'x-csrf-protection': '1', cookie: [...cookies].map(([key,value]) => `${key}=${value}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], at = pair.indexOf('='); cookies.set(pair.slice(0,at), pair.slice(at+1)); }
    return response;
  };
}
async function result(response, status = 201) { assert.equal(response.status, status, `Unexpected status at ${stage}`); return response.json(); }
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    if (api?.exitCode !== null || web?.exitCode !== null) throw new Error('Local server exited');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* startup */ }
    await sleep(500);
  }
  throw new Error('Local server startup timeout');
}
(async () => {
  assert.equal(process.env.ALLOW_DISPOSABLE_DB_RESET, 'true');
  const url = new URL(process.env.DEMO_TEST_DATABASE_URL);
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname) && url.pathname.endsWith('_demo_test'));
  directory = mkdtempSync(join(tmpdir(), 'ugem-demo-email-'));
  const key = join(directory, 'key.pem'), certificate = join(directory, 'cert.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',certificate,'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const env = { ...process.env, NODE_ENV: 'production', DEPLOYMENT_PURPOSE: 'demo', DEMO_EMAIL_MODE: 'true', DEMO_STARTER_MODE: String(starter), DEMO_FICTIONAL_DATA_ONLY: 'true',
    DEMO_DEPLOYMENT_ID: randomUUID(), DEMO_MAILBOX_KEY: randomBytes(32).toString('base64'), DATABASE_URL: url.toString(), DATABASE_SSL: 'false',
    SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'),
    WEB_ORIGIN: origin, CORS_ORIGINS: origin, PORT: '4012', API_BASE_URL: 'https://127.0.0.1:4012', NODE_EXTRA_CA_CERTS: certificate,
    DEMO_TEST_KEY_PATH: key, DEMO_TEST_CERT_PATH: certificate };
  db = await new DataSource({ ...databaseOptions(validateEnvironment(env)), logger: deploymentMigrationLogger, logging: false }).initialize();
  await db.runMigrations();
  await db.query("UPDATE deployment_identity SET purpose='unassigned', mode='isolated', \"operatorAdminId\"=NULL, \"deploymentId\"=NULL, \"webOrigin\"=NULL");
  await db.query('TRUNCATE users, staff_sessions, applicant_sessions, login_attempts, deployment_activity CASCADE');
  const password = randomBytes(24).toString('base64url'), passwordHash = await hashPassword(password);
  const saveAccount = role => db.getRepository(User).save({ firstName: 'Fictional', lastName: 'Smoke', email: accountEmail(role), role, status: 'ACTIVE', passwordHash });
  for (const role of starter ? [Role.SYSTEM_ADMIN] : Object.values(Role)) await saveAccount(role);
  await db.transaction(em => starter ? convertStarterIdentity(em, validateEnvironment(env)) : initializeDemoIdentity(em, validateEnvironment(env)));
  if(starter)for(const role of [Role.DISPATCHER_MANAGER,Role.IT_SPECIALIST])await saveAccount(role);
  const harness = `const {readFileSync}=require('node:fs');const {NestFactory}=require('@nestjs/core');const {AppModule}=require('./apps/api/dist/app.module');const {configureApp}=require('./apps/api/dist/common/configure-app');const {installSessions}=require('./apps/api/dist/modules/auth/session');const {validateEnvironment}=require('./apps/api/dist/config/environment');(async()=>{const app=await NestFactory.create(AppModule,{logger:false,httpsOptions:{key:readFileSync(process.env.DEMO_TEST_KEY_PATH),cert:readFileSync(process.env.DEMO_TEST_CERT_PATH)}});installSessions(app,validateEnvironment(process.env));configureApp(app,process.env.CORS_ORIGINS);await app.listen(4012,'127.0.0.1')})().catch(()=>process.exit(1));`;
  api = spawn(process.execPath, ['-e', harness], { cwd: resolve(__dirname, '..'), env, stdio: 'ignore' });
  web = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start','--hostname','127.0.0.1','--port','3012'], { cwd: resolve(__dirname, '../apps/web'), env, stdio: 'ignore' });
  stage = 'local server readiness';
  for (let i=0;i<60;i++) {
    const healthy=await new Promise(resolve=>{
      const req=require('node:https').get('https://127.0.0.1:4012/api/health',{ca:readFileSync(certificate)},res=>{res.resume();resolve(res.statusCode===200);});
      req.on('error',()=>resolve(false));req.setTimeout(1000,()=>{req.destroy();resolve(false);});
    });
    if(healthy)break;
    if(i===59)throw new Error('API readiness timeout');
    await sleep(500);
  }
  await ready(frontend + '/login');
  const admin = client(), manager = client(), applicant = client();
  stage = 'banner on login and public applicant routes';
  for (const path of ['/login','/apply/resume','/apply/draft']) {
    const html=await (await applicant(path)).text();assert.ok(html.includes('Demo Environment') && html.includes('Fictional Data Only'));
  }
  stage = 'production-cookie staff login';
  for (const [agent, role] of [[admin, Role.SYSTEM_ADMIN], [manager, Role.DISPATCHER_MANAGER]]) await result(await agent('/api/backend/auth/login','POST',{ email: accountEmail(role), password }),200);
  stage = 'invitation and fictional challenge'; const invitation = await result(await manager('/api/backend/onboarding/invitations','POST',{}));
  const token = invitation.url.split('/').pop();
  const challenge = await result(await applicant('/api/backend/applicant/begin','POST',{ token, email:'smoke.applicant@example.test' }));
  assert.deepEqual(Object.keys(challenge).sort(), ['challengeId','message']);
  stage = 'admin mailbox and banner';
  const page = await admin('/settings/demo-mailbox'); assert.equal(page.status,200); const html = await page.text();
  assert.ok(html.includes('Demo Environment') && html.includes('Fictional Data Only') && html.includes('smoke.applicant@example.test'));
  const messages = await result(await admin('/api/backend/demo-mailbox'),200); const message = messages.find(row => row.challengeId===challenge.challengeId); assert.ok(message);
  assert.equal((await manager('/api/backend/demo-mailbox')).status,403); assert.equal((await applicant('/api/backend/demo-mailbox')).status,401);
  stage = 'authorized reveal and applicant verification';
  const delivery = await result(await admin(`/api/backend/demo-mailbox/${message.id}/reveal`,'POST',{}));
  assert.ok(!html.includes(delivery.code));
  await result(await applicant('/api/backend/applicant/verify','POST',{ challengeId:challenge.challengeId, code:delivery.code }));
  stage = 'draft and submission';
  const fields={firstName:'Fictional',lastName:'Applicant',personalPhoneNumber:'+1 202 555 0123',workPhoneNumber:'+44 20 7946 0958',preferredAmericanFirstName:'Alex',preferredAmericanLastName:'Demo',mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'};
  await result(await applicant('/api/backend/applicant/draft','PATCH',{version:0,...fields}),200);
  await result(await applicant('/api/backend/applicant/submit','POST',{version:1,...fields,accurate:true}));
  stage = 'one-time code privacy';
  await result(await admin(`/api/backend/demo-mailbox/${message.id}/reveal`,'POST',{}),404);
  const application=await result(await applicant('/api/backend/applicant/application'),200);assert.equal(application.application.status,'SUBMITTED');
  console.log('PASS: '+(starter?'converted starter':'isolated')+' production-runtime demo API + Next.js BFF, secure staff/applicant cookies, fictional banner, restricted mailbox, audited reveal, one-time verification, draft and submission. No codes or credentials logged.');
})().catch(() => { console.error(`Demo email smoke failed at ${stage}; sensitive details suppressed.`); process.exitCode=1; }).finally(async () => {
  const children=[web,api].filter(Boolean);
  for(const child of children) if(child.exitCode===null)child.kill('SIGTERM');
  for(const child of children) if(child.exitCode===null)await new Promise(resolve => {const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  if(db?.isInitialized)await db.destroy();
  if(directory)rmSync(directory,{recursive:true,force:true});
});
