import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../src/config/environment';
import { databaseOptions } from '../src/database/options';
import { configureApp } from '../src/common/configure-app';
import { AuthModule } from '../src/modules/auth/auth.module';
import { installSessions } from '../src/modules/auth/session';
import { hashPassword } from '../src/modules/auth/password';
import { User, Role, UserStatus } from '../src/modules/users/user.entity';
import { OnboardingModule } from '../src/modules/onboarding/onboarding.module';
import { Invitation, DispatcherApplication, ApplicationActivity } from '../src/modules/onboarding/entities';
import { issueDemoCode } from '../src/database/demo-verification';
import { digest } from '../src/modules/onboarding/onboarding.service';
const integration=process.env.TEST_DATABASE_URL?describe:describe.skip;
integration('Dispatcher invitation workflow (disposable PostgreSQL)',()=>{
 let app:INestApplication,db:DataSource,closeSessions:()=>Promise<void>;
 const password=randomBytes(24).toString('base64url');
 const env=validateEnvironment({NODE_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_URL??'postgresql://localhost/operations_m2_test',CORS_ORIGINS:'http://localhost:3000',WEB_ORIGIN:'http://localhost:3000',SESSION_SECRET:randomBytes(32).toString('hex'),BFF_SHARED_SECRET:randomBytes(32).toString('hex')});
 const headers={'x-workspace-key':env.BFF_SHARED_SECRET,origin:env.WEB_ORIGIN,'x-csrf-protection':'1'};
 type Agent=ReturnType<typeof request.agent>;
 let manager:Agent,other:Agent,admin:Agent,itAgent:Agent;
 const payload={email:'fictional.applicant@example.test',mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher',expirationDays:7,telegramRequired:true};
 const answers={firstName:'Fictional',lastName:'Applicant',personalPhoneNumber:'+1 202 555 0123',workPhoneNumber:'+44 (20) 7946 0958',preferredAmericanFirstName:'Alex',preferredAmericanLastName:'Demo',telegram:'fictional_demo',accurate:true};
 async function create(){const result=await manager.post('/api/onboarding/invitations').set(headers).send(payload).expect(201);return {id:result.body.id as string,token:result.body.url.split('/').pop() as string};}
 async function verify(agent:Agent,token:string){const begin=await agent.post('/api/applicant/begin').set(headers).send({email:payload.email,token}).expect(201);const code=await issueDemoCode(db,begin.body.challengeId,'test');const response=await agent.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code}).expect(201);return {id:response.body.applicationId as string,challengeId:begin.body.challengeId as string,code};}
 beforeAll(async()=>{
  if(!new URL(env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
  db=await new DataSource(databaseOptions(env)).initialize();await db.runMigrations();await db.query('TRUNCATE users,staff_sessions,applicant_sessions,login_attempts CASCADE');
  const hash=await hashPassword(password);
  for(const [index,role] of [Role.DISPATCHER_MANAGER,Role.DISPATCHER_MANAGER,Role.SYSTEM_ADMIN,Role.IT_SPECIALIST].entries())await db.getRepository(User).save({firstName:'Fictional',lastName:'Staff',email:`staff${index}@example.test`,role,status:UserStatus.ACTIVE,passwordHash:hash});
  const module=await Test.createTestingModule({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true,load:[()=>env]}),TypeOrmModule.forRoot(databaseOptions(env)),AuthModule,OnboardingModule]}).compile();
  app=module.createNestApplication();closeSessions=installSessions(app,env);configureApp(app,env.CORS_ORIGINS);await app.init();
  const agents=[];for(let i=0;i<4;i++){const agent=request.agent(app.getHttpServer());await agent.post('/api/auth/login').set(headers).send({email:`staff${i}@example.test`,password}).expect(200);agents.push(agent);}[manager,other,admin,itAgent]=agents;
 },30000);
 beforeEach(async()=>{await db.query('TRUNCATE invitations,applicant_sessions,login_attempts CASCADE');});
 afterAll(async()=>{if(closeSessions)await closeSessions();if(app)await app.close();if(db?.isInitialized)await db.destroy();});
 it('allows managers/admins and denies IT, unauthenticated users, and CSRF',async()=>{
  await admin.post('/api/onboarding/invitations').set(headers).send(payload).expect(201);
  await itAgent.post('/api/onboarding/invitations').set(headers).send(payload).expect(403);
  await request(app.getHttpServer()).post('/api/onboarding/invitations').set(headers).send(payload).expect(401);
  await manager.post('/api/onboarding/invitations').set({...headers,origin:'https://evil.example'}).send(payload).expect(403);
  await manager.post('/api/onboarding/invitations').set(headers).send({...payload,managerId:randomBytes(16).toString('hex')}).expect(400);
  await manager.post('/api/onboarding/invitations').set(headers).send({...payload,email:'real@company.com'}).expect(400);
 });
 it('stores only token hashes, creates one application, and scopes listings',async()=>{
  const inv=await create();const stored=await db.getRepository(Invitation).createQueryBuilder('i').addSelect('i.tokenHash').where('i.id=:id',{id:inv.id}).getOneOrFail();expect(stored.tokenHash).toBe(digest(inv.token));
  expect(await db.getRepository(DispatcherApplication).count()).toBe(1);
  const list=await manager.get('/api/onboarding/invitations').set(headers).expect(200);expect(list.body[0].status).toBe('PENDING');expect(list.body[0].tokenHash).toBeUndefined();
  expect((await other.get('/api/onboarding/invitations').set(headers)).body).toHaveLength(0);
  expect((await admin.get('/api/onboarding/invitations').set(headers)).body).toHaveLength(1);
  await other.post(`/api/onboarding/invitations/${inv.id}/revoke`).set(headers).send({}).expect(404);
 });
 it('does not reveal invited addresses or sensitive details before verification',async()=>{
  const inv=await create();const agent=request.agent(app.getHttpServer());
  await agent.get('/api/applicant/application').set(headers).expect(401);
  const wrong=await agent.post('/api/applicant/begin').set(headers).send({token:inv.token,email:'unknown@example.test'}).expect(201);
  const right=await agent.post('/api/applicant/begin').set(headers).send({token:inv.token,email:payload.email}).expect(201);
  expect(wrong.body.message).toBe(right.body.message);expect(right.body.email).toBeUndefined();
  await expect(issueDemoCode(db,wrong.body.challengeId,'test')).rejects.toThrow();
  await expect(issueDemoCode(db,right.body.challengeId,'production')).rejects.toThrow();
  await agent.post('/api/applicant/verify').set(headers).send({challengeId:right.body.challengeId,code:'not-a-code'}).expect(400);
 });
 it('expires and revokes invitations including previously verified sessions',async()=>{
  const inv=await create();const agent=request.agent(app.getHttpServer());await verify(agent,inv.token);
  await manager.post(`/api/onboarding/invitations/${inv.id}/revoke`).set(headers).send({}).expect(201);
  await agent.get('/api/applicant/application').set(headers).expect(401);
  const second=await create();await db.getRepository(Invitation).update(second.id,{expiresAt:new Date(Date.now()-1000)});
  const begin=await agent.post('/api/applicant/begin').set(headers).send({email:payload.email,token:second.token}).expect(201);
  await expect(issueDemoCode(db,begin.body.challengeId,'test')).rejects.toThrow();
  const list=await manager.get('/api/onboarding/invitations').set(headers);expect(list.body.map((i:{status:string})=>i.status)).toEqual(expect.arrayContaining(['EXPIRED','REVOKED']));
 });
 it('saves, resumes with fresh verification, submits once, and enforces manager ownership',async()=>{
  const inv=await create();const applicant=request.agent(app.getHttpServer());const verified=await verify(applicant,inv.token);
  await applicant.post('/api/applicant/verify').set(headers).send({challengeId:verified.challengeId,code:verified.code}).expect(401);
  await applicant.patch('/api/applicant/draft').set(headers).send({version:0,firstName:'Fictional'}).expect(200);
  await applicant.patch('/api/applicant/draft').set(headers).send({version:0,firstName:'Stale'}).expect(409);
  const draft=await applicant.get('/api/applicant/application').set(headers).expect(200);expect(draft.body.application.fields.firstName).toBe('Fictional');expect(draft.body.invitation.tokenHash).toBeUndefined();
  expect((await manager.get('/api/onboarding/applications').set(headers)).body[0].fields).toEqual({});
  await applicant.post('/api/applicant/logout').set(headers).send({}).expect(201);await applicant.get('/api/applicant/application').set(headers).expect(401);
  const resume=await applicant.post('/api/applicant/begin').set(headers).send({email:payload.email,applicationId:verified.id}).expect(201);
  const code=await issueDemoCode(db,resume.body.challengeId,'test');await applicant.post('/api/applicant/verify').set(headers).send({challengeId:resume.body.challengeId,code}).expect(201);
  await applicant.post('/api/applicant/submit').set(headers).send({version:1,accurate:true}).expect(400);
  await applicant.post('/api/applicant/submit').set(headers).send({...answers,telegram:'',version:1}).expect(400);
  const results=await Promise.all([1,2].map(()=>applicant.post('/api/applicant/submit').set(headers).send({...answers,version:1})));expect(results.map(r=>r.status)).toEqual([201,201]);
  expect(await db.getRepository(ApplicationActivity).countBy({invitationId:inv.id,event:'APPLICATION_SUBMITTED'})).toBe(1);
  await applicant.patch('/api/applicant/draft').set(headers).send({version:2,firstName:'Edit'}).expect(409);
  await manager.get(`/api/onboarding/applications/${verified.id}`).set(headers).expect(200);
  await other.get(`/api/onboarding/applications/${verified.id}`).set(headers).expect(404);
  await admin.get(`/api/onboarding/applications/${verified.id}`).set(headers).expect(200);
  await itAgent.get(`/api/onboarding/applications/${verified.id}`).set(headers).expect(403);
  expect((await manager.get('/api/onboarding/invitations').set(headers)).body[0].status).toBe('COMPLETED');
 });
 it('rejects applicant/staff credential confusion, mass assignment, and mutation CSRF',async()=>{
  const inv=await create();const agent=request.agent(app.getHttpServer());await verify(agent,inv.token);
  await agent.get('/api/auth/me').set(headers).expect(401);await manager.get('/api/applicant/application').set(headers).expect(401);
  await agent.patch('/api/applicant/draft').set({...headers,'x-csrf-protection':''}).send({version:0}).expect(403);
  await agent.patch('/api/applicant/draft').set(headers).send({version:0,status:'SUBMITTED',email:'other@example.test'}).expect(400);
 });
 it('rate limits verification attempts and rejects expired challenges and sessions',async()=>{
  const inv=await create();const agent=request.agent(app.getHttpServer());const begin=await agent.post('/api/applicant/begin').set(headers).send({email:payload.email,token:inv.token}).expect(201);
  const code=await issueDemoCode(db,begin.body.challengeId,'test');const wrong=code==='00000000'?'11111111':'00000000';
  for(let i=0;i<5;i++)await agent.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code:wrong}).expect(401);
  await agent.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code}).expect(429);
  await db.query('TRUNCATE login_attempts');await db.query('UPDATE applicant_challenges SET "expiresAt"=now()-interval \'1 minute\'');
  await agent.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code}).expect(401);
  await verify(agent,inv.token);await db.query(`UPDATE applicant_sessions SET sess=jsonb_set(sess::jsonb,'{expiresAt}','0')::json`);
  await agent.get('/api/applicant/application').set(headers).expect(401);
 });
 async function submittedApplication() {
  const invitation=await create();const applicant=request.agent(app.getHttpServer());const verified=await verify(applicant,invitation.token);
  const fields={firstName:answers.firstName,lastName:answers.lastName,personalPhoneNumber:answers.personalPhoneNumber,workPhoneNumber:answers.workPhoneNumber,preferredAmericanFirstName:answers.preferredAmericanFirstName,preferredAmericanLastName:answers.preferredAmericanLastName,telegram:answers.telegram};
  await applicant.patch('/api/applicant/draft').set(headers).send({...fields,version:0}).expect(200);
  await applicant.post('/api/applicant/submit').set(headers).send({...answers,version:1}).expect(201);
  return {invitation,applicant,id:verified.id,version:2};
 }
 const decision=(agent:Agent,id:string,body:Record<string,unknown>)=>agent.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({...body,...(body.decisionType==='APPROVE'&&!('employment' in body)?{employmentConfirmed:true,employment:{mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'}}:{})});
 it('completes request changes → private correction draft → resubmit → approve with traceable histories',async()=>{
  const flow=await submittedApplication();
  await decision(manager,flow.id,{version:2,decisionType:'REQUEST_CHANGES',reason:'Please correct your Telegram tag.',requestedFields:['telegram']}).expect(201);
  let own=await flow.applicant.get('/api/applicant/application').set(headers).expect(200);
  expect(own.body.correction.reason).toBe('Please correct your Telegram tag.');expect(own.body.editableFields).toEqual(['telegram']);
  expect(own.body.application.status).toBe('CHANGES_REQUESTED');expect(own.body.reviews).toBeUndefined();
  await flow.applicant.patch('/api/applicant/draft').set(headers).send({version:3,telegram:'fictional_updated'}).expect(200);
  own=await flow.applicant.get('/api/applicant/application').set(headers);expect(own.body.application.status).toBe('CHANGES_REQUESTED');
  const during=await manager.get(`/api/onboarding/applications/${flow.id}`).set(headers).expect(200);
  expect(during.body.application.fields.telegram).toBe(answers.telegram);expect(during.body.submissions).toHaveLength(1);
  await flow.applicant.post('/api/applicant/submit').set(headers).send({version:4,accurate:true}).expect(201);
  const detail=await manager.get(`/api/onboarding/applications/${flow.id}`).set(headers).expect(200);
  expect(detail.body.application.status).toBe('RESUBMITTED');expect(detail.body.submissions).toHaveLength(2);
  expect(detail.body.submissions[0].fields.telegram).toBe(answers.telegram);expect(detail.body.submissions[1].fields.telegram).toBe('fictional_updated');
  expect(detail.body.reviews[0].reviewer.firstName).toBe('Fictional');
  await decision(manager,flow.id,{version:5,decisionType:'APPROVE',confirmed:true,reason:'Internal approval comment'}).expect(201);
  const approved=await manager.get(`/api/onboarding/applications/${flow.id}`).set(headers).expect(200);
  expect(approved.body.readyForIt).toBe(true);expect(approved.body.canReview).toBe(false);expect(approved.body.reviews).toHaveLength(2);
  expect(approved.body.reviews[1]).toMatchObject({previousStatus:'RESUBMITTED',newStatus:'APPROVED'});
  own=await flow.applicant.get('/api/applicant/application').set(headers);expect(own.body.application.status).toBe('APPROVED');expect(own.body.canEdit).toBe(false);
  expect(JSON.stringify(own.body)).not.toContain('Internal approval comment');
  expect(await db.getRepository(ApplicationActivity).countBy({invitationId:flow.invitation.id,event:'APPLICATION_APPROVED'})).toBe(1);
  const summary=await manager.get('/api/onboarding/summary').set(headers).expect(200);expect(summary.body.approved).toBe(1);
 });
 it('requires confirmation/reasons and validates correction fields at the backend',async()=>{
  const flow=await submittedApplication();
  await decision(manager,flow.id,{version:2,decisionType:'APPROVE'}).expect(400);
  await decision(manager,flow.id,{version:2,decisionType:'REJECT',confirmed:true,reason:'  '}).expect(400);
  await decision(manager,flow.id,{version:2,decisionType:'REQUEST_CHANGES',requestedFields:['personalPhoneNumber']}).expect(400);
  await decision(manager,flow.id,{version:2,decisionType:'REQUEST_CHANGES',reason:'Correct this',requestedFields:[]}).expect(400);
  await decision(manager,flow.id,{version:2,decisionType:'REQUEST_CHANGES',reason:'Correct this',requestedFields:['assignedManagerId']}).expect(400);
  await decision(manager,flow.id,{version:2,decisionType:'APPROVE',confirmed:true,reviewerId:'spoofed'}).expect(400);
  await decision(manager,flow.id,{version:2,decisionType:'APPROVE',confirmed:true,requestedFields:['personalPhoneNumber']}).expect(400);
  expect((await db.getRepository(DispatcherApplication).findOneByOrFail({id:flow.id})).status).toBe('SUBMITTED');
 });
 it('keeps rejection notes private and makes rejected applications immutable',async()=>{
  const flow=await submittedApplication();const reason='Internal fictional review rationale';
  await decision(manager,flow.id,{version:2,decisionType:'REJECT',reason,confirmed:true}).expect(201);
  const detail=await manager.get(`/api/onboarding/applications/${flow.id}`).set(headers);expect(detail.body.reviews[0].reason).toBe(reason);
  const own=await flow.applicant.get('/api/applicant/application').set(headers).expect(200);expect(own.body.application.status).toBe('REJECTED');expect(own.body.correction).toBeNull();expect(JSON.stringify(own.body)).not.toContain(reason);
  await flow.applicant.patch('/api/applicant/draft').set(headers).send({version:3,firstName:'Attempt'}).expect(409);
  await flow.applicant.post('/api/applicant/submit').set(headers).send({...answers,version:3}).expect(409);
  await decision(admin,flow.id,{version:3,decisionType:'APPROVE',confirmed:true}).expect(409);
 });
 it('rejects duplicate approvals, stale versions and concurrent conflicting decisions',async()=>{
  const flow=await submittedApplication();
  await decision(manager,flow.id,{version:0,decisionType:'APPROVE',confirmed:true}).expect(409);
  const results=await Promise.all([
   decision(manager,flow.id,{version:2,decisionType:'APPROVE',confirmed:true}),
   decision(admin,flow.id,{version:2,decisionType:'REJECT',reason:'Internal',confirmed:true}),
  ]);expect(results.map(r=>r.status).sort()).toEqual([201,409]);
  const detail=await manager.get(`/api/onboarding/applications/${flow.id}`).set(headers);expect(detail.body.reviews).toHaveLength(1);
  await decision(manager,flow.id,{version:2,decisionType:'APPROVE',confirmed:true}).expect(409);
  await decision(manager,flow.id,{version:3,decisionType:'APPROVE',confirmed:true}).expect(409);
  await flow.applicant.patch('/api/applicant/draft').set(headers).send({version:3,personalPhoneNumber:'+1 202 555 0100'}).expect(409);
 });
 it('enforces review scope, role, session and CSRF boundaries',async()=>{
  const flow=await submittedApplication(),body={version:2,decisionType:'APPROVE',confirmed:true};
  await decision(other,flow.id,body).expect(404);await decision(itAgent,flow.id,body).expect(403);
  await decision(flow.applicant,flow.id,body).expect(401);
  await request(app.getHttpServer()).post(`/api/onboarding/applications/${flow.id}/reviews`).set(headers).send(body).expect(401);
  await manager.post(`/api/onboarding/applications/${flow.id}/reviews`).set({...headers,origin:'https://evil.example'}).send(body).expect(403);
  await itAgent.get('/api/onboarding/review-queue').set(headers).expect(403);
  await decision(admin,flow.id,body).expect(201);
 });
 it('blocks unrequested/employment fields and unverified cross-applicant correction access',async()=>{
  const flow=await submittedApplication();
  await decision(manager,flow.id,{version:2,decisionType:'REQUEST_CHANGES',reason:'Update personalPhoneNumber',requestedFields:['personalPhoneNumber']}).expect(201);
  await flow.applicant.patch('/api/applicant/draft').set(headers).send({version:3,lastName:'Forbidden'}).expect(400);
  await flow.applicant.patch('/api/applicant/draft').set(headers).send({version:3,mcName:'Forbidden'}).expect(400);
  await flow.applicant.patch('/api/applicant/draft').set(headers).send({version:3,applicationId:flow.id}).expect(400);
  const outsider=request.agent(app.getHttpServer());await outsider.get('/api/applicant/application').set(headers).expect(401);
  const otherInvitation=await create();await verify(outsider,otherInvitation.token);
  await outsider.patch('/api/applicant/draft').set(headers).send({version:0,firstName:'Different fictional applicant'}).expect(200);
  expect((await flow.applicant.get('/api/applicant/application').set(headers)).body.application.fields.firstName).toBe(answers.firstName);
 });
 it('supports correction verification after invitation expiry without reusing consumed tokens',async()=>{
  const flow=await submittedApplication();
  await db.getRepository(Invitation).update(flow.invitation.id,{expiresAt:new Date(Date.now()-1000)});
  await decision(manager,flow.id,{version:2,decisionType:'REQUEST_CHANGES',reason:'Correct personalPhoneNumber',requestedFields:['personalPhoneNumber']}).expect(201);
  await flow.applicant.post('/api/applicant/logout').set(headers).send({}).expect(201);
  const reused=await flow.applicant.post('/api/applicant/begin').set(headers).send({email:payload.email,token:flow.invitation.token}).expect(201);
  await expect(issueDemoCode(db,reused.body.challengeId,'test')).rejects.toThrow();
  const begin=await flow.applicant.post('/api/applicant/begin').set(headers).send({email:payload.email,applicationId:flow.id}).expect(201);
  const code=await issueDemoCode(db,begin.body.challengeId,'test');
  await flow.applicant.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code}).expect(201);
  const own=await flow.applicant.get('/api/applicant/application').set(headers).expect(200);expect(own.body.correction.requestedFields).toEqual(['personalPhoneNumber']);
  await db.getRepository(DispatcherApplication).update(flow.id,{applicantAccessUntil:new Date(Date.now()-1000)});
  await flow.applicant.get('/api/applicant/application').set(headers).expect(401);
 });
 it('paginates, searches, sorts and counts only authorized submitted revisions',async()=>{
  const flow=await submittedApplication();await create();await create();
  const first=await manager.get('/api/onboarding/review-queue?page=1&pageSize=2&sort=updatedAt&direction=ASC').set(headers).expect(200);
  const second=await manager.get('/api/onboarding/review-queue?page=2&pageSize=2&sort=updatedAt&direction=ASC').set(headers).expect(200);
  expect((await manager.get('/api/onboarding/review-queue?status=AWAITING_REVIEW').set(headers).expect(200)).body.total).toBe(1);
  expect(first.body.total).toBe(3);expect(first.body.items).toHaveLength(2);expect(second.body.items).toHaveLength(1);
  expect(new Set([...first.body.items,...second.body.items].map((row:{id:string})=>row.id)).size).toBe(3);
  const searched=await manager.get('/api/onboarding/review-queue?search=Fictional&status=SUBMITTED&sort=name').set(headers).expect(200);
  expect(searched.body.items).toHaveLength(1);expect(searched.body.items[0].email).toBe(payload.email);
  const scoped=await other.get('/api/onboarding/review-queue').set(headers).expect(200);expect(scoped.body.total).toBe(0);
  expect((await admin.get('/api/onboarding/review-queue').set(headers)).body.total).toBe(3);
  expect((await other.get('/api/onboarding/summary').set(headers)).body.awaitingReview).toBe(0);
  expect((await manager.get('/api/onboarding/summary').set(headers)).body.awaitingReview).toBe(1);
  await decision(manager,flow.id,{version:2,decisionType:'REQUEST_CHANGES',reason:'Correct name',requestedFields:['firstName']}).expect(201);
  await flow.applicant.patch('/api/applicant/draft').set(headers).send({version:3,firstName:'UnsubmittedSecret'}).expect(200);
  expect((await manager.get('/api/onboarding/review-queue?search=UnsubmittedSecret').set(headers)).body.total).toBe(0);
  await manager.get('/api/onboarding/review-queue?sort=passwordHash').set(headers).expect(400);
  await manager.get('/api/onboarding/review-queue?pageSize=999').set(headers).expect(400);
 });
 it('preserves successive correction rounds and rejects stale submissions from previous rounds',async()=>{
  const flow=await submittedApplication();
  await decision(manager,flow.id,{version:2,decisionType:'REQUEST_CHANGES',reason:'First correction',requestedFields:['telegram']}).expect(201);
  await flow.applicant.post('/api/applicant/submit').set(headers).send({version:3,telegram:'first_revision',accurate:true}).expect(201);
  await decision(manager,flow.id,{version:4,decisionType:'REQUEST_CHANGES',reason:'Second correction',requestedFields:['personalPhoneNumber']}).expect(201);
  await flow.applicant.post('/api/applicant/submit').set(headers).send({version:3,telegram:'old',accurate:true}).expect(409);
  await flow.applicant.post('/api/applicant/submit').set(headers).send({version:5,personalPhoneNumber:'+1 202 555 0111',accurate:true}).expect(201);
  const detail=await manager.get(`/api/onboarding/applications/${flow.id}`).set(headers).expect(200);
  expect(detail.body.reviews).toHaveLength(2);expect(detail.body.submissions).toHaveLength(3);
  expect(detail.body.application.fields.telegram).toBe('first_revision');
 });
 it('rejects review of drafts and enforces the explicit initial draft transition',async()=>{
  const inv=await create();const applicant=request.agent(app.getHttpServer());const verified=await verify(applicant,inv.token);
  await applicant.post('/api/applicant/submit').set(headers).send({...answers,version:0}).expect(409);
  await decision(manager,verified.id,{version:0,decisionType:'APPROVE',confirmed:true}).expect(409);
  await applicant.patch('/api/applicant/draft').set(headers).send({version:0,firstName:'Fictional'}).expect(200);
  await decision(manager,verified.id,{version:1,decisionType:'REJECT',reason:'No submission',confirmed:true}).expect(409);
 });
 it('rate limits review actions without changing record state',async()=>{
  const flow=await submittedApplication();
  for(let i=0;i<30;i++)await decision(manager,flow.id,{version:0,decisionType:'APPROVE',confirmed:true}).expect(409);
  await decision(manager,flow.id,{version:2,decisionType:'APPROVE',confirmed:true}).expect(429);
  expect((await db.getRepository(DispatcherApplication).findOneByOrFail({id:flow.id})).status).toBe('SUBMITTED');
 });
 it('creates a link with no applicant details, default expiry, and no premature identity binding',async()=>{
  const result=await manager.post('/api/onboarding/invitations').set(headers).send({}).expect(201);
  const invitation=await db.getRepository(Invitation).findOneByOrFail({id:result.body.id});
  expect(invitation.email).toBeNull();expect(invitation.expectedEmail).toBeNull();expect(invitation.mcName).toBeNull();
  expect(invitation.expiresAt.getTime()-invitation.createdAt.getTime()).toBeGreaterThan(7*86400000-5000);
  expect(result.body.url).toMatch(/\/apply\/[a-f0-9]{64}$/);
  expect(await db.getRepository(DispatcherApplication).countBy({invitationId:invitation.id})).toBe(1);
  await request(app.getHttpServer()).get('/api/applicant/application').set(headers).expect(401);
 });
 it('binds an unrestricted invitation only on successful verification and rejects concurrent claimants',async()=>{
  const created=await manager.post('/api/onboarding/invitations').set(headers).send({expirationDays:3}).expect(201);
  const token=created.body.url.split('/').pop(),agents=[request.agent(app.getHttpServer()),request.agent(app.getHttpServer())];
  const emails=['claim.one@example.test','claim.two@example.test'];
  const challenges=await Promise.all(agents.map((agent,index)=>agent.post('/api/applicant/begin').set(headers).send({token,email:emails[index]}).expect(201)));
  const codes=await Promise.all(challenges.map(challenge=>issueDemoCode(db,challenge.body.challengeId,'test')));
  expect((await db.getRepository(Invitation).findOneByOrFail({id:created.body.id})).email).toBeNull();
  const results=await Promise.all(agents.map((agent,index)=>agent.post('/api/applicant/verify').set(headers).send({challengeId:challenges[index].body.challengeId,code:codes[index]})));
  expect(results.map(result=>result.status).sort()).toEqual([201,401]);
  const winner=results.findIndex(result=>result.status===201),loser=1-winner;
  const invitation=await db.getRepository(Invitation).findOneByOrFail({id:created.body.id});expect(invitation.email).toBe(emails[winner]);expect(invitation.consumedAt).not.toBeNull();
  const own=await agents[winner].get('/api/applicant/application').set(headers).expect(200);expect(own.body.invitation.email).toBe(emails[winner]);
  await agents[loser].get('/api/applicant/application').set(headers).expect(401);
  expect(await db.getRepository(DispatcherApplication).countBy({invitationId:invitation.id})).toBe(1);
  expect(await db.getRepository(ApplicationActivity).countBy({invitationId:invitation.id,event:'INVITATION_CLAIMED'})).toBe(1);
  const second=await agents[loser].post('/api/applicant/begin').set(headers).send({token,email:emails[loser]}).expect(201);
  await expect(issueDemoCode(db,second.body.challengeId,'test')).rejects.toThrow();
 });
 it('requires exact normalized expected email and refuses tampered challenge identity',async()=>{
  const created=await manager.post('/api/onboarding/invitations').set(headers).send({email:' Expected.Person@EXAMPLE.TEST '}).expect(201);
  const token=created.body.url.split('/').pop(),agent=request.agent(app.getHttpServer());
  const wrong=await agent.post('/api/applicant/begin').set(headers).send({token,email:'other@example.test'}).expect(201);
  await expect(issueDemoCode(db,wrong.body.challengeId,'test')).rejects.toThrow();
  const begin=await agent.post('/api/applicant/begin').set(headers).send({token,email:'expected.person@example.test'}).expect(201);
  const code=await issueDemoCode(db,begin.body.challengeId,'test');
  await agent.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code,email:'other@example.test'}).expect(400);
  await agent.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code}).expect(201);
  expect((await db.getRepository(Invitation).findOneByOrFail({id:created.body.id})).email).toBe('expected.person@example.test');
 });
 it('completes open-link claiming, applicant employment, resume, corrections and confirmed manager approval',async()=>{
  const created=await manager.post('/api/onboarding/invitations').set(headers).send({}).expect(201);
  const token=created.body.url.split('/').pop(),applicant=request.agent(app.getHttpServer());
  const begin=await applicant.post('/api/applicant/begin').set(headers).send({token,email:payload.email}).expect(201);
  const code=await issueDemoCode(db,begin.body.challengeId,'test');
  const verified=await applicant.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code}).expect(201);const id=verified.body.applicationId;
  await applicant.patch('/api/applicant/draft').set(headers).send({version:0,...answers,accurate:undefined,mcName:'Fictional MC',teamLead:'Independent',jobTitle:'Dispatcher'}).expect(200);
  await applicant.post('/api/applicant/logout').set(headers).send({}).expect(201);
  const resume=await applicant.post('/api/applicant/begin').set(headers).send({applicationId:id,email:payload.email}).expect(201);
  const resumeCode=await issueDemoCode(db,resume.body.challengeId,'test');await applicant.post('/api/applicant/verify').set(headers).send({challengeId:resume.body.challengeId,code:resumeCode}).expect(201);
  const own=await applicant.get('/api/applicant/application').set(headers).expect(200);expect(own.body.application.fields.mcName).toBe('Fictional MC');
  await applicant.post('/api/applicant/submit').set(headers).send({version:1,accurate:true}).expect(201);
  await decision(manager,id,{version:2,decisionType:'REQUEST_CHANGES',reason:'Please correct the MC name.',requestedFields:['mcName']}).expect(201);
  await applicant.patch('/api/applicant/draft').set(headers).send({version:3,mcName:'Fictional corrected MC'}).expect(200);
  const pending=await manager.get(`/api/onboarding/applications/${id}`).set(headers).expect(200);expect(pending.body.application.fields.mcName).toBe('Fictional MC');
  await applicant.post('/api/applicant/submit').set(headers).send({version:4,accurate:true}).expect(201);
  const employment={mcName:'Final fictional MC',teamLead:'Fictional lead',jobTitle:'Senior Dispatcher'};
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({version:5,decisionType:'APPROVE',confirmed:true,employment}).expect(400);
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({version:5,decisionType:'APPROVE',confirmed:true,employmentConfirmed:true,employment:{...employment,teamLead:''}}).expect(400);
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({version:5,decisionType:'APPROVE',confirmed:true,employmentConfirmed:true,employment}).expect(201);
  const detail=await manager.get(`/api/onboarding/applications/${id}`).set(headers).expect(200);expect(detail.body.readyForIt).toBe(true);expect(detail.body.invitation).toMatchObject(employment);
  expect(detail.body.application.fields.mcName).toBe('Fictional corrected MC');expect(detail.body.reviews[1].employment).toEqual(employment);
  expect(await db.getRepository(ApplicationActivity).countBy({invitationId:created.body.id,event:'EMPLOYMENT_CONFIRMED'})).toBe(1);
 });
 it('validates employment before submission and keeps verified email immutable',async()=>{
  const created=await manager.post('/api/onboarding/invitations').set(headers).send({}).expect(201);
  const applicant=request.agent(app.getHttpServer()),verified=await verify(applicant,created.body.url.split('/').pop());
  await applicant.patch('/api/applicant/draft').set(headers).send({version:0,firstName:answers.firstName,lastName:answers.lastName,personalPhoneNumber:answers.personalPhoneNumber,workPhoneNumber:answers.workPhoneNumber,preferredAmericanFirstName:answers.preferredAmericanFirstName,preferredAmericanLastName:answers.preferredAmericanLastName}).expect(200);
  await applicant.post('/api/applicant/submit').set(headers).send({version:1,accurate:true}).expect(400);
  await applicant.patch('/api/applicant/draft').set(headers).send({version:1,email:'other@example.test'}).expect(400);
  await applicant.patch('/api/applicant/draft').set(headers).send({version:1,mcName:'x'.repeat(151)}).expect(400);
  await applicant.patch('/api/applicant/draft').set(headers).send({version:1,mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'}).expect(200);
  await applicant.post('/api/applicant/submit').set(headers).send({version:2,accurate:true}).expect(201);
  expect((await manager.get(`/api/onboarding/applications/${verified.id}`).set(headers)).body.application.fields.mcName).toBe('Independent');
 });
 it('explains the local fictional-email requirement before creating an unusable challenge',async()=>{
  const inv=await create();
  const response=await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({token:inv.token,email:'fictional@example.com'}).expect(400);
  expect(response.body.message).toContain('@example.test');
 });
 it('issues a usable verification code through the actual ts-node command',async()=>{
  const inv=await create(),applicant=request.agent(app.getHttpServer());
  const begin=await applicant.post('/api/applicant/begin').set(headers).send({token:inv.token,email:payload.email}).expect(201);
  const output=execFileSync(process.execPath,['-r',require.resolve('ts-node/register'),resolve(__dirname,'../src/database/demo-verification.ts'),begin.body.challengeId],{
   cwd:resolve(__dirname,'..'),encoding:'utf8',timeout:20000,
   env:{...process.env,...Object.fromEntries(Object.entries(env).map(([key,value])=>[key,String(value)])),TS_NODE_FILES:'false',TS_NODE_TRANSPILE_ONLY:'false'},
  });
  const code=output.match(/Local fictional verification code: ([0-9]{8})/)?.[1];
  expect(Boolean(code)).toBe(true);
  await applicant.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code}).expect(201);
  await applicant.get('/api/applicant/application').set(headers).expect(200);
 },25000);
 it.each(['workPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName'] as const)('requires %s before a new submission',async field=>{
  const inv=await create(),applicant=request.agent(app.getHttpServer());await verify(applicant,inv.token);
  const fields={...answers}; delete (fields as Partial<typeof answers>).accurate;
  await applicant.patch('/api/applicant/draft').set(headers).send({version:0,...fields,[field]:'   '}).expect(200);
  await applicant.post('/api/applicant/submit').set(headers).send({version:1,accurate:true}).expect(400);
 });
 it('keeps personal/work phones separate, trims required American names and proposes only the American display name',async()=>{
  const inv=await create(),applicant=request.agent(app.getHttpServer()),verified=await verify(applicant,inv.token);
  await applicant.patch('/api/applicant/draft').set(headers).send({version:0,...answers,accurate:undefined,personalPhoneNumber:'+996 (555) 123-456',workPhoneNumber:'+44 20 7946 0958',preferredAmericanFirstName:'  Alex  ',preferredAmericanLastName:'  Demo  '}).expect(200);
  await applicant.post('/api/applicant/submit').set(headers).send({version:1,accurate:true}).expect(201);
  const detail=await manager.get(`/api/onboarding/applications/${verified.id}`).set(headers).expect(200);
  expect(detail.body.application.fields.personalPhoneNumber).toBe('+996 (555) 123-456');
  expect(detail.body.application.fields.workPhoneNumber).toBe('+44 20 7946 0958');
  expect(detail.body.itDetails).toMatchObject({legalFirstName:answers.firstName,legalLastName:answers.lastName,proposedDisplayName:'Alex Demo',preferredAmericanFirstName:'Alex',preferredAmericanLastName:'Demo'});
  await decision(manager,verified.id,{version:2,decisionType:'REQUEST_CHANGES',reason:'Correct work contact and American name',requestedFields:['workPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName']}).expect(201);
  await applicant.patch('/api/applicant/draft').set(headers).send({version:3,workPhoneNumber:'+33 (1) 23 45 67 89',preferredAmericanFirstName:'Taylor',preferredAmericanLastName:'Example'}).expect(200);
  await applicant.post('/api/applicant/submit').set(headers).send({version:4,accurate:true}).expect(201);
  const resubmitted=await manager.get(`/api/onboarding/applications/${verified.id}`).set(headers).expect(200);
  expect(resubmitted.body.application.fields.personalPhoneNumber).toBe('+996 (555) 123-456');
  expect(resubmitted.body.itDetails.proposedDisplayName).toBe('Taylor Example');
 });
 it('rejects malformed phone values on the backend without losing the saved draft',async()=>{
  const inv=await create(),applicant=request.agent(app.getHttpServer());await verify(applicant,inv.token);
  for(const field of ['personalPhoneNumber','workPhoneNumber'])for(const value of ['abc','123','+1234567890123456','++1 202 555 0123']){
   await applicant.patch('/api/applicant/draft').set(headers).send({version:0,[field]:value}).expect(400);
  }
  expect((await applicant.get('/api/applicant/application').set(headers)).body.application.version).toBe(0);
 });
 it('requires missing legacy details before approval and allows their completion in an existing correction round',async()=>{
  const flow=await submittedApplication();
  // Model a historical submission lacking values; do not invent migration placeholders.
  await db.query(`UPDATE dispatcher_applications SET fields=fields-'workPhoneNumber'-'preferredAmericanFirstName'-'preferredAmericanLastName' WHERE id=$1`,[flow.id]);
  await db.query(`UPDATE application_submissions SET fields=fields-'workPhoneNumber'-'preferredAmericanFirstName'-'preferredAmericanLastName' WHERE "applicationId"=$1`,[flow.id]);
  await decision(manager,flow.id,{version:2,decisionType:'APPROVE',confirmed:true}).expect(400);
  await decision(manager,flow.id,{version:2,decisionType:'REQUEST_CHANGES',reason:'Update your Telegram',requestedFields:['telegram']}).expect(201);
  // Simulate a pre-update correction request whose original flags did not include new fields.
  await db.query(`UPDATE application_reviews SET "requestedFields"='["telegram"]' WHERE "applicationId"=$1`,[flow.id]);
  const own=await flow.applicant.get('/api/applicant/application').set(headers).expect(200);
  expect(own.body.editableFields).toEqual(expect.arrayContaining(['workPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName']));
  await flow.applicant.patch('/api/applicant/draft').set(headers).send({version:3,workPhoneNumber:answers.workPhoneNumber,preferredAmericanFirstName:answers.preferredAmericanFirstName,preferredAmericanLastName:answers.preferredAmericanLastName}).expect(200);
  expect((await flow.applicant.get('/api/applicant/application').set(headers)).body.editableFields).toContain('workPhoneNumber');
  await flow.applicant.post('/api/applicant/submit').set(headers).send({version:4,accurate:true}).expect(201);
  await decision(manager,flow.id,{version:5,decisionType:'APPROVE',confirmed:true}).expect(201);
 });
 it('keeps historical approvals accessible and approved when required details are absent',async()=>{
  const flow=await submittedApplication();await decision(manager,flow.id,{version:2,decisionType:'APPROVE',confirmed:true}).expect(201);
  await db.query(`UPDATE dispatcher_applications SET fields=fields-'workPhoneNumber'-'preferredAmericanFirstName'-'preferredAmericanLastName' WHERE id=$1`,[flow.id]);
  await db.query(`UPDATE application_submissions SET fields=fields-'workPhoneNumber'-'preferredAmericanFirstName'-'preferredAmericanLastName' WHERE "applicationId"=$1`,[flow.id]);
  const detail=await manager.get(`/api/onboarding/applications/${flow.id}`).set(headers).expect(200);
  expect(detail.body.readyForIt).toBe(true);expect(detail.body.application.status).toBe('APPROVED');expect(detail.body.itDetails.proposedDisplayName).toBeNull();
  expect(detail.body.requiredFields).toEqual(expect.arrayContaining(['workPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName']));
  expect((await flow.applicant.get('/api/applicant/application').set(headers).expect(200)).body.application.status).toBe('APPROVED');
  await decision(admin,flow.id,{version:3,decisionType:'REQUEST_CHANGES',reason:'Attempt reopen',requestedFields:['workPhoneNumber']}).expect(409);
 });
});
