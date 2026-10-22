// Destructive by design: only an explicitly selected, local disposable *_test database.
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');
const { databaseOptions } = require('../apps/api/dist/database/options.js');
(async()=>{
 assert.equal(process.env.ALLOW_DISPOSABLE_DB_RESET,'true');
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.ok(url.pathname.endsWith('_test'));assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
 const db=await new DataSource(databaseOptions({DATABASE_URL:url.toString(),DATABASE_SSL:false})).initialize();

 const undoApplicationMigration=async()=>{
  let [latest]=await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');
  while(['OptionalApplicantWorkPhone1792680000000','StarterDemo1792670000000','DemoEmail1792660000000'].includes(latest?.name)){
   await db.undoLastMigration();[latest]=await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');
  }
  return db.undoLastMigration();
 };
 try {
  await db.runMigrations();
  const latest=await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');assert.equal(latest[0].name,'OptionalApplicantWorkPhone1792680000000');
  await db.query('TRUNCATE users,staff_sessions,applicant_sessions,login_attempts CASCADE');
  await undoApplicationMigration(); // Remove the empty IT schema before checking prior migrations.
  await undoApplicationMigration(); // Remove required-detail naming before checking older schemas.
  await undoApplicationMigration(); // Remove simplified invitations before testing the original review migration.
  await undoApplicationMigration();
  const [user]=await db.query(`INSERT INTO users ("firstName","lastName",email,role,status) VALUES ('Fictional','Migration','migration@example.test','DISPATCHER_MANAGER','INACTIVE') RETURNING id`);
  const [inv]=await db.query(`INSERT INTO invitations ("managerId",email,"tokenHash","mcName","teamLead","jobTitle","expiresAt") VALUES ($1,'migration.applicant@example.test',repeat('a',64),'Independent','Independent','Dispatcher',now()+interval '7 days') RETURNING id`,[user.id]);
  const [app]=await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"submittedAt") VALUES ($1,$2,'SUBMITTED',$3,2,now()) RETURNING id`,[inv.id,user.id,JSON.stringify({firstName:'Fictional',lastName:'Migration'})]);
  await db.runMigrations();
  await undoApplicationMigration();
  await undoApplicationMigration();
  await undoApplicationMigration(); // Review rollback guard is tested against its own schema.
  const submissions=await db.query('SELECT fields FROM application_submissions WHERE "applicationId"=$1',[app.id]);assert.equal(submissions.length,1);assert.equal(submissions[0].fields.firstName,'Fictional');
  const [access]=await db.query('SELECT "applicantAccessUntil" IS NOT NULL AS present FROM dispatcher_applications WHERE id=$1',[app.id]);assert.equal(access.present,true);
  await db.transaction(async em=>{
   await em.query(`UPDATE dispatcher_applications SET status='APPROVED',version=3 WHERE id=$1`,[app.id]);
   await em.query(`INSERT INTO application_reviews ("applicationId","reviewerId","decisionType","previousStatus","newStatus","applicationVersion") VALUES ($1,$2,'APPROVE','SUBMITTED','APPROVED',3)`,[app.id,user.id]);
  });
  let refused=false;try{await undoApplicationMigration();}catch{refused=true;}assert.equal(refused,true);
  assert.equal((await db.query('SELECT status FROM dispatcher_applications WHERE id=$1',[app.id]))[0].status,'APPROVED');
  await db.query('TRUNCATE users,staff_sessions,applicant_sessions,login_attempts CASCADE');
  await undoApplicationMigration();await db.runMigrations();
  console.log('PASS: compiled review migration rollback/reapply, existing-submission backfill, and refusal to discard review decisions.');
 } finally {await db.destroy();}
})().catch(()=>{console.error('Review migration verification failed; check local disposable database configuration.');process.exitCode=1;});
