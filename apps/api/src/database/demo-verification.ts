import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../config/environment';
import { databaseOptions } from './options';
import { ApplicantChallenge, DispatcherApplication, Invitation } from '../modules/onboarding/entities';
import { digest, generateVerificationCode } from '../modules/onboarding/verification-code';
export class DemoVerificationError extends Error {}
export async function issueDemoCode(db: DataSource, challengeId: string, mode: string | undefined): Promise<string> {
 if (mode !== 'development' && mode !== 'test') throw new DemoVerificationError('Local verification is disabled outside development/test.');
 if (!/^[0-9a-f-]{36}$/.test(challengeId)) throw new DemoVerificationError('Supply the full verification reference displayed on the applicant page.');
 return db.transaction(async em => {
  const challenge = await em.getRepository(ApplicantChallenge).findOne({ where: { id: challengeId }, lock: { mode: 'pessimistic_write' } });
  if (!challenge) throw new DemoVerificationError('Reference not found. Click Start again on the applicant page and use the new reference. Ensure the API and this command use the same local database.');
  if (challenge.expiresAt.getTime() <= Date.now()) throw new DemoVerificationError('This reference expired. Click Start again on the applicant page and use the new reference within 10 minutes.');
  if (challenge.consumedAt) throw new DemoVerificationError('This reference has already been used. Continue with your verified session or verify again from /apply/resume.');
  if (!challenge.invitationId) throw new DemoVerificationError('This reference does not match an available invitation. Click Start again, use a fictional @example.test email matching any expected email, and ensure the invitation is unclaimed, unexpired and not revoked. Returning applicants must use /apply/resume.');
  const inv = await em.getRepository(Invitation).findOneByOrFail({ id: challenge.invitationId });
  const app = await em.getRepository(DispatcherApplication).findOneByOrFail({invitationId:inv.id});
  if (!challenge.email?.endsWith('@example.test') || (inv.expectedEmail !== null && inv.expectedEmail !== challenge.email) || (challenge.resume ? inv.email !== challenge.email : !!inv.consumedAt) || inv.revokedAt || (challenge.resume ? app.applicantAccessUntil : inv.expiresAt).getTime() <= Date.now()) throw new DemoVerificationError('This invitation is no longer available for this verification. Use /apply/resume if already verified, or contact your demo manager for a new invitation.');
  const code = generateVerificationCode();
  challenge.codeHash = digest(code); await em.save(challenge);
  return code;
 });
}
if (require.main === module) {
 void (async () => {
  const env = validateEnvironment(process.env);
  if (env.NODE_ENV === 'production' || env.DEPLOYMENT_PURPOSE !== 'local' || !['localhost','127.0.0.1','[::1]'].includes(new URL(env.DATABASE_URL).hostname)) throw new DemoVerificationError('Local verification requires a local development/test database and local deployment purpose.');
  const db = await new DataSource(databaseOptions(env)).initialize();
  try {
   const code = await issueDemoCode(db,process.argv[2] ?? '',env.NODE_ENV);
   // Explicit private terminal delivery, never an HTTP response or application log.
   process.stdout.write(`Local fictional verification code: ${code}\n`);
  } finally { await db.destroy(); }
 })().catch((error: unknown) => {
  // Only predefined local-operator messages are safe to print; never expose raw database/config errors.
  process.stderr.write(`${error instanceof DemoVerificationError ? error.message : 'Unable to issue a local verification code. Check apps/api/.env, PostgreSQL availability, and database migrations.'}\n`);
  process.exitCode = 1;
 });
}
