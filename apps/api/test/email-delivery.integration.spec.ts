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
import { ApplicationActivity, Invitation } from '../src/modules/onboarding/entities';
import { EmailService } from '../src/modules/email/email.service';
const integration=process.env.TEST_DATABASE_URL?describe:describe.skip;
integration('Applicant email delivery (disposable PostgreSQL)',()=>{
 let app:INestApplication,db:DataSource,closeSessions:()=>Promise<void>,manager:ReturnType<typeof request.agent>;
 const password=randomBytes(24).toString('base64url');
 const env=validateEnvironment({NODE_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_URL??'postgresql://localhost/operations_m2_test',CORS_ORIGINS:'http://localhost:3000',WEB_ORIGIN:'http://localhost:3000',SESSION_SECRET:randomBytes(32).toString('hex'),BFF_SHARED_SECRET:randomBytes(32).toString('hex'),
  EMAIL_DELIVERY:'smtp',SMTP_HOST:'localhost',SMTP_PORT:'1025',EMAIL_FROM:'Operations <sender@example.test>'});
 const headers={'x-workspace-key':env.BFF_SHARED_SECRET,origin:env.WEB_ORIGIN,'x-csrf-protection':'1'};
 // Captures messages instead of opening an SMTP connection; background work is awaited by settle().
 const sent:{to:string;code:string}[]=[],tasks:Promise<void>[]=[];let accept=true;
 const email={enabled:true,onModuleInit:()=>undefined,onApplicationShutdown:async()=>undefined,
  sendVerificationCode:async(to:string,code:string)=>{sent.push({to,code});return accept;},
  runInBackground:(task:()=>Promise<void>)=>{tasks.push(task());}};
 const settle=async()=>{await Promise.all(tasks.splice(0));};
 const events=async(invitationId:string)=>(await db.getRepository(ApplicationActivity).findBy({invitationId})).map(row=>row.event);
 async function invite(body:Record<string,unknown>={}){const result=await manager.post('/api/onboarding/invitations').set(headers).send(body).expect(201);return {id:result.body.id as string,url:result.body.url as string,token:result.body.url.split('#').pop() as string};}
 beforeAll(async()=>{
  if(!new URL(env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
  db=await new DataSource(databaseOptions(env)).initialize();await db.runMigrations();await db.query('TRUNCATE users,staff_sessions,applicant_sessions,login_attempts CASCADE');
  await db.getRepository(User).save({firstName:'Fictional',lastName:'Manager',email:'mail.manager@example.test',role:Role.DISPATCHER_MANAGER,status:UserStatus.ACTIVE,passwordHash:await hashPassword(password)});
  const module=await Test.createTestingModule({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true,load:[()=>env]}),TypeOrmModule.forRoot(databaseOptions(env)),AuthModule,OnboardingModule]})
   .overrideProvider(EmailService).useValue(email).compile();
  app=module.createNestApplication();closeSessions=installSessions(app,env);configureApp(app,env.CORS_ORIGINS);await app.init();
  manager=request.agent(app.getHttpServer());await manager.post('/api/auth/login').set(headers).send({email:'mail.manager@example.test',password}).expect(200);
 },30000);
 beforeEach(async()=>{await settle();sent.length=0;accept=true;await db.query('TRUNCATE invitations,applicant_sessions,login_attempts CASCADE');});
 afterAll(async()=>{await settle();if(closeSessions)await closeSessions();if(app)await app.close();if(db?.isInitialized)await db.destroy();});
 it('puts the invitation token in the URL fragment so it never reaches server logs',async()=>{
  const inv=await invite();
  expect(inv.url).toMatch(/^http:\/\/localhost:3000\/apply#[a-f0-9]{64}$/);
 });
 it('emails a code that verifies the applicant and records the sent outcome',async()=>{
  const inv=await invite({email:'applicant.person@example.test'});
  const applicant=request.agent(app.getHttpServer());
  const begin=await applicant.post('/api/applicant/begin').set(headers).send({token:inv.token,email:'applicant.person@example.test'}).expect(201);
  expect(begin.body).toMatchObject({delivery:'email'});
  await settle();
  expect(sent).toEqual([{to:'applicant.person@example.test',code:expect.stringMatching(/^[0-9]{8}$/)}]);
  expect(await events(inv.id)).toContain('VERIFICATION_EMAIL_SENT');
  expect((await db.getRepository(Invitation).findOneByOrFail({id:inv.id})).openedAt).not.toBeNull();
  await applicant.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code:sent[0].code}).expect(201);
  await applicant.get('/api/applicant/application').set(headers).expect(200);
 });
 it('records a failed outcome when the mail server rejects the message',async()=>{
  accept=false;
  const inv=await invite();
  await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({token:inv.token,email:'unlucky@example.test'}).expect(201);
  await settle();
  const recorded=await events(inv.id);
  expect(recorded).toContain('VERIFICATION_EMAIL_FAILED');
  expect(recorded).not.toContain('VERIFICATION_EMAIL_SENT');
 });
 it('returns an identical response and sends nothing when the email does not match',async()=>{
  const inv=await invite({email:'expected@example.test'});
  const applicant=request.agent(app.getHttpServer());
  const wrong=await applicant.post('/api/applicant/begin').set(headers).send({token:inv.token,email:'someone.else@example.test'}).expect(201);
  const right=await applicant.post('/api/applicant/begin').set(headers).send({token:inv.token,email:'expected@example.test'}).expect(201);
  expect(Object.keys(wrong.body).sort()).toEqual(Object.keys(right.body).sort());
  expect({...wrong.body,challengeId:''}).toEqual({...right.body,challengeId:''});
  await settle();
  expect(sent.map(message=>message.to)).toEqual(['expected@example.test']);
  // The unmatched challenge has no code, so even the matched code cannot unlock it.
  await applicant.post('/api/applicant/verify').set(headers).send({challengeId:wrong.body.challengeId,code:sent[0].code}).expect(401);
 });
 it('sends nothing for unknown, revoked or already-claimed invitations',async()=>{
  const applicant=request.agent(app.getHttpServer());
  await applicant.post('/api/applicant/begin').set(headers).send({token:'a'.repeat(64),email:'person@example.test'}).expect(201);
  const revoked=await invite();await manager.post(`/api/onboarding/invitations/${revoked.id}/revoke`).set(headers).send({}).expect(201);
  await applicant.post('/api/applicant/begin').set(headers).send({token:revoked.token,email:'person@example.test'}).expect(201);
  const claimed=await invite();
  const first=await applicant.post('/api/applicant/begin').set(headers).send({token:claimed.token,email:'first@example.test'}).expect(201);
  await settle();
  await applicant.post('/api/applicant/verify').set(headers).send({challengeId:first.body.challengeId,code:sent[0].code}).expect(201);
  await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({token:claimed.token,email:'second@example.test'}).expect(201);
  await settle();
  expect(sent.map(message=>message.to)).toEqual(['first@example.test']);
 });
 it('keeps non-production environments fictional-only even with SMTP configured',async()=>{
  await manager.post('/api/onboarding/invitations').set(headers).send({email:'real.person@company.example'}).expect(400);
  const inv=await invite();
  await request(app.getHttpServer()).post('/api/applicant/begin').set(headers).send({token:inv.token,email:'real.person@company.example'}).expect(400);
  await settle();
  expect(sent).toEqual([]);
 });
});
