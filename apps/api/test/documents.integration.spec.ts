import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
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
import { ApplicantSignedCopies } from '../src/modules/documents/signed-copies';
import { ItModule } from '../src/modules/it/it.module';
import { OnboardingModule } from '../src/modules/onboarding/onboarding.module';
import {completeMfa,enrolForTest} from './mfa-helpers';
import { jpeg, pdfText, png, pngChunk, pngHeader, PNG_SIGNATURE } from './documents.fixtures';
import { SignatureMethod1792750000000 } from '../src/database/migrations/1792750000000-SignatureMethod';
import { SavedStaffSignatures1792780000000 } from '../src/database/migrations/1792780000000-SavedStaffSignatures';
import { cleanJpeg } from '../src/modules/documents/images';
import { Role, User, UserStatus } from '../src/modules/users/user.entity';
const integration=process.env.TEST_DATABASE_URL?describe:describe.skip;
// Fictional test files: a real PDF, structurally valid JPEG photos (with fictional EXIF to strip) and PNG signatures.
async function pdf(pages=2){const doc=await PDFDocument.create();for(let i=0;i<pages;i++)doc.addPage([612,792]).drawText(`Fictional test document page ${i+1}`,{x:72,y:700});return Buffer.from(await doc.save());}
const signature=()=>`data:image/png;base64,${png(600,180).toString('base64')}`;
const binary=(res:request.Response,callback:(error:Error|null,body:Buffer)=>void)=>{const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>chunks.push(chunk));res.on('end',()=>callback(null,Buffer.concat(chunks)));};
const sha=(body:Buffer)=>createHash('sha256').update(body).digest('hex');
integration('Onboarding photos, documents and e-signatures (disposable PostgreSQL)',()=>{
 let app:INestApplication,db:DataSource,closeSessions:()=>Promise<void>;
 const storage=mkdtempSync(join(tmpdir(),'operations-documents-'));
 // An applicant's photos: applicants/<application>/(selfie|id-selfie)/<photo>.jpg.
 const photoFiles=(id:string)=>existsSync(join(storage,'applicants',id))?readdirSync(join(storage,'applicants',id),{recursive:true}).map(String).filter(name=>name.endsWith('.jpg')):[];
 const password=randomBytes(24).toString('base64url');
 const env=validateEnvironment({NODE_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_URL??'postgresql://localhost/operations_m2_test',CORS_ORIGINS:'http://localhost:3000',WEB_ORIGIN:'http://localhost:3000',SESSION_SECRET:randomBytes(32).toString('hex'),BFF_SHARED_SECRET:randomBytes(32).toString('hex'),STORAGE_DRIVER:'local',STORAGE_LOCAL_DIR:storage,MFA_ENCRYPTION_KEY:randomBytes(32).toString('base64')});
 const headers={'x-workspace-key':env.BFF_SHARED_SECRET,origin:env.WEB_ORIGIN,'x-csrf-protection':'1'};
 const latestMigration=async()=>(await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name as string;
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
   await agent.post(`/api/applicant/documents/${doc.id}/view`).set(headers).send({}).expect(201);
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
  // Tests run the signed-copy job themselves.
  app.get(ApplicantSignedCopies).archive.stop();
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
  expect(photoFiles(id)).toHaveLength(1);
  expect(sha((await agent.get('/api/applicant/photos/selfie').set(headers).expect(200)).body)).toBe(sha(cleanJpeg(replacement)));
  const nda=view.documents.items[0];
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:true,agreed:true,signature:signature()}).expect(400);
  // Fetching the file is not signing evidence; only the explicit view request from the signing page is.
  await agent.get(`/api/applicant/documents/${nda.id}/file`).set(headers).buffer(true).parse(binary).expect(200);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:true,agreed:true,signature:signature()}).expect(400);
  expect((await db.query('SELECT count(*)::integer AS n FROM document_views'))[0].n).toBe(0);
  await request(app.getHttpServer()).post(`/api/applicant/documents/${nda.id}/view`).set(headers).send({}).expect(401);
  await agent.post(`/api/applicant/documents/${randomUUID()}/view`).set(headers).send({}).expect(404);
  await agent.post(`/api/applicant/documents/${nda.id}/view`).set({...headers,'x-csrf-protection':'0'}).send({}).expect(403);
  const firstView=(await agent.post(`/api/applicant/documents/${nda.id}/view`).set(headers).send({}).expect(201)).body.firstViewedAt;
  expect((await agent.post(`/api/applicant/documents/${nda.id}/view`).set(headers).send({}).expect(201)).body.firstViewedAt).toBe(firstView);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:true,agreed:true}).expect(400);
  // A tiny PNG declaring a huge bitmap is refused before anything is stored.
  const bomb=Buffer.concat([PNG_SIGNATURE,pngHeader(16000,16000),pngChunk('IDAT',deflateSync(Buffer.alloc(100000))),pngChunk('IEND',Buffer.alloc(0))]);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:true,agreed:true,signature:`data:image/png;base64,${bomb.toString('base64')}`}).expect(400);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:true,agreed:true,signature:signature(),signatureMethod:'STAMPED'}).expect(400);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Фиктивный',consent:true,agreed:true,signature:signature()}).expect(400);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:false,agreed:true,signature:signature()}).expect(400);
  view=await completeDocuments(agent);
  expect(view.documents.missing).toEqual([]);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:true,agreed:true,signature:signature()}).expect(409);
  const [evidence]=await db.query(`SELECT "ipAddress","userAgent",consent,statement,"documentSha256","signatureMethod","signatureImage" IS NOT NULL AS drawn FROM document_signatures WHERE "documentId"=$1`,[nda.id]);
  expect(evidence).toMatchObject({ipAddress:'203.0.113.7',userAgent:'Fictional Browser 1.0',drawn:true,signatureMethod:'DRAWN'});
  expect(evidence.statement).toContain('version 1');expect(evidence.consent).toContain('electronically');
  const [contact]=await db.query(`SELECT "signatureImage","signatureMethod" FROM document_signatures WHERE "documentId"=$1`,[view.documents.items[2].id]);expect(contact).toEqual({signatureImage:null,signatureMethod:null});
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
  // Signed copies are saved into the applicant's own folder once complete: the SOP and contact list now, the NDA only
  // after the manager countersigns at approval.
  const archive=app.get(ApplicantSignedCopies).archive,signed=(name:string)=>existsSync(join(storage,'applicants',id,'signed',`${name}.pdf`));
  expect(await archive.run()).toBe(2);
  expect(['nda-v1','sop-v1','contact-list-v1'].map(signed)).toEqual([false,true,true]);
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
  expect(await archive.run()).toBe(1);
  const saved=readFileSync(join(storage,'applicants',id,'signed','nda-v1.pdf'));
  expect((await PDFDocument.load(saved)).getPageCount()).toBe(4);
  expect(await db.query(`SELECT "storageKey",sha256 FROM signed_copies WHERE "applicationId"=$1 AND "companyDocumentId"=$2`,[id,nda.applicant.documentId])).toEqual([{storageKey:`applicants/${id}/signed/nda-v1.pdf`,sha256:sha(saved)}]);
  expect(await archive.run()).toBe(0);
  // Every file sits in the applicant's folder; the blank NDA, SOP and contact list under company-documents/onboarding/.
  expect(readdirSync(join(storage,'applicants',id))).toEqual(expect.arrayContaining(['selfie','id-selfie','signed']));
  expect(readdirSync(join(storage,'company-documents','onboarding')).sort()).toEqual(['contact-list','nda','sop']);
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
  expect(sha((await manager.get(`/api/onboarding/applications/${id}/photos/selfie`).set(headers).expect(200)).body)).toBe(sha(cleanJpeg(retaken)));
  // The reviewed photo is kept as evidence of what was reviewed; only unsent replacements are discarded.
  expect(photoFiles(id)).toHaveLength(3);
 });
 it('refuses to roll back the documents migration while documents or photos exist',async()=>{
  await publishAll();
  // Newer migrations go first, each after removing the records its rollback refuses to discard.
  const cleanup:Record<string,string>={DriverDocuments1792880000000:`TRUNCATE drivers CASCADE; TRUNCATE driver_sessions, driver_challenges`,DriverApplications1792870000000:`TRUNCATE drivers CASCADE; TRUNCATE driver_sessions, driver_challenges`,SafetyDrivers1792860000000:`TRUNCATE drivers CASCADE; DELETE FROM users WHERE role::text LIKE 'SAFETY_%'`,TeamLeads1792850000000:`UPDATE dispatch_members SET "accountUserId" = NULL; TRUNCATE promotion_requests; DELETE FROM dispatch_events WHERE event LIKE 'PROMOTION_%'; DELETE FROM users WHERE role::text = 'TEAM_LEAD'`,SupportMembers1792840000000:`TRUNCATE member_support_links; UPDATE invitations SET position = 'DISPATCHER', "supportsMemberId" = NULL WHERE position = 'SUPPORT'; DELETE FROM dispatch_events WHERE event = 'SUPPORT_REASSIGNED'`,DispatcherContacts1792830000000:'TRUNCATE member_contacts',DispatchTeams1792820000000:'TRUNCATE dispatch_events',ManagedLists1792810000000:'TRUNCATE list_events',OptionalEquipmentTask1792740000000:`DELETE FROM it_onboarding_tasks WHERE key='EQUIPMENT'`,
   ApplicantUpdates1792730000000:'TRUNCATE applicant_update_deliveries,applicant_update_settings,telegram_link_tokens',StaffMfa1792720000000:'TRUNCATE staff_mfa,staff_mfa_recovery_codes,staff_security_events'};
  // Files in the per-person folders can't be rolled back to the flat layout either; mark these test rows as flat to go on.
  expect(await latestMigration()).toBe('StorageFolders1792920000000');
  await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard files stored in the per-person folders');
  await db.query(`TRUNCATE signed_copies; ALTER TABLE company_documents DISABLE TRIGGER company_documents_append_only; UPDATE company_documents SET "storageLayout" = 1; ALTER TABLE company_documents ENABLE TRIGGER company_documents_append_only`);
  for(let name=await latestMigration();name!=='OnboardingDocuments1792710000000';name=await latestMigration()){if(cleanup[name])await db.query(cleanup[name]);await db.undoLastMigration();}
  await expect(db.undoLastMigration()).rejects.toThrow('Cannot discard company documents');
  await db.runMigrations();
 });
 it('strips photo metadata on the server before storing it',async()=>{
  await publishAll();
  const {agent,id}=await applicant();
  const original=jpeg();
  await agent.post('/api/applicant/photos/selfie').set(headers).send({image:original.toString('base64')}).expect(201);
  const stored=(await agent.get('/api/applicant/photos/selfie').set(headers).buffer(true).parse(binary).expect(200)).body as Buffer;
  expect(stored.toString('latin1')).not.toContain('Exif');expect(stored.toString('latin1')).not.toContain('GPS');expect(stored.toString('latin1')).not.toContain('TRAILING');
  const [row]=await db.query('SELECT sha256,"byteSize" FROM applicant_photos WHERE "applicationId"=$1',[id]);
  expect(row).toEqual({sha256:sha(stored),byteSize:stored.length});expect(stored.length).toBeLessThan(original.length);
  await agent.post('/api/applicant/photos/id-selfie').set(headers).send({image:jpeg({width:9000}).toString('base64')}).expect(400);
  expect(photoFiles(id)).toHaveLength(1);
 });
 it('checks the applicant session and editability before storing a photo',async()=>{
  await publishAll();
  const {agent,id}=await applicant();await completeDocuments(agent);
  await agent.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(201);
  const before=photoFiles(id).length;
  await agent.post('/api/applicant/photos/selfie').set(headers).send({image:jpeg().toString('base64')}).expect(409);
  await db.query(`UPDATE dispatcher_applications SET "applicantAccessUntil"=now()-interval '1 minute' WHERE id=$1`,[id]);
  await agent.post('/api/applicant/photos/selfie').set(headers).send({image:jpeg().toString('base64')}).expect(401);
  expect(photoFiles(id)).toHaveLength(before);
 });
 it('requires a signature on the current version once a new version is published, and records typed signatures',async()=>{
  await publishAll();
  const {agent,id}=await applicant();await completeDocuments(agent);
  const nda=await manager.post('/api/documents').set(headers).send({kind:'NDA',title:'Fictional NDA',file:(await pdf(2)).toString('base64')}).expect(201);
  let view=(await agent.get('/api/applicant/application').set(headers).expect(200)).body;
  expect(view.documents.missing).toEqual(['documents']);
  expect(view.documents.items[0]).toMatchObject({id:nda.body.id,version:2,signed:{version:1}});
  await agent.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(400);
  await agent.post(`/api/applicant/documents/${nda.body.id}/view`).set(headers).send({}).expect(201);
  view=(await agent.post(`/api/applicant/documents/${nda.body.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:true,agreed:true,signature:signature(),signatureMethod:'TYPED'}).expect(201)).body;
  expect(view.documents.missing).toEqual([]);expect(view.documents.items[0].signed).toMatchObject({documentId:nda.body.id,version:2});
  const [typed]=await db.query(`SELECT "signatureMethod" FROM document_signatures WHERE "documentId"=$1`,[nda.body.id]);expect(typed.signatureMethod).toBe('TYPED');
  await agent.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(201);
  // A version published after submission blocks approval until the applicant signs it in a correction round.
  const sop=await admin.post('/api/documents').set(headers).send({kind:'SOP',title:'Fictional SOP',file:(await pdf(1)).toString('base64')}).expect(201);
  const detail=(await manager.get(`/api/onboarding/applications/${id}`).set(headers).expect(200)).body;
  expect(detail.requiredFields).toContain('documents');
  const approve={version:2,decisionType:'APPROVE',confirmed:true,employmentConfirmed:true,employment:{mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'},countersignature:{typedName:'Fictional Manager',signature:signature(),agreed:true}};
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send(approve).expect(400);
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({version:2,decisionType:'REQUEST_CHANGES',reason:'Please sign the new SOP.',requestedFields:['documents']}).expect(201);
  view=(await agent.get('/api/applicant/application').set(headers).expect(200)).body;
  expect(view.editableFields).toContain('documents');expect(view.documents.items[1]).toMatchObject({id:sop.body.id,signed:{version:1}});
 });
 it('gives the applicant a signed copy without the countersigner IP address and browser, and rate-limits copies',async()=>{
  await publishAll();
  const {agent,id}=await applicant();const view=await completeDocuments(agent);
  await agent.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(201);
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set({...headers,'x-client-ip':'198.51.100.4','x-client-user-agent':'Fictional Manager Browser'})
   .send({version:2,decisionType:'APPROVE',confirmed:true,employmentConfirmed:true,employment:{mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'},countersignature:{typedName:'Fictional Manager',signature:signature(),agreed:true}}).expect(201);
  const nda=view.documents.items[0].id;
  const own=pdfText((await agent.get(`/api/applicant/documents/${nda}/signed`).set(headers).buffer(true).parse(binary).expect(200)).body);
  const staff=pdfText((await manager.get(`/api/onboarding/applications/${id}/documents/${nda}/signed`).set(headers).buffer(true).parse(binary).expect(200)).body);
  expect(own).toContain('203.0.113.7');expect(own).toContain('Recorded by UGEM');expect(own).not.toContain('198.51.100.4');expect(own).not.toContain('Fictional Manager Browser');
  expect(staff).toContain('198.51.100.4');expect(staff).toContain('Fictional Manager Browser');
  for(let i=0;i<29;i++)await agent.get(`/api/applicant/documents/${nda}/signed`).set(headers).expect(200);
  await agent.get(`/api/applicant/documents/${nda}/signed`).set(headers).expect(429);
 },60000);
 it('gives IT the profile photo only through the APPROVE review the request was created from',async()=>{
  await publishAll();
  const {agent,id}=await applicant();await completeDocuments(agent);
  await agent.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(201);
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({version:2,decisionType:'REQUEST_CHANGES',reason:'Please confirm your phone number.',requestedFields:['personalPhoneNumber']}).expect(201);
  await agent.post('/api/applicant/submit').set(headers).send({version:3,...answers,accurate:true}).expect(201);
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({version:4,decisionType:'APPROVE',confirmed:true,employmentConfirmed:true,employment:{mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'},countersignature:{typedName:'Fictional Manager',signature:signature(),agreed:true}}).expect(201);
  const [itRequest]=await db.query('SELECT id,"approvalId" FROM it_onboarding_requests WHERE "applicationId"=$1',[id]);
  await itAgent.get(`/api/it/onboarding/${itRequest.id}/photo`).set(headers).expect(200);
  // Linked to the change-request review instead of the approval: refused, like every other IT access.
  const [changeRequest]=await db.query(`SELECT id FROM application_reviews WHERE "applicationId"=$1 AND "decisionType"='REQUEST_CHANGES'`,[id]);
  await db.query('UPDATE it_onboarding_requests SET "approvalId"=$1 WHERE id=$2',[changeRequest.id,itRequest.id]);
  await itAgent.get(`/api/it/onboarding/${itRequest.id}/photo`).set(headers).expect(404);
  await db.query('UPDATE it_onboarding_requests SET "approvalId"=$1 WHERE id=$2',[itRequest.approvalId,itRequest.id]);
 });
 it('refuses to roll back the signature method while typed signatures exist',async()=>{
  await publishAll();
  const {agent}=await applicant();
  const nda=(await agent.get('/api/applicant/application').set(headers).expect(200)).body.documents.items[0];
  await agent.post(`/api/applicant/documents/${nda.id}/view`).set(headers).send({}).expect(201);
  await agent.post(`/api/applicant/documents/${nda.id}/sign`).set(headers).send({typedName:'Fictional Applicant',consent:true,agreed:true,signature:signature(),signatureMethod:'TYPED'}).expect(201);
  const runner=db.createQueryRunner();
  try { await expect(new SignatureMethod1792750000000().down(runner)).rejects.toThrow('Cannot discard typed signature records'); } finally { await runner.release(); }
 });
 it('saves an approver signature privately, applies it at approval and keeps signed copies unchanged when it is replaced or removed',async()=>{
  await db.query('TRUNCATE staff_saved_signatures');const started=new Date();
  await itAgent.get('/api/staff/signature').set(headers).expect(403);
  expect((await manager.get('/api/staff/signature').set(headers).expect(200)).body.saved).toBeNull();
  const typed=`data:image/png;base64,${png(600,180).toString('base64')}`;
  await manager.post('/api/staff/signature').set(headers).send({typedName:'Fictional Saved Manager',signature:typed,signatureMethod:'TYPED'}).expect(400);
  await manager.post('/api/staff/signature').set(headers).send({typedName:'Fictional Saved Manager',signature:`data:image/png;base64,${png(16000,16000).toString('base64')}`,signatureMethod:'DRAWN',agreed:true}).expect(400);
  const saved=(await manager.post('/api/staff/signature').set(headers).send({typedName:'Fictional Saved Manager',signature:typed,signatureMethod:'TYPED',agreed:true}).expect(201)).body.saved;
  expect(saved).toMatchObject({typedName:'Fictional Saved Manager',signatureMethod:'TYPED'});expect(saved.image).toBe(typed);
  // Private to its owner: another manager sees only their own (none).
  expect((await other.get('/api/staff/signature').set(headers).expect(200)).body.saved).toBeNull();
  await publishAll();
  const {agent,id}=await applicant();const view=await completeDocuments(agent);
  await agent.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(201);
  const approve={version:2,decisionType:'APPROVE',confirmed:true,employmentConfirmed:true,employment:{mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher'}};
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({...approve,countersignature:{useSavedSignature:true}}).expect(400);
  await manager.post(`/api/onboarding/applications/${id}/reviews`).set(headers).send({...approve,countersignature:{useSavedSignature:true,agreed:true}}).expect(201);
  const [row]=await db.query(`SELECT "typedName","signatureMethod","fromSavedSignature","signatureImage" FROM document_signatures WHERE "applicationId"=$1 AND "signerRole"='COMPANY'`,[id]);
  expect(row).toMatchObject({typedName:'Fictional Saved Manager',signatureMethod:'TYPED',fromSavedSignature:true});
  const nda=view.documents.items[0].id;
  const copy=async()=>(await manager.get(`/api/onboarding/applications/${id}/documents/${nda}/signed`).set(headers).buffer(true).parse(binary).expect(200)).body as Buffer;
  expect(pdfText(await copy())).toContain('applied from their saved signature');
  // Replacing or removing the saved signature never touches the signed record.
  await manager.post('/api/staff/signature').set(headers).send({typedName:'Fictional Saved Manager',signature:`data:image/png;base64,${png(400,120).toString('base64')}`,signatureMethod:'DRAWN',agreed:true}).expect(201);
  await manager.post('/api/staff/signature/delete').set(headers).send({}).expect(201);
  await manager.post('/api/staff/signature/delete').set(headers).send({}).expect(404);
  const [after]=await db.query(`SELECT "signatureImage" FROM document_signatures WHERE "applicationId"=$1 AND "signerRole"='COMPANY'`,[id]);
  expect(sha(after.signatureImage)).toBe(sha(row.signatureImage));
  // With nothing saved, a second approval must sign in the dialog instead.
  const second=await applicant();await completeDocuments(second.agent);
  await second.agent.post('/api/applicant/submit').set(headers).send({version:1,...answers,accurate:true}).expect(201);
  const refused=await manager.post(`/api/onboarding/applications/${second.id}/reviews`).set(headers).send({...approve,countersignature:{useSavedSignature:true,agreed:true}}).expect(400);
  expect(refused.body.message).toContain('saved signature is no longer available');
  const events=await db.query(`SELECT type,metadata FROM staff_security_events WHERE type LIKE 'STAFF_SIGNATURE_%' AND "createdAt">=$1 ORDER BY "createdAt"`,[started]);
  expect(events.map((event:{type:string})=>event.type)).toEqual(['STAFF_SIGNATURE_SAVED','STAFF_SIGNATURE_SAVED','STAFF_SIGNATURE_DELETED']);
  expect(JSON.stringify(events)).not.toContain('Fictional Saved Manager');
 },60000);
 it('refuses to roll back saved signatures while any exist or were applied',async()=>{
  await db.query('TRUNCATE staff_saved_signatures');
  await manager.post('/api/staff/signature').set(headers).send({typedName:'Fictional Saved Manager',signature:signature(),signatureMethod:'DRAWN',agreed:true}).expect(201);
  const runner=db.createQueryRunner();
  try { await expect(new SavedStaffSignatures1792780000000().down(runner)).rejects.toThrow('Cannot discard saved staff signatures'); } finally { await runner.release(); }
  await db.query('TRUNCATE staff_saved_signatures');
 });
 // Last: an administrator account change ends the target's sessions.
 it('clears a saved signature when an administrator changes the account or resets two-step verification, but not for a name-only edit',async()=>{
  await db.query('TRUNCATE staff_saved_signatures');
  const target=await db.getRepository(User).findOneByOrFail({email:'staff1@example.test'});
  await other.post('/api/staff/signature').set(headers).send({typedName:'Fictional Other Manager',signature:signature(),signatureMethod:'DRAWN',agreed:true}).expect(201);
  await admin.patch(`/api/users/${target.id}`).set(headers).send({firstName:'Renamed'}).expect(200);
  expect((await db.query('SELECT 1 FROM staff_saved_signatures WHERE "userId"=$1',[target.id])).length).toBe(1);
  await admin.patch(`/api/users/${target.id}`).set(headers).send({password:randomBytes(18).toString('base64url')}).expect(200);
  expect((await db.query('SELECT 1 FROM staff_saved_signatures WHERE "userId"=$1',[target.id])).length).toBe(0);
  const [cleared]=await db.query(`SELECT metadata FROM staff_security_events WHERE "userId"=$1 AND type='STAFF_SIGNATURE_CLEARED'`,[target.id]);
  expect(cleared.metadata).toEqual({reason:'account-change'});
  // An administrator resetting two-step verification clears it too (the target is signed out by the password change above, so the row is set up directly).
  await db.query(`INSERT INTO staff_saved_signatures ("userId","typedName","signatureImage","signatureMethod") VALUES ($1,'Fictional Other Manager',$2,'DRAWN')`,[target.id,png(600,180)]);
  await enrolForTest(db,env.MFA_ENCRYPTION_KEY!,target.id);
  await admin.post(`/api/users/${target.id}/mfa/reset`).set(headers).send({}).expect(200);
  expect((await db.query('SELECT 1 FROM staff_saved_signatures WHERE "userId"=$1',[target.id])).length).toBe(0);
  expect((await db.query(`SELECT metadata FROM staff_security_events WHERE "userId"=$1 AND type='STAFF_SIGNATURE_CLEARED' ORDER BY "createdAt"`,[target.id])).map((row:{metadata:unknown})=>row.metadata)).toEqual([{reason:'account-change'},{reason:'mfa-reset'}]);
  // An administrator changing their own password keeps their own saved signature (they chose the password); it signs them out.
  const self=await db.getRepository(User).findOneByOrFail({email:'staff2@example.test'});
  await db.query(`INSERT INTO staff_saved_signatures ("userId","typedName","signatureImage","signatureMethod") VALUES ($1,'Fictional Admin',$2,'DRAWN')`,[self.id,png(600,180)]);
  await admin.patch(`/api/users/${self.id}`).set(headers).send({password:randomBytes(18).toString('base64url')}).expect(200);
  expect((await db.query('SELECT 1 FROM staff_saved_signatures WHERE "userId"=$1',[self.id])).length).toBe(1);
 });
});
