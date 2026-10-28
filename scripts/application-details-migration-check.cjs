// Explicit destructive opt-in; only local disposable *_test databases are accepted.
const assert=require('node:assert/strict');
const {DataSource}=require('typeorm');
const {databaseOptions}=require('../apps/api/dist/database/options.js');
(async()=>{
 assert.equal(process.env.ALLOW_DISPOSABLE_DB_RESET,'true');const url=new URL(process.env.TEST_DATABASE_URL);
 assert.ok(url.pathname.endsWith('_test'));assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
 const db=await new DataSource(databaseOptions({DATABASE_URL:url.toString(),DATABASE_SSL:false})).initialize();

 const undoApplicationMigration=async()=>{
  let [latest]=await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');
  while(['ApplicantUpdates1792730000000','StaffMfa1792720000000','OnboardingDocuments1792710000000','CompanyEmail1792700000000','RetireDemoDeployment1792690000000','OptionalApplicantWorkPhone1792680000000','StarterDemo1792670000000','DemoEmail1792660000000'].includes(latest?.name)){
   await db.undoLastMigration();[latest]=await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');
  }
  return db.undoLastMigration();
 };
 try {
  await db.runMigrations();assert.equal((await db.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1'))[0].name,'ApplicantUpdates1792730000000');
  await db.query('TRUNCATE users,staff_sessions,applicant_sessions,login_attempts CASCADE');await undoApplicationMigration();await undoApplicationMigration();
  const [staff]=await db.query(`INSERT INTO users ("firstName","lastName",email,role,status) VALUES ('Fictional','Migration','details.staff@example.test','DISPATCHER_MANAGER','INACTIVE') RETURNING id`);
  const applications=[];
  for(const [index,status] of ['APPROVED','CHANGES_REQUESTED'].entries()){
   const [inv]=await db.query(`INSERT INTO invitations ("managerId",email,"expectedEmail","tokenHash","mcName","teamLead","jobTitle","expiresAt","consumedAt") VALUES ($1,$2,$2,$3,'Independent','Independent','Dispatcher',now()+interval '7 days',now()) RETURNING id`,[staff.id,`details${index}@example.test`,String(index+1).repeat(64)]);
   const fields={firstName:'Fictional',lastName:'Original',phone:'+996 (555) 123-456',...(index?{preferredFirstName:'Alex',preferredLastName:'Demo'}:{})};
   const [app]=await db.query(`INSERT INTO dispatcher_applications ("invitationId","assignedManagerId",status,fields,version,"submittedAt","applicantAccessUntil") VALUES ($1,$2,$3,$4,3,now(),now()+interval '7 days') RETURNING id`,[inv.id,staff.id,status,JSON.stringify(fields)]);
   await db.query('INSERT INTO application_submissions ("applicationId",version,fields) VALUES ($1,2,$2)',[app.id,JSON.stringify(fields)]);
   await db.query(`INSERT INTO application_reviews ("applicationId","reviewerId","decisionType","requestedFields",reason,"previousStatus","newStatus","applicationVersion") VALUES ($1,$2,$3,$4,'Preserve history','SUBMITTED',$5,3)`,[app.id,staff.id,index?'REQUEST_CHANGES':'APPROVE',JSON.stringify(index?['phone','preferredFirstName','preferredLastName']:[]),status]);
   applications.push(app.id);
  }
  await db.runMigrations();
  const rows=await db.query('SELECT status,fields,version FROM dispatcher_applications ORDER BY status');
  for(const row of rows){assert.equal(row.fields.personalPhoneNumber,'+996 (555) 123-456');assert.equal(row.fields.phone,'+996 (555) 123-456');assert.equal(Object.hasOwn(row.fields,'workPhoneNumber'),false);assert.equal(row.fields.firstName,'Fictional');assert.equal(row.version,3);}
  assert.equal(rows[0].status,'APPROVED');assert.equal(Object.hasOwn(rows[0].fields,'preferredAmericanFirstName'),false);
  assert.equal(rows[1].fields.preferredAmericanFirstName,'Alex');assert.equal(rows[1].fields.preferredAmericanLastName,'Demo');
  const revisions=await db.query('SELECT fields FROM application_submissions');for(const revision of revisions)assert.equal(revision.fields.personalPhoneNumber,'+996 (555) 123-456');
  const [review]=await db.query(`SELECT "requestedFields" FROM application_reviews WHERE "decisionType"='REQUEST_CHANGES'`);assert.deepEqual(review.requestedFields,['personalPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName']);
  await db.query(`UPDATE dispatcher_applications SET fields=jsonb_set(fields,'{workPhoneNumber}','"+44 20 7946 0958"') WHERE id=$1`,[applications[1]]);
  await undoApplicationMigration();
  await undoApplicationMigration();
  const [rolled]=await db.query('SELECT fields,status FROM dispatcher_applications WHERE id=$1',[applications[1]]);assert.equal(rolled.fields.workPhoneNumber,'+44 20 7946 0958');assert.equal(rolled.fields.phone,'+996 (555) 123-456');
  assert.deepEqual((await db.query(`SELECT "requestedFields" FROM application_reviews WHERE "decisionType"='REQUEST_CHANGES'`))[0].requestedFields,['phone','preferredFirstName','preferredLastName']);
  await db.runMigrations();
  const [again]=await db.query('SELECT fields,status FROM dispatcher_applications WHERE id=$1',[applications[1]]);assert.equal(again.fields.workPhoneNumber,'+44 20 7946 0958');assert.equal(again.status,'CHANGES_REQUESTED');
  console.log('PASS: required-details migration preserves personal phones, names, revisions, corrections and historical approvals; leaves missing values absent; rollback/reapply retains work phone data.');
 }finally{await db.destroy();}
})().catch(()=>{console.error('Application-details migration check failed; check the local disposable database configuration.');process.exitCode=1;});
