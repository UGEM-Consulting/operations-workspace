// Destructive local migration verification; refuses application/production databases.
const assert=require('node:assert/strict');const {DataSource}=require('typeorm');
const {databaseOptions}=require('../apps/api/dist/database/options.js');
(async()=>{
 assert.equal(process.env.ALLOW_DISPOSABLE_DB_RESET,'true');const url=new URL(process.env.TEST_DATABASE_URL);
 assert.ok(url.pathname.endsWith('_test'));assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
 const db=await new DataSource(databaseOptions({DATABASE_URL:url.toString(),DATABASE_SSL:false})).initialize();

 const undoApplicationMigration=async()=>{
  let [latest]=await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');
  while(['OnboardingDocuments1792710000000','CompanyEmail1792700000000','RetireDemoDeployment1792690000000','OptionalApplicantWorkPhone1792680000000','StarterDemo1792670000000','DemoEmail1792660000000'].includes(latest?.name)){
   await db.undoLastMigration();[latest]=await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');
  }
  return db.undoLastMigration();
 };
 try{
  await db.runMigrations();assert.equal((await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name,'OnboardingDocuments1792710000000');
  await db.query('TRUNCATE users,staff_sessions,applicant_sessions,login_attempts CASCADE');await undoApplicationMigration();
  assert.equal((await db.query("SELECT to_regclass('public.it_onboarding_requests') AS name"))[0].name,null);
  const [user]=await db.query(`INSERT INTO users ("firstName","lastName",email,role,status) VALUES ('Fictional','Migration','it.migration@example.test','SYSTEM_ADMIN','INACTIVE') RETURNING id`);
  const [inv]=await db.query(`INSERT INTO invitations ("managerId",email,"expectedEmail","tokenHash","mcName","teamLead","jobTitle","expiresAt") VALUES ($1,'it.applicant@example.test','it.applicant@example.test',repeat('d',64),'Independent','Independent','Dispatcher',now()+interval '7 days') RETURNING id`,[user.id]);
  const fields={firstName:'Fictional',lastName:'Legal',preferredAmericanFirstName:'Alex',preferredAmericanLastName:'Demo',personalPhoneNumber:'+1 202 555 0123',workPhoneNumber:'+44 20 7946 0958'};
  const [app]=await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"submittedAt","applicantAccessUntil") VALUES ($1,$2,'APPROVED',$3,3,now(),now()+interval '7 days') RETURNING id`,[inv.id,user.id,JSON.stringify(fields)]);
  const [review]=await db.query(`INSERT INTO application_reviews ("applicationId","reviewerId","decisionType","previousStatus","newStatus","applicationVersion") VALUES ($1,$2,'APPROVE','SUBMITTED','APPROVED',3) RETURNING id`,[app.id,user.id]);
  await db.runMigrations();assert.equal((await db.query('SELECT status FROM dispatcher_applications WHERE id=$1',[app.id]))[0].status,'APPROVED');
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM it_onboarding_requests'))[0].count,0);
  const [request]=await db.query('INSERT INTO it_onboarding_requests ("applicationId","approvalId","managerId",profile) VALUES ($1,$2,$3,$4) RETURNING id',[app.id,review.id,user.id,JSON.stringify(fields)]);
  await db.query(`INSERT INTO it_onboarding_tasks ("requestId",key,status) VALUES ($1,'GOOGLE_WORKSPACE','PENDING')`,[request.id]);
  let duplicateRejected=false;try{await db.query('INSERT INTO it_onboarding_requests ("applicationId","approvalId","managerId",profile) VALUES ($1,$2,$3,$4)',[app.id,review.id,user.id,JSON.stringify(fields)]);}catch{duplicateRejected=true;}assert.equal(duplicateRejected,true);
  let refused=false;try{await undoApplicationMigration();}catch{refused=true;}assert.equal(refused,true);
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM it_onboarding_requests'))[0].count,1);
  await db.query('TRUNCATE users,staff_sessions,applicant_sessions,login_attempts CASCADE');await undoApplicationMigration();await db.runMigrations();
  console.log('PASS: IT migration up/down/reapply, existing approval preservation, unique request integrity and refusal to discard IT workflow data.');
 }finally{await db.destroy();}
})().catch(()=>{console.error('IT migration check failed; check the disposable local database configuration.');process.exitCode=1;});
