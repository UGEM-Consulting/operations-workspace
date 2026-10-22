import { EntityManager } from 'typeorm';
import type { Environment } from '../../config/environment';

export async function assertDemoIdentity(em: EntityManager, env: Environment): Promise<void> {
  const [identity] = await em.query('SELECT purpose, mode, "operatorAdminId", "deploymentId", "webOrigin", current_database() AS database FROM deployment_identity WHERE id=true');
  if (!identity || identity.purpose !== 'demo' || (identity.mode === 'starter') !== env.DEMO_STARTER_MODE || identity.deploymentId !== env.DEMO_DEPLOYMENT_ID
    || identity.webOrigin !== env.WEB_ORIGIN || identity.database !== decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1))) {
    throw new Error('Demo deployment/database identity does not match');
  }
  const [data] = await em.query(`SELECT EXISTS (
    SELECT 1 FROM users WHERE email !~ '^[^@]+@example\\.test$'
      AND (id IS DISTINCT FROM $1::uuid OR role<>'SYSTEM_ADMIN' OR status<>'ACTIVE')
    UNION ALL SELECT 1 FROM invitations WHERE email !~ '^[^@]+@example\\.test$' OR "expectedEmail" !~ '^[^@]+@example\\.test$'
    UNION ALL SELECT 1 FROM applicant_challenges WHERE email !~ '^[^@]+@example\\.test$'
  ) AS unsafe`, [identity.mode === 'starter' ? identity.operatorAdminId : null]);
  if (identity.mode === 'starter') {
    const [operator] = await em.query("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND role='SYSTEM_ADMIN' AND status='ACTIVE') AS available", [identity.operatorAdminId]);
    if (!operator.available) throw new Error('Preserved starter administrator is unavailable');
  }
  if (data.unsafe) throw new Error('Demo deployment contains non-fictional identities');
  const [staff] = await em.query("SELECT EXISTS(SELECT 1 FROM users WHERE role='SYSTEM_ADMIN' AND status='ACTIVE') AS available");
  if (!staff.available) throw new Error('An active fictional demo administrator is required');
}

export async function initializeDemoIdentity(em: EntityManager, env: Environment): Promise<void> {
  if (!env.DEMO_EMAIL_MODE || env.DEPLOYMENT_PURPOSE !== 'demo' || !env.DEMO_FICTIONAL_DATA_ONLY || env.DEMO_STARTER_MODE) throw new Error('Use explicit isolated demo configuration; starter mode requires demo:convert-starter');
  await em.query('SELECT pg_advisory_xact_lock(42002026)');
  await em.query('LOCK TABLE users, invitations, dispatcher_applications IN SHARE ROW EXCLUSIVE MODE');
  const [identity] = await em.query('SELECT * FROM deployment_identity WHERE id=true FOR UPDATE');
  if (identity?.purpose === 'demo') return assertDemoIdentity(em, env);
  if (identity?.purpose !== 'unassigned') throw new Error('An existing production database can never be designated for demo use');
  const [data] = await em.query(`SELECT EXISTS(SELECT 1 FROM invitations) OR EXISTS(SELECT 1 FROM dispatcher_applications)
    OR EXISTS(SELECT 1 FROM it_onboarding_requests) OR EXISTS(SELECT 1 FROM users WHERE email !~ '^[^@]+@example\\.test$') AS unsafe`);
  if (data.unsafe) throw new Error('Demo designation requires an unused database with fictional staff only');
  await em.query(`UPDATE deployment_identity SET purpose='demo', "deploymentId"=$1, "webOrigin"=$2, "initializedAt"=now() WHERE id=true`, [env.DEMO_DEPLOYMENT_ID, env.WEB_ORIGIN]);
  await assertDemoIdentity(em, env);
}

