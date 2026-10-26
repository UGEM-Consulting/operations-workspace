// Explicitly destructive verification on a LOCAL disposable *_test database only.
const assert=require('node:assert/strict');
const {DataSource}=require('typeorm');
const {databaseOptions}=require('../apps/api/dist/database/options.js');
(async()=>{
 assert.equal(process.env.ALLOW_DISPOSABLE_DB_RESET,'true');
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.ok(url.pathname.endsWith('_test'));assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
 const db=await new DataSource(databaseOptions({DATABASE_URL:url.toString(),DATABASE_SSL:false})).initialize();

 const undoApplicationMigration=async()=>{
  let [latest]=await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');
  while(['OnboardingDocuments1792710000000','CompanyEmail1792700000000','RetireDemoDeployment1792690000000','OptionalApplicantWorkPhone1792680000000','StarterDemo1792670000000','DemoEmail1792660000000'].includes(latest?.name)){
   await db.undoLastMigration();[latest]=await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');
  }
  return db.undoLastMigration();
 };
 try {
  await db.runMigrations();
  assert.equal((await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name,'OnboardingDocuments1792710000000');
  await db.query('TRUNCATE users,staff_sessions,applicant_sessions,login_attempts CASCADE');await undoApplicationMigration();await undoApplicationMigration();await undoApplicationMigration();
  const [user]=await db.query(`INSERT INTO users ("firstName","lastName",email,role,status) VALUES ('Fictional','Legacy','legacy.staff@example.test','DISPATCHER_MANAGER','INACTIVE') RETURNING id`);
  const [inv]=await db.query(`INSERT INTO invitations ("managerId",email,"tokenHash","mcName","teamLead","jobTitle","expiresAt","consumedAt") VALUES ($1,'legacy.applicant@example.test',repeat('b',64),'Legacy fictional MC','Independent','Dispatcher',now()+interval '7 days',now()) RETURNING id`,[user.id]);
  const [app]=await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"submittedAt","applicantAccessUntil") VALUES ($1,$2,'APPROVED',$3,3,now(),now()+interval '7 days') RETURNING id`,[inv.id,user.id,JSON.stringify({firstName:'Fictional',lastName:'Legacy'})]);
  await db.query('INSERT INTO application_submissions ("applicationId",version,fields) VALUES ($1,2,$2)',[app.id,JSON.stringify({firstName:'Fictional',lastName:'Legacy'})]);
  const [review]=await db.query(`INSERT INTO application_reviews ("applicationId","reviewerId","decisionType",reason,"previousStatus","newStatus","applicationVersion") VALUES ($1,$2,'APPROVE','Preserve legacy review','SUBMITTED','APPROVED',3) RETURNING id`,[app.id,user.id]);
  await db.query('INSERT INTO applicant_challenges ("invitationId",resume,"expiresAt") VALUES ($1,true,now()+interval \'10 minutes\')',[inv.id]);
  await db.runMigrations();
  const [migrated]=await db.query('SELECT * FROM invitations WHERE id=$1',[inv.id]);assert.equal(migrated.expectedEmail,'legacy.applicant@example.test');assert.equal(migrated.mcName,'Legacy fictional MC');
  const [application]=await db.query('SELECT * FROM dispatcher_applications WHERE id=$1',[app.id]);assert.equal(application.status,'APPROVED');assert.equal(application.version,3);assert.equal(application.fields.firstName,'Fictional');assert.equal(application.fields.mcName,migrated.mcName);
  assert.equal((await db.query('SELECT fields FROM application_submissions WHERE "applicationId"=$1',[app.id]))[0].fields.mcName,migrated.mcName);
  assert.equal((await db.query('SELECT reason FROM application_reviews WHERE id=$1',[review.id]))[0].reason,'Preserve legacy review');
  assert.equal((await db.query('SELECT email FROM applicant_challenges WHERE "invitationId"=$1',[inv.id]))[0].email,migrated.email);
  await undoApplicationMigration();await undoApplicationMigration();await undoApplicationMigration();await db.runMigrations();
  await db.query(`INSERT INTO invitations ("managerId","tokenHash","telegramRequired","expiresAt") VALUES ($1,repeat('c',64),false,now()+interval '7 days')`,[user.id]);
  await undoApplicationMigration();
  await undoApplicationMigration(); // Check the optional-invitation migration guard itself.
  let refused=false;try{await undoApplicationMigration();}catch{refused=true;}assert.equal(refused,true);
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM invitations'))[0].count,2);
  await db.runMigrations();
  console.log('PASS: optional-invitation migration preserves legacy identities, fields, submissions, approvals and challenges; rollback/reapply works and lossy rollback is refused.');
 }finally{await db.destroy();}
})().catch(()=>{console.error('Invitation migration check failed; check the disposable local database configuration.');process.exitCode=1;});
