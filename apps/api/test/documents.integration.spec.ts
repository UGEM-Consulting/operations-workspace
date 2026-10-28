import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../src/config/environment';
import { configureApp } from '../src/common/configure-app';
import { databaseOptions } from '../src/database/options';
import { issueDemoCode } from '../src/database/demo-verification';
import { AuthModule } from '../src/modules/auth/auth.module';
import { hashPassword } from '../src/modules/auth/password';
import { installSessions } from '../src/modules/auth/session';
import { DocumentsModule } from '../src/modules/documents/documents.module';
import { ItModule } from '../src/modules/it/it.module';
import { OnboardingModule } from '../src/modules/onboarding/onboarding.module';
import {completeMfa,enrolForTest} from './mfa-helpers';
import { Role, User, UserStatus } from '../src/modules/users/user.entity';
const integration=process.env.TEST_DATABASE_URL?describe:describe.skip;
// Fictional test files: a real PDF, a JPEG-signature blob (the API checks type and size only) and a real PNG signature.
async function pdf(pages=2){const doc=await PDFDocument.create();for(let i=0;i<pages;i++)doc.addPage([612,792]).drawText(`Fictional test document page ${i+1}`,{x:72,y:700});return Buffer.from(await doc.save());}
const jpeg=()=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),randomBytes(4000)]);
function png(width=60,height=20){
 const chunk=(type:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(type,'latin1'),data]);const length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(body));return Buffer.concat([length,body,crc]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header.set([8,6,0,0,0],8);
 const rows=Buffer.concat(Array.from({length:height},()=>Buffer.concat([Buffer.from([0]),randomBytes(width*4)])));
 return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
const signature=()=>`data:image/png;base64,${png().toString('base64')}`;
const binary=(res:request.Response,callback:(error:Error|null,body:Buffer)=>void)=>{const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>chunks.push(chunk));res.on('end',()=>callback(null,Buffer.concat(chunks)));};
const sha=(body:Buffer)=>createHash('sha256').update(body).digest('hex');
integration('Onboarding photos, documents and e-signatures (disposable PostgreSQL)',()=>{
 let app:INestApplication,db:DataSource,closeSessions:()=>Promise<void>;
 const storage=mkdtempSync(join(tmpdir(),'operations-documents-'));
 const password=randomBytes(24).toString('base64url');
 const env=validateEnvironment({NODE_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_URL??'postgresql://localhost/operations_m2_test',CORS_ORIGINS:'http://localhost:3000',WEB_ORIGIN:'http://localhost:3000',SESSION_SECRET:randomBytes(32).toString('hex'),BFF_SHARED_SECRET:randomBytes(32).toString('hex'),STORAGE_DRIVER:'local',STORAGE_LOCAL_DIR:storage,MFA_ENCRYPTION_KEY:randomBytes(32).toString('base64')});
 const headers={'x-workspace-key':env.BFF_SHARED_SECRET,origin:env.WEB_ORIGIN,'x-csrf-protection':'1'};
 type Agent=ReturnType<typeof request.agent>;
 let manager:Agent,other:Agent,admin:Agent,itAgent:Agent;
 const answers={firstName:'Fictional',lastName:'Applicant',personalPhoneNumber:'+1 202 555 0123',preferredAmericanFirstName:'Alex',preferredAmericanLastName:'Demo',mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'};
 async function applicant(){
  const created=await manager.post('/api/onboarding/invitations').set(headers).send({email:'fictional.signer@example.test'}).expect(201);
  const agent=request.agent(app.getHttpServer());
  const begin=await agent.post('/api/applicant/begin').set(headers).send({email:'fictional.signer@example.test',token:created.body.url.split('#').pop()}).expect(201);
  const verified=await agent.post('/api/applicant/verify').set(headers).send({challengeId:begin.body.challengeId,code:await issueDemoCode(db,begin.body.challengeId,'test')}).expect(201);
  await agent.patch('/api/applicant/draft').set(headers).send({version:0,...answers}).expect(200);
  return {agent,id:verified.body.applicationId as string};
 }
 async function publishAll(){
  const files={NDA:await pdf(3),SOP:await pdf(2),CONTACT_LIST:await pdf(1)};
  for(const [kind,file] of Object.entries(files))await manager.post('/api/documents').set(headers).send({kind,title:`Fictional ${kind}`,file:file.toString('base64')}).expect(201);
  return files;
 }
 async function completeDocuments(agent:Agent){
  await agent.post('/api/applicant/photos/selfie').set(headers).send({image:jpeg().toString('base64')}).expect(201);
  let view=(await agent.post('/api/applicant/photos/id-selfie').set(headers).send({image:jpeg().toString('base64')}).expect(201)).body;
  for(const doc of view.documents.items){
   await agent.get(`/api/applicant/documents/${doc.id}/file`).set(headers).expect(200);
   view=(await agent.post(`/api/applicant/documents/${doc.id}/sign`).set({...headers,'x-client-ip':'203.0.113.7','x-client-user-agent':'Fictional Browser 1.0'})
    .send({typedName:'Fictional Applicant',consent:true,agreed:true,...(doc.requiresSignature?{signature:signature()}:{})}).expect(201)).body;
  }
  return view;
 }
 beforeAll(async()=>{
  if(!new URL(env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
  db=await new DataSource(databaseOptions(env)).initialize();await db.runMigrations();
  await db.query('TRUNCATE company_documents,users,staff_sessions,applicant_sessions,login_attempts CASCADE');
  const hash=await hashPassword(password);
  for(const [index,role] of [Role.DISPATCHER_MANAGER,Role.DISPATCHER_MANAGER,Role.SYSTEM_ADMIN,Role.IT_SPECIALIST].entries())await db.getRepository(User).save({firstName:'Fictional',lastName:'Staff',email:`staff${index}@example.test`,role,status:UserStatus.ACTIVE,passwordHash:hash});
  const module=await Test.createTestingModule({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true,load:[()=>env]}),TypeOrmModule.forRoot(databaseOptions(env)),AuthModule,OnboardingModule,ItModule,DocumentsModule]}).compile();
  app=module.createNestApplication();closeSessions=installSessions(app,env);configureApp(app,env.CORS_ORIGINS);await app.init();
  const adminUser=await db.getRepository(User).findOneByOrFail({email:'staff2@example.test'});const adminSecret=await enrolForTest(db,env.MFA_ENCRYPTION_KEY!,adminUser.id);
  const agents=[];for(let i=0;i<4;i++){const agent=request.agent(app.getHttpServer());const signedIn=await agent.post('/api/auth/login').set(headers).send({email:`staff${i}@example.test`,password}).expect(200);if(signedIn.body.mfa)expect((await completeMfa(agent,headers,db,adminUser.id,adminSecret)).status).toBe(200);agents.push(agent);}[manager,other,admin,itAgent]=agents;
 },30000);
 beforeEach(async()=>{await db.query('TRUNCATE company_documents,invitations,applicant_sessions,login_attempts CASCADE');});
 afterAll(async()=>{
  if(db?.isInitialized){await db.query('TRUNCATE company_documents,invitations CASCADE');await db.destroy();}
  if(closeSessions)await closeSessions();if(app)await app.close();rmSync(storage,{recursive:true,force:true});
 });
 it('lets managers and administrators publish immutable, versioned PDFs and refuses IT and invalid files',async()=>{
  const file=await pdf(2);
  await itAgent.post('/api/documents').set(headers).send({kind:'NDA',title:'NDA',file:file.toString('base64')}).expect(403);
  await manager.post('/api/documents').set(headers).send({kind:'NDA',title:'NDA',file:Buffer.from('not a pdf').toString('base64')}).expect(400);
  await manager.post('/api/documents').set(headers).send({kind:'NDA',title:'NDA',file:Buffer.from('%PDF-1.7 broken').toString('base64')}).expect(400);
  await manager.post('/api/documents').set(headers).send({kind:'OTHER',title:'NDA',file:file.toString('base64')}).expect(400);
  const first=await manager.post('/api/documents').set(headers).send({kind:'NDA',title:'Fictional NDA',file:file.toString('base64')}).expect(201);
  const second=await admin.post('/api/documents').set(headers).send({kind:'NDA',title:'Fictional NDA',file:(await pdf(3)).toString('base64')}).expect(201);
  expect([first.body.version,second.body.version,first.body.pageCount,first.body.sha256]).toEqual([1,2,2,sha(file)]);
  const list=await other.get('/api/documents').set(headers).expect(200);
  expect(list.body.kinds.find((kind:{kind:string})=>kind.kind==='NDA').versions.map((version:{version:number})=>version.version)).toEqual([2,1]);
  const download=await other.get(`/api/documents/${first.body.id}/file`).set(headers).buffer(true).parse(binary).expect(200);
  expect(download.headers['content-type']).toBe('application/pdf');expect(download.headers['cache-control']).toContain('no-store');expect(sha(download.body)).toBe(sha(file));
  await expect(db.query(`UPDATE company_documents SET title='Changed' WHERE id=$1`,[first.body.id])).rejects.toThrow('append-only');
  await expect(db.query(`DELETE FROM company_documents WHERE id=$1`,[first.body.id])).rejects.toThrow('append-only');
 });
 it('requires both photos and every published document before submission, records signing evidence and keeps signatures append-only',async()=>{
  await publishAll();
  const {agent,id}=await applicant();
  let view=(await agent.get('/api/applicant/application').set(headers).expect(200)).body;
  expect(view.documents).toMatchObject({required:true,missing:['selfiePhoto','idPhoto','documents']});
  expect(view.documents.items.map((doc:{kind:string;requiresSignature:boolean})=>[doc.kind,doc.requiresSignature])).toEqual([['NDA',true],['SOP',true],['CONTACT_LIST',false]]);
  await agent.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(400);
  await agent.post('/api/applicant/photos/selfie').set(headers).send({image:Buffer.from('not a photo').toString('base64')}).expect(400);
  await agent.post('/api/applicant/photos/passport').set(headers).send({image:jpeg().toString('base64')}).expect(404);
  await request(app.getHttpServer()).post('/api/applicant/photos/selfie').set(headers).send({image:jpeg().toString('base64')}).expect(401);
  // Replacing a draft photo discards the earlier file.
  await agent.post('/api/applicant/photos/selfie').set(headers).send({image:jpeg().toString('base64')}).expect(201);
  const replacement=jpeg();await agent.post('/api/applicant/photos/selfie').set(headers).send({image:replacement.toString('base64')}).expect(201);
  expect(readdirSync(join(storage,'photos',id))).toHaveLength(1);
  expect(sha((await agent.get('/api/applicant/photos/selfie').set(headers).expect(200)).body)).toBe(sha(replacement));
  const nda=view.documents.items[0];
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:true,agreed:true,signature:signature()}).expect(400);
  await agent.get(`/api/applicant/documents/${nda.id}/file`).set(headers).buffer(true).parse(binary).expect(200);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:true,agreed:true}).expect(400);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Фиктивный',consent:true,agreed:true,signature:signature()}).expect(400);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:false,agreed:true,signature:signature()}).expect(400);
  view=await completeDocuments(agent);
  expect(view.documents.missing).toEqual([]);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:true,agreed:true,signature:signature()}).expect(409);
  const [evidence]=await db.query(`SELECT "ipAddress","userAgent",consent,statement,"documentSha256","signatureImage" IS NOT NULL AS drawn FROM document_signatures WHERE "documentId"=$1`,[nda.id]);
  expect(evidence).toMatchObject({ipAddress:'203.0.113.7',userAgent:'Fictional Browser 1.0',drawn:true});
  expect(evidence.statement).toContain('version 1');expect(evidence.consent).toContain('electronically');
  const [contact]=await db.query(`SELECT "signatureImage" FROM document_signatures WHERE "documentId"=$1`,[view.documents.items[2].id]);expect(contact.signatureImage).toBeNull();
  await expect(db.query(`UPDATE document_signatures SET "typedName"='Someone Else'`)).rejects.toThrow('append-only');
  await expect(db.query(`DELETE FROM document_signatures`)).rejects.toThrow('append-only');
  const submitted=await agent.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(201);
  expect(submitted.body.application.status).toBe('SUBMITTED');
  // Submitted applications are no longer open for photo changes or signatures.
  await agent.post('/api/applicant/photos/selfie').set(headers).send({image:jpeg().toString('base64')}).expect(409);
  const copy=await agent.get(`/api/applicant/documents/${nda.id}/signed`).set(headers).buffer(true).parse(binary).expect(200);
  expect((await PDFDocument.load(copy.body)).getPageCount()).toBe(4);
 });
 it('shows photos only to the responsible manager or an administrator, requires the NDA countersignature at approval and gives IT only the profile photo',async()=>{
  await publishAll();
  const {agent,id}=await applicant();await completeDocuments(agent);
  await agent.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(201);
  let detail=(await manager.get(`/api/onboarding/applications/${id}`).set(headers).expect(200)).body;
  expect(detail.documents.photos).toEqual({selfie:true,idSelfie:true});expect(detail.requiredFields).toEqual([]);
  expect(detail.documents.countersign).toMatchObject({title:'Fictional NDA',version:1});
  expect(detail.documents.items.every((doc:{applicant:unknown})=>doc.applicant)).toBe(true);
  await manager.get(`/api/onboarding/applications/${id}/photos/id-selfie`).set(headers).expect(200);
  await admin.get(`/api/onboarding/applications/${id}/photos/id-selfie`).set(headers).expect(200);
  await other.get(`/api/onboarding/applications/${id}/photos/id-selfie`).set(headers).expect(404);
  await itAgent.get(`/api/onboarding/applications/${id}/photos/id-selfie`).set(headers).expect(403);
  const approve={version:2,decisionType:'APPROVE',confirmed:true,employmentConfirmed:true,employment:{mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'}};
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send(approve).expect(400);
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({...approve,decisionType:'REJECT',reason:'Fictional',countersignature:{typedName:'Fictional Manager',signature:signature(),agreed:true}}).expect(400);
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set({...headers,'x-client-ip':'198.51.100.4'}).send({...approve,countersignature:{typedName:'Fictional Manager',signature:signature(),agreed:true}}).expect(201);
  detail=(await manager.get(`/api/onboarding/applications/${id}`).set(headers).expect(200)).body;
  const nda=detail.documents.items.find((doc:{kind:string})=>doc.kind==='NDA');
  expect(nda.company).toMatchObject({typedName:'Fictional Manager'});expect(detail.documents.countersign).toBeNull();
  const [company]=await db.query(`SELECT "ipAddress",statement FROM document_signatures WHERE "signerRole"='COMPANY'`);
  expect(company.ipAddress).toBe('198.51.100.4');expect(company.statement).toContain('signed by Fictional Applicant');
  const copy=await manager.get(`/api/onboarding/applications/${id}/documents/${nda.applicant.documentId}/signed`).set(headers).buffer(true).parse(binary).expect(200);
  expect((await PDFDocument.load(copy.body)).getPageCount()).toBe(4);
  const queue=await itAgent.get('/api/it/onboarding').set(headers).expect(200),requestId=queue.body.items[0].id;
  expect((await itAgent.get(`/api/it/onboarding/${requestId}`).set(headers).expect(200)).body.request.profilePhoto).toBe(true);
  const photo=await itAgent.get(`/api/it/onboarding/${requestId}/photo`).set(headers).expect(200);
  expect(photo.headers['content-type']).toBe('image/jpeg');
  await manager.get(`/api/it/onboarding/${requestId}/photo`).set(headers).expect(403);
  // The IT route never exposes the ID selfie, and documents are not readable through IT routes.
  expect(sha(photo.body)).toBe(sha((await manager.get(`/api/onboarding/applications/${id}/photos/selfie`).set(headers).expect(200)).body));
 });
 it('lets managers request a new photo while staff keep seeing the submitted one until resubmission',async()=>{
  await publishAll();
  const {agent,id}=await applicant();await completeDocuments(agent);
  await agent.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(201);
  const reviewed=sha((await manager.get(`/api/onboarding/applications/${id}/photos/selfie`).set(headers).expect(200)).body);
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({version:2,decisionType:'REQUEST_CHANGES',reason:'Please retake the selfie in better light.',requestedFields:['selfiePhoto']}).expect(201);
  const view=(await agent.get('/api/applicant/application').set(headers).expect(200)).body;
  expect(view.editableFields).toEqual(['selfiePhoto']);
  await agent.post('/api/applicant/photos/id-selfie').set(headers).send({image:jpeg().toString('base64')}).expect(409);
  const retaken=jpeg();await agent.post('/api/applicant/photos/selfie').set(headers).send({image:retaken.toString('base64')}).expect(201);
  expect(sha((await manager.get(`/api/onboarding/applications/${id}/photos/selfie`).set(headers).expect(200)).body)).toBe(reviewed);
  await agent.post('/api/applicant/submit').set(headers).send({version:3,accurate:true,...answers}).expect(201);
  expect(sha((await manager.get(`/api/onboarding/applications/${id}/photos/selfie`).set(headers).expect(200)).body)).toBe(sha(retaken));
  // The reviewed photo is kept as evidence of what was reviewed; only unsent replacements are discarded.
  expect(readdirSync(join(storage,'photos',id))).toHaveLength(3);
 });
 it('refuses to roll back the documents migration while documents or photos exist',async()=>{
  await publishAll();
  // The newer staff MFA migration goes first; it refuses rollback while enrolments exist.
  await db.query(`DELETE FROM it_onboarding_tasks WHERE key='EQUIPMENT'`);await db.undoLastMigration();
  await db.query('TRUNCATE applicant_update_deliveries,applicant_update_settings,telegram_link_tokens');await db.undoLastMigration();
  await db.query('TRUNCATE staff_mfa,staff_mfa_recovery_codes,staff_security_events');await db.undoLastMigration();
  await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard company documents');
  await db.runMigrations();
 });
});