// Explicit operator CLI only. Never called by migrations, HTTP routes or startup.
export async function convertStarterIdentity(em: EntityManager, env: Environment): Promise<void> {
  if (!env.DEMO_STARTER_MODE || !env.DEMO_EMAIL_MODE || env.DEPLOYMENT_PURPOSE !== 'demo' || !env.DEMO_FICTIONAL_DATA_ONLY) throw new Error('Explicit starter demo configuration required');
  await em.query('SELECT pg_advisory_xact_lock(42002026)');
  await em.query(`LOCK TABLE users, invitations, dispatcher_applications, applicant_challenges, applicant_sessions,
    application_activity, application_submissions, application_reviews, it_onboarding_requests,
    it_onboarding_tasks, it_onboarding_activity, portal_notifications, demo_mailbox, staff_sessions IN SHARE ROW EXCLUSIVE MODE`);
  const [identity] = await em.query('SELECT * FROM deployment_identity WHERE id=true FOR UPDATE');
  if (identity?.purpose === 'demo') {
    if (identity.mode !== 'starter') throw new Error('Cannot relabel an isolated demo');
    return assertDemoIdentity(em, env);
  }
  if (!identity || !['production','unassigned'].includes(identity.purpose)) throw new Error('Database identity is unavailable');
  const users = await em.query('SELECT id, role, status FROM users');
  if (users.length !== 1 || users[0].role !== 'SYSTEM_ADMIN' || users[0].status !== 'ACTIVE') throw new Error('Starter conversion requires exactly one active SYSTEM_ADMIN and no other users');
  const [data] = await em.query(`SELECT EXISTS(
    SELECT 1 FROM invitations i WHERE email IS NOT NULL OR "consumedAt" IS NOT NULL OR "completedAt" IS NOT NULL
      OR ("expectedEmail" IS NOT NULL AND "expectedEmail" !~ '^[^@]+@example\\.test$')
      OR COALESCE("mcName",'')<>'' OR COALESCE("teamLead",'')<>'' OR COALESCE("jobTitle",'') NOT IN ('','Dispatcher')
      OR NOT EXISTS(SELECT 1 FROM dispatcher_applications a WHERE a."invitationId"=i.id)
    UNION ALL SELECT 1 FROM dispatcher_applications WHERE status<>'INVITED' OR version<>0 OR "submittedAt" IS NOT NULL
      OR fields - ARRAY['mcName','teamLead','jobTitle'] <> '{}'::jsonb
      OR COALESCE(fields->>'mcName','')<>'' OR COALESCE(fields->>'teamLead','')<>'' OR COALESCE(fields->>'jobTitle','') NOT IN ('','Dispatcher')
    UNION ALL SELECT 1 FROM applicant_challenges
    UNION ALL SELECT 1 FROM applicant_sessions UNION ALL SELECT 1 FROM application_activity WHERE event NOT IN ('INVITATION_CREATED','INVITATION_REVOKED')
    UNION ALL SELECT 1 FROM application_submissions UNION ALL SELECT 1 FROM application_reviews
    UNION ALL SELECT 1 FROM it_onboarding_requests UNION ALL SELECT 1 FROM it_onboarding_tasks
    UNION ALL SELECT 1 FROM it_onboarding_activity UNION ALL SELECT 1 FROM portal_notifications
    UNION ALL SELECT 1 FROM demo_mailbox UNION ALL SELECT 1 FROM deployment_activity
  ) AS populated`);
  if (data.populated) throw new Error('Starter conversion refused: onboarding or conversion data exists. Nothing was deleted.');
  await em.query('UPDATE users SET "authVersion"="authVersion"+1 WHERE id=$1', [users[0].id]);
  await em.query('DELETE FROM staff_sessions');
  await em.query(`UPDATE deployment_identity SET purpose='demo', mode='starter', "operatorAdminId"=$1,
    "deploymentId"=$2, "webOrigin"=$3, "initializedAt"=now() WHERE id=true`, [users[0].id, env.DEMO_DEPLOYMENT_ID, env.WEB_ORIGIN]);
  await em.query(`INSERT INTO deployment_activity (event,"deploymentId","operatorAdminId") VALUES ('STARTER_DEMO_CONVERTED',$1,$2)`, [env.DEMO_DEPLOYMENT_ID, users[0].id]);
  await assertDemoIdentity(em, env);
}
