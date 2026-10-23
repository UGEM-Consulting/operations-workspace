// Local fictional HTTP smoke test. Creates one reviewable demo record; never targets deployed services.
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const { parse } = require('dotenv');
const { DataSource } = require('typeorm');
const { databaseOptions } = require('../apps/api/dist/database/options.js');
const { validateEnvironment } = require('../apps/api/dist/config/environment.js');
const { issueDemoCode } = require('../apps/api/dist/database/demo-verification.js');
const env = parse(readFileSync('apps/api/.env'));
const origin = 'http://localhost:3000';
let stage = 'local configuration';
function client() {
 const jar = new Map();
 return async (path, method = 'GET', body) => {
  const response = await fetch(origin + path, { method, headers: {
   origin, 'content-type':'application/json', 'x-csrf-protection':'1',
   cookie:[...jar].map(([name,value])=>`${name}=${value}`).join('; '),
  }, body:body===undefined?undefined:JSON.stringify(body), redirect:'manual' });
  for (const cookie of response.headers.getSetCookie()) { const pair=cookie.split(';')[0], split=pair.indexOf('=');jar.set(pair.slice(0,split),pair.slice(split+1)); }
  return response;
 };
}
async function expected(response,status) { assert.equal(response.status,status,`Unexpected HTTP status at ${stage}`);return response.json(); }
(async()=>{
 assert.equal(process.env.ALLOW_LOCAL_REVIEW_SMOKE,'true');
 assert.equal(env.NODE_ENV,'development');assert.equal(env.WEB_ORIGIN,origin);
 assert.ok(['localhost','127.0.0.1'].includes(new URL(env.DATABASE_URL).hostname));
 const manager=client(),applicant=client();
 stage='manager login';await expected(await manager('/api/backend/auth/login','POST',{email:env.DEMO_MANAGER_EMAIL,password:env.DEMO_MANAGER_PASSWORD}),200);
 stage='invitation creation';const invitation=await expected(await manager('/api/backend/onboarding/invitations','POST',{}),201);
 const db=await new DataSource(databaseOptions(validateEnvironment(env))).initialize();
 try {
  async function verify(body) {
   const challenge=await expected(await applicant('/api/backend/applicant/begin','POST',body),201);
   const code=await issueDemoCode(db,challenge.challengeId,'development');
   return expected(await applicant('/api/backend/applicant/verify','POST',{challengeId:challenge.challengeId,code}),201);
  }
  stage='initial verification';const identity=await verify({email:'review.smoke@example.test',token:invitation.url.split(/[/#]/).pop()});
  const id=identity.applicationId;
  const fields={firstName:'Fictional',lastName:'Review Demo',personalPhoneNumber:'+1 202 555 0141',workPhoneNumber:'+996 (555) 123-456',preferredAmericanFirstName:'Alex',preferredAmericanLastName:'Demo',telegram:'fictional_review',mcName:'Fictional applicant MC',teamLead:'Independent',jobTitle:'Dispatcher'};
  stage='draft and submission';await expected(await applicant('/api/backend/applicant/draft','PATCH',{version:0,...fields}),200);
  await expected(await applicant('/api/backend/applicant/submit','POST',{version:1,...fields,accurate:true}),201);
  stage='request corrections';await expected(await manager(`/api/backend/onboarding/applications/${id}/reviews`,'POST',{version:2,decisionType:'REQUEST_CHANGES',reason:'Please correct your Telegram tag.',requestedFields:['telegram']}),201);
  stage='fresh returning verification';await expected(await applicant('/api/backend/applicant/logout','POST',{}),201);
  await verify({applicationId:id,email:'review.smoke@example.test'});
  const own=await expected(await applicant('/api/backend/applicant/application'),200);assert.deepEqual(own.editableFields,['telegram']);
  stage='save private corrections';await expected(await applicant('/api/backend/applicant/draft','PATCH',{version:3,telegram:'corrected_fictional_review'}),200);
  const pending=await expected(await manager(`/api/backend/onboarding/applications/${id}`),200);assert.equal(pending.application.fields.telegram,fields.telegram);
  stage='resubmit';await expected(await applicant('/api/backend/applicant/submit','POST',{version:4,accurate:true}),201);
  stage='manager comparison';const reviewed=await expected(await manager(`/api/backend/onboarding/applications/${id}`),200);assert.equal(reviewed.submissions.length,2);assert.equal(reviewed.application.status,'RESUBMITTED');
  assert.equal(reviewed.application.fields.personalPhoneNumber,fields.personalPhoneNumber);assert.equal(reviewed.application.fields.workPhoneNumber,fields.workPhoneNumber);assert.equal(reviewed.itDetails.proposedDisplayName,'Alex Demo');assert.equal(reviewed.itDetails.legalFirstName,'Fictional');
  const page=await manager(`/onboarding/applications/${id}`);assert.equal(page.status,200);const html=await page.text();assert.ok(html.includes('corrected_fictional_review'));for(const label of ['Work Phone Number','Personal Phone Number','American First Name','American Last Name'])assert.ok(html.includes(label));
  stage='approve';await expected(await manager(`/api/backend/onboarding/applications/${id}/reviews`,'POST',{version:5,decisionType:'APPROVE',confirmed:true,employmentConfirmed:true,employment:{mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'},reason:'Internal smoke approval note'}),201);
  stage='IT login';const it=client();await expected(await it('/api/backend/auth/login','POST',{email:env.DEMO_IT_EMAIL,password:env.DEMO_IT_PASSWORD}),200);
  const approved=await expected(await manager(`/api/backend/onboarding/applications/${id}`),200);assert.ok(approved.itOnboarding?.id);const requestId=approved.itOnboarding.id;
  stage='approved-only IT profile';let setup=await expected(await it(`/api/backend/it/onboarding/${requestId}`),200);assert.equal(setup.tasks.length,6);assert.equal(setup.request.profile.proposedDisplayName,'Alex Demo');assert.equal(setup.request.profile.mcName,'Independent');assert.equal(setup.request.profile.workPhoneNumber,fields.workPhoneNumber);
  assert.equal(setup.request.workPhoneVerifiedAt,null);assert.ok(!JSON.stringify(setup).includes('Internal smoke approval note'));
  assert.equal((await it('/it/tasks')).status,200);const itPage=await it(`/it/tasks/${requestId}`);assert.equal(itPage.status,200);assert.ok((await itPage.text()).includes('Applicant Provided'));
  stage='IT manual phone verification';setup=await expected(await it(`/api/backend/it/onboarding/${requestId}/contact`,'PATCH',{version:setup.request.version,workPhoneVerified:true,assignedRingCentralPhoneNumber:'+1 202 555 0190'}),200);
  assert.equal(setup.request.profile.personalPhoneNumber,fields.personalPhoneNumber);assert.equal(setup.request.profile.workPhoneNumber,fields.workPhoneNumber);
  stage='IT manual checklist completion';for(const task of setup.tasks)setup=await expected(await it(`/api/backend/it/onboarding/${requestId}/tasks/${task.key}`,'PATCH',{version:setup.request.version,status:'COMPLETED',notes:'Fictional manual setup confirmed; no external actions taken.'}),200);
  assert.equal(setup.request.status,'COMPLETED');stage='manager portal notification';const notifications=await expected(await manager('/api/backend/notifications'),200);const notification=notifications.items.find(item=>item.requestId===requestId);assert.ok(notification);assert.equal(notification.displayName,'Alex Demo');
  const managerPage=await manager('/onboarding');assert.equal(managerPage.status,200);assert.ok((await managerPage.text()).includes('IT onboarding completed'));
  await expected(await manager(`/api/backend/notifications/${notification.id}/read`,'POST',{}),201);
  stage='approved queue and privacy';const queue=await expected(await manager('/api/backend/onboarding/review-queue?status=APPROVED&search=review.smoke%40example.test&pageSize=1'),200);assert.equal(queue.items[0].status,'APPROVED');
  const final=await expected(await applicant('/api/backend/applicant/application'),200);assert.equal(final.application.status,'APPROVED');assert.equal(final.canEdit,false);assert.ok(!JSON.stringify(final).includes('Internal smoke approval note'));
  for (const path of ['/onboarding','/onboarding/applications?status=APPROVED',`/onboarding/applications/${id}`,'/dashboard']) assert.equal((await manager(path)).status,200);
  assert.equal((await fetch('http://localhost:4000/api/health')).status,200);
  console.log('PASS: Next.js â†’ NestJS invitation, verification, submission, correction request, fresh verification, private draft, resubmission, comparison, approval, IT phone verification/checklist completion, portal notification, filtered queues, and health.');
 } finally { await db.destroy(); }
})().catch(()=>{console.error(`Review smoke failed at ${stage}; no credentials or applicant details printed.`);process.exitCode=1;});
