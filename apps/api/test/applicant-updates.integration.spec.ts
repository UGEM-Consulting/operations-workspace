import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { ApplicationActivity } from '../src/modules/onboarding/entities';
import { EmailService } from '../src/modules/email/email.service';
import { ApplicantUpdateDelivery } from '../src/modules/updates/updates.entity';
type Agent=ReturnType<typeof request.agent>;
const integration=process.env.TEST_DATABASE_URL?describe:describe.skip;
integration('Applicant status updates by email and Telegram (disposable PostgreSQL)',()=>{
 let app:INestApplication,db:DataSource,closeSessions:()=>Promise<void>,manager:Agent,telegram:Server;
 const password=randomBytes(24).toString('base64url'),botToken=`12345678:${randomBytes(24).toString('base64url')}`;
 // A local fake of the Telegram Bot API: queued updates for getUpdates, recorded sendMessage calls.
 const updates:{update_id:number;message:unknown}[]=[],messages:{chat_id:string;text:string}[]=[],offsets:number[]=[];let failSend=false;
 let env:ReturnType<typeof validateEnvironment>,headers:Record<string,string>;
 const codes:{to:string;code:string}[]=[],emails:{to:string;subject:string;text:string}[]=[],tasks:Promise<void>[]=[];
 const email={enabled:true,onModuleInit:()=>undefined,onApplicationShutdown:async()=>undefined,
  sendVerificationCode:async(to:string,code:string)=>{codes.push({to,code});return true;},
  sendStatusUpdate:async(to:string,content:{subject:string;text:string})=>{emails.push({to,subject:content.subject,text:content.text});return true as const;},
  runInBackground:(task:()=>Promise<void>)=>{tasks.push(task());}};
 const settle=async()=>{while(tasks.length)await Promise.all(tasks.splice(0));};
 const events=async(invitationId:string)=>(await db.getRepository(ApplicationActivity).findBy({invitationId})).map(row=>row.event);
 const answers={firstName:'Fictional',lastName:'Applicant',personalPhoneNumber:'+1 202 555 0123',preferredAmericanFirstName:'Alex',preferredAmericanLastName:'Demo',telegram:'fictional_demo',mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'};
 let nextUpdate=100;
 const start=(text:string,chat=777,username='fictional_dispatcher')=>updates.push({update_id:nextUpdate++,message:{text,chat:{id:chat,type:'private'},from:{username}}});
 async function submitted(address:string){
  const inv=await manager.post('/api/onboarding/invitations').set(headers).send({}).expect(201);
  const applicant=request.agent(app.getHttpServer()),token=inv.body.url.split('#').pop() as string;
  const begin=await applicant.post('/api/applicant/begin').set(headers).send({token,email:address}).expect(201);await settle();
  const verified=await applicant.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code:codes.at(-1)!.code}).expect(201);
  await applicant.patch('/api/applicant/draft').set(headers).send({version:0,...answers}).expect(200);
  await applicant.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(201);
  return {applicant,id:verified.body.applicationId as string,invitationId:inv.body.id as string};
 }
 async function connect(applicant:Agent,chat:number){
  const link=await applicant.post('/api/applicant/updates/telegram').set(headers).send({}).expect(201);
  expect(link.body.url).toMatch(/^https:\/\/t\.me\/ugem_updates_bot\?start=[A-Za-z0-9_-]{43}$/);
  const token=link.body.url.split('start=')[1] as string;start(`/start ${token}`,chat);
  return {token,check:await applicant.post('/api/applicant/updates/telegram/check').set(headers).send({}).expect(201)};
 }
 beforeAll(async()=>{
  telegram=createServer((req,res)=>{let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
   const input=JSON.parse(body||'{}'),method=req.url?.split('/').pop(),reply=(status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
   if(req.url?.split('/')[1]!==`bot${botToken}`)return reply(401,{ok:false});
   if(method==='getUpdates'){offsets.push(input.offset);return reply(200,{ok:true,result:updates.filter(update=>update.update_id>=input.offset)});}
   if(method==='sendMessage'){if(failSend)return reply(403,{ok:false,description:'Forbidden: bot was blocked by the user'});messages.push({chat_id:String(input.chat_id),text:input.text});return reply(200,{ok:true,result:{}});}
   reply(404,{ok:false});});});
  await new Promise<void>(resolve=>telegram.listen(0,'127.0.0.1',resolve));
  env=validateEnvironment({NODE_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_URL??'postgresql://localhost/operations_m2_test',CORS_ORIGINS:'http://localhost:3000',WEB_ORIGIN:'http://localhost:3000',SESSION_SECRET:randomBytes(32).toString('hex'),BFF_SHARED_SECRET:randomBytes(32).toString('hex'),
   EMAIL_DELIVERY:'smtp',SMTP_HOST:'localhost',SMTP_PORT:'1025',EMAIL_FROM:'Operations <sender@example.test>',
   TELEGRAM_DELIVERY:'bot',TELEGRAM_BOT_TOKEN:botToken,TELEGRAM_BOT_USERNAME:'ugem_updates_bot',TELEGRAM_API_BASE:`http://127.0.0.1:${(telegram.address() as AddressInfo).port}`});
  headers={'x-workspace-key':env.BFF_SHARED_SECRET,origin:env.WEB_ORIGIN,'x-csrf-protection':'1'};
  if(!new URL(env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
  db=await new DataSource(databaseOptions(env)).initialize();await db.runMigrations();await db.query('TRUNCATE users,staff_sessions,applicant_sessions,login_attempts CASCADE');
  await db.query(`UPDATE telegram_poll_state SET "updateOffset"=0`);
  await db.getRepository(User).save({firstName:'Fictional',lastName:'Manager',email:'updates.manager@example.test',role:Role.DISPATCHER_MANAGER,status:UserStatus.ACTIVE,passwordHash:await hashPassword(password)});
  const module=await Test.createTestingModule({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true,load:[()=>env]}),TypeOrmModule.forRoot(databaseOptions(env)),AuthModule,OnboardingModule]})
   .overrideProvider(EmailService).useValue(email).compile();
  app=module.createNestApplication();closeSessions=installSessions(app,env);configureApp(app,env.CORS_ORIGINS);await app.init();
  manager=request.agent(app.getHttpServer());await manager.post('/api/auth/login').set(headers).send({email:'updates.manager@example.test',password}).expect(200);
 },30000);
 beforeEach(async()=>{await settle();emails.length=0;messages.length=0;failSend=false;await db.query('TRUNCATE invitations,applicant_sessions,login_attempts,telegram_link_tokens CASCADE');});
 afterAll(async()=>{await settle();if(closeSessions)await closeSessions();if(app)await app.close();if(db?.isInitialized){await db.query('TRUNCATE invitations CASCADE');await db.destroy();}telegram?.close();});

 it('defaults to email, requires one channel and only reaches this applicant through the applicant session',async()=>{
  const {applicant}=await submitted('first.updates@example.test');
  expect((await applicant.get('/api/applicant/updates').set(headers).expect(200)).body).toEqual({email:true,telegram:false,emailAvailable:true,telegramAvailable:true,telegramConnected:false,telegramUsername:null});
  await applicant.patch('/api/applicant/updates').set(headers).send({email:false,telegram:false}).expect(400);
  await applicant.patch('/api/applicant/updates').set(headers).send({email:true,telegram:true,chatId:'1'}).expect(400);
  await applicant.patch('/api/applicant/updates').set({...headers,origin:'https://evil.example'}).send({email:true,telegram:true}).expect(403);
  await request(app.getHttpServer()).get('/api/applicant/updates').set(headers).expect(401);
  await manager.get('/api/applicant/updates').set(headers).expect(401);
 });
 it('connects Telegram once per link, sends each decision on the chosen channels after it commits and records outcomes without content',async()=>{
  const {applicant,id,invitationId}=await submitted('second.updates@example.test');
  await applicant.patch('/api/applicant/updates').set(headers).send({email:true,telegram:true}).expect(200);
  start('hello',555);
  const {token,check}=await connect(applicant,777);
  expect(check.body).toMatchObject({telegram:true,telegramConnected:true,telegramUsername:'fictional_dispatcher'});
  expect(messages.map(message=>message.chat_id)).toEqual(['555','777']);expect(messages[1].text).toMatch(/^Connected\./);
  // A reused link is refused and the processed updates are never read again.
  start(`/start ${token}`,888);messages.length=0;
  await applicant.post('/api/applicant/updates/telegram/check').set(headers).send({}).expect(201);
  expect(messages).toEqual([{chat_id:'888',text:expect.stringMatching(/expired or was already used/)}]);
  expect(offsets.at(-1)).toBe(nextUpdate-1);expect(check.body.telegramConnected).toBe(true);
  expect(await events(invitationId)).toEqual(expect.arrayContaining(['UPDATE_PREFERENCES_CHANGED','TELEGRAM_CONNECTED']));
  messages.length=0;
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({version:2,decisionType:'REQUEST_CHANGES',reason:'Fictional correction reason',requestedFields:['personalPhoneNumber']}).expect(201);
  await settle();
  expect(emails).toHaveLength(1);expect(emails[0]).toMatchObject({to:'second.updates@example.test',subject:'Changes requested on your UGEM application'});
  expect(emails[0].text).toContain(id);expect(emails[0].text).toContain('http://localhost:3000/apply/resume');
  expect(messages).toHaveLength(1);expect(messages[0].chat_id).toBe('777');expect(messages[0].text).toContain(id);
  // Messages carry no names, phone numbers, Telegram handles or reviewer reasons.
  for(const text of [emails[0].text,messages[0].text])for(const value of ['Fictional','Alex','Demo','555 0123','fictional_demo','correction reason'])expect(text).not.toContain(value);
  const deliveries=await db.getRepository(ApplicantUpdateDelivery).findBy({applicationId:id});
  expect(deliveries.map(row=>[row.channel,row.status]).sort()).toEqual([['EMAIL','SENT'],['TELEGRAM','SENT']]);
  await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard applicant update preferences or delivery records');
 });
 it('records a failed Telegram delivery and a skipped one when Telegram was chosen but never connected',async()=>{
  const blocked=await submitted('third.updates@example.test');
  await blocked.applicant.patch('/api/applicant/updates').set(headers).send({email:true,telegram:true}).expect(200);
  await connect(blocked.applicant,999);failSend=true;
  await manager.post(`/api/onboarding/applications/${blocked.id}/reviews`).set(headers).send({version:2,decisionType:'REJECT',reason:'Fictional reason',confirmed:true}).expect(201);
  await settle();
  expect(emails.map(sent=>sent.subject)).toEqual(['An update on your UGEM application']);
  let rows=await db.getRepository(ApplicantUpdateDelivery).findBy({applicationId:blocked.id});
  expect(rows.map(row=>[row.channel,row.status,row.failureCode]).sort()).toEqual([['EMAIL','SENT',null],['TELEGRAM','FAILED','FORBIDDEN']]);
  failSend=false;emails.length=0;
  const unconnected=await submitted('fourth.updates@example.test');
  await unconnected.applicant.patch('/api/applicant/updates').set(headers).send({email:false,telegram:true}).expect(200);
  await manager.post(`/api/onboarding/applications/${unconnected.id}/reviews`).set(headers).send({version:2,decisionType:'APPROVE',confirmed:true,employmentConfirmed:true,employment:{mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'}}).expect(201);
  await settle();
  expect(emails).toHaveLength(0);
  rows=await db.getRepository(ApplicantUpdateDelivery).findBy({applicationId:unconnected.id});
  expect(rows.map(row=>[row.channel,row.status,row.failureCode])).toEqual([['TELEGRAM','SKIPPED','NOT_CONNECTED']]);
 });
 it('lets the applicant disconnect, and /stop in Telegram turns updates off',async()=>{
  const {applicant}=await submitted('fifth.updates@example.test');
  await applicant.patch('/api/applicant/updates').set(headers).send({email:false,telegram:true}).expect(200);
  await connect(applicant,4242);
  expect((await applicant.post('/api/applicant/updates/telegram/disconnect').set(headers).send({}).expect(201)).body).toMatchObject({email:true,telegram:false,telegramConnected:false,telegramUsername:null});
  await applicant.patch('/api/applicant/updates').set(headers).send({email:true,telegram:true}).expect(200);
  await connect(applicant,4343);
  start('/stop',4343);
  expect((await applicant.post('/api/applicant/updates/telegram/check').set(headers).send({}).expect(201)).body).toMatchObject({email:true,telegram:false,telegramConnected:false});
 });
});
