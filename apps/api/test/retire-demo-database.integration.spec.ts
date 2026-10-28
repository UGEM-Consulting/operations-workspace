import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../src/config/environment';
import { databaseOptions } from '../src/database/options';
import { retireDemoDatabase } from '../src/database/retire-demo-database';
const integration=process.env.TEST_DATABASE_URL?describe:describe.skip;
integration('Retiring a converted demo database (disposable PostgreSQL)',()=>{
 let db:DataSource;
 const env=validateEnvironment({NODE_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_URL??'postgresql://localhost/operations_m2_test',CORS_ORIGINS:'http://localhost:3000',WEB_ORIGIN:'http://localhost:3000',SESSION_SECRET:randomBytes(32).toString('hex'),BFF_SHARED_SECRET:randomBytes(32).toString('hex')});
 const latest=async()=>(await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name as string;
 const count=async(table:string)=>Number((await db.query(`SELECT count(*)::integer AS n FROM ${table}`))[0].n);
 // Recreates the state of a starter database converted to the demo: real operator email, fictional staff and data.
 async function convertedStarter(extraUsers:string[]=[]){
  if(await latest()==='OptionalEquipmentTask1792740000000'){await db.query(`DELETE FROM it_onboarding_tasks WHERE key='EQUIPMENT'`);await db.undoLastMigration();}
  if(await latest()==='ApplicantUpdates1792730000000'){await db.query('TRUNCATE applicant_update_deliveries,applicant_update_settings,telegram_link_tokens');await db.undoLastMigration();}
  if(await latest()==='StaffMfa1792720000000'){await db.query('TRUNCATE staff_mfa,staff_mfa_recovery_codes,staff_security_events');await db.undoLastMigration();}
  if(await latest()==='OnboardingDocuments1792710000000'){await db.query('TRUNCATE company_documents,applicant_photos CASCADE');await db.undoLastMigration();}
  if(await latest()==='CompanyEmail1792700000000'){await db.query('TRUNCATE it_onboarding_requests CASCADE');await db.undoLastMigration();}
  if(await latest()==='RetireDemoDeployment1792690000000')await db.undoLastMigration();
  await db.query('TRUNCATE users,staff_sessions,applicant_sessions,login_attempts,demo_mailbox,deployment_activity CASCADE');
  await db.query(`UPDATE deployment_identity SET purpose='production',mode='isolated',"operatorAdminId"=NULL`);
  const [operator]=await db.query(`INSERT INTO users ("firstName","lastName",email,role,status) VALUES ('Real','Owner','owner@company.example','SYSTEM_ADMIN','ACTIVE') RETURNING id,"authVersion"`);
  const [manager]=await db.query(`INSERT INTO users ("firstName","lastName",email,role,status) VALUES ('Fictional','Manager','manager.demo@example.test','DISPATCHER_MANAGER','ACTIVE') RETURNING id`);
  for(const email of extraUsers)await db.query(`INSERT INTO users ("firstName","lastName",email,role,status) VALUES ('Extra','Person',$1,'IT_SPECIALIST','ACTIVE')`,[email]);
  const [inv]=await db.query(`INSERT INTO invitations ("managerId",email,"expectedEmail","tokenHash","mcName","teamLead","jobTitle","expiresAt") VALUES ($1,'applicant.demo@example.test',NULL,repeat('e',64),'Independent','Independent','Dispatcher',now()+interval '7 days') RETURNING id`,[manager.id]);
  await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"applicantAccessUntil") VALUES ($1,$2,'DRAFT','{}',1,now()+interval '7 days')`,[inv.id,manager.id]);
  await db.query(`INSERT INTO application_activity ("invitationId",event) VALUES ($1,'INVITATION_CREATED')`,[inv.id]);
  await db.query(`UPDATE deployment_identity SET purpose='demo',mode='starter',"operatorAdminId"=$1`,[operator.id]);
  return operator as {id:string;authVersion:number};
 }
 beforeAll(async()=>{
  if(!new URL(env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
  db=await new DataSource(databaseOptions(env)).initialize();await db.runMigrations();
 },30000);
 afterAll(async()=>{
  // Leave the shared test database fully migrated and empty for other suites.
  if(await db.query(`SELECT 1 FROM pg_tables WHERE tablename='deployment_identity'`).then(rows=>rows.length))await db.query(`TRUNCATE users,staff_sessions,applicant_sessions,login_attempts CASCADE; UPDATE deployment_identity SET purpose='production',mode='isolated',"operatorAdminId"=NULL`);
  await db.runMigrations();await db.query('TRUNCATE users,staff_sessions,applicant_sessions,login_attempts CASCADE');await db.destroy();
 });
 it('blocks deployment migrations until the demo marking is removed',async()=>{
  await convertedStarter();
  await expect(db.runMigrations()).rejects.toThrow();
  expect(await latest()).toBe('OptionalApplicantWorkPhone1792680000000');
 });
 it('reports without changing anything in a dry run',async()=>{
  await convertedStarter();
  expect(await retireDemoDatabase(db,false)).toEqual({keptAdministrator:true,deletedStaff:1,invitations:1,applications:1,itRequests:0,notifications:0});
  expect(await count('users')).toBe(2);expect(await count('invitations')).toBe(1);
  expect((await db.query('SELECT purpose FROM deployment_identity'))[0].purpose).toBe('demo');
 });
 it('deletes the fictional data, keeps the operator, unmarks the database and lets the migration finish',async()=>{
  const operator=await convertedStarter();
  await retireDemoDatabase(db,true);
  const users=await db.query('SELECT id,email,role,status,"authVersion" FROM users');
  expect(users).toEqual([{id:operator.id,email:'owner@company.example',role:'SYSTEM_ADMIN',status:'ACTIVE',authVersion:operator.authVersion+1}]);
  for(const table of ['invitations','dispatcher_applications','application_activity','staff_sessions'])expect(await count(table)).toBe(0);
  expect((await db.query('SELECT purpose,mode,"operatorAdminId" FROM deployment_identity'))[0]).toEqual({purpose:'production',mode:'isolated',operatorAdminId:null});
  // Real addresses are accepted again once unmarked, and the deploy migration drops the demo schema.
  await db.query(`INSERT INTO users ("firstName","lastName",email,role,status) VALUES ('Real','Manager','manager@company.example','DISPATCHER_MANAGER','ACTIVE')`);
  await db.runMigrations();
  expect(await latest()).toBe('OptionalEquipmentTask1792740000000');
  await expect(retireDemoDatabase(db,false)).rejects.toThrow('no demo marking');
 });
 it('refuses to delete a non-fictional staff account and changes nothing',async()=>{
  const operator=await convertedStarter();
  // Inserted while unmarked would be impossible under the demo triggers; simulate a manual insert anyway.
  await db.query(`UPDATE deployment_identity SET purpose='production',mode='isolated',"operatorAdminId"=NULL`);
  await db.query(`INSERT INTO users ("firstName","lastName",email,role,status) VALUES ('Real','Colleague','colleague@company.example','IT_SPECIALIST','ACTIVE')`);
  await db.query(`UPDATE deployment_identity SET purpose='demo',mode='starter',"operatorAdminId"=$1`,[operator.id]);
  await expect(retireDemoDatabase(db,true)).rejects.toThrow('non-fictional');
  expect(await count('users')).toBe(3);expect(await count('invitations')).toBe(1);
  expect((await db.query('SELECT purpose FROM deployment_identity'))[0].purpose).toBe('demo');
 });
 it('refuses a database that is not marked as the demo',async()=>{
  await convertedStarter();
  await db.query(`UPDATE deployment_identity SET purpose='production',mode='isolated',"operatorAdminId"=NULL`);
  await expect(retireDemoDatabase(db,true)).rejects.toThrow('not marked as the demo');
  expect(await count('invitations')).toBe(1);
 });
});
