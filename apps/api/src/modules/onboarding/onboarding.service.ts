import { digest, generateVerificationCode } from './verification-code';
export { digest } from './verification-code';
import { EmailService } from '../email/email.service';
import { requiredApplicantFields } from './application-requirements';
import { onboardingLimit } from './rate-limit';
import { requireTransition } from './transitions';
import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
// Standalone ts-node commands must load our express-session type augmentation too.
import type {} from '../auth/session';
import { DataSource, EntityManager } from 'typeorm';
import { User, Role } from '../users/user.entity';
import { canAccessAssignedApplication } from '../auth/policy';
import { ApplicationReview, ApplicationSubmission, CORRECTION_FIELDS, ApplicationFields, ApplicantChallenge, ApplicationActivity, DispatcherApplication, Invitation } from './entities';
import { BeginVerificationDto, CreateInvitationDto, DraftDto, SubmitDto, VerifyApplicantDto } from './dto';
export function invitationStatus(invitation: Invitation): string {
 if (invitation.completedAt) return 'COMPLETED';
 if (invitation.revokedAt) return 'REVOKED';
 if (invitation.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
 return invitation.openedAt ? 'OPENED' : 'PENDING';
}
@Injectable()
export class OnboardingService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService, private readonly email: EmailService) {}
 private limit(key: string, max = 10, seconds = 900) { return onboardingLimit(this.db,key,max,seconds); }
 private get production() { return this.config.get('NODE_ENV') === 'production' || this.config.get('DEPLOYMENT_PURPOSE') === 'production'; }
 // Development and tests use fictional example.test identities only; production accepts real addresses.
 private get fictionalOnly() { return !this.production; }
 // Production verification fails closed until real email delivery is configured.
 private assertDelivery() { if (this.production && !this.email.enabled) throw new ServiceUnavailableException('Email verification delivery is not configured.'); }
 private async activity(em: EntityManager, invitationId: string, event: string, actorId: string | null = null) {
  await em.getRepository(ApplicationActivity).save({ invitationId, event, actorId });
 }
 async create(user: User, input: CreateInvitationDto) {
  if (input.email && this.fictionalOnly && !input.email.endsWith('@example.test')) throw new BadRequestException('Outside production, invitations accept only fictional example.test addresses.');
  await this.limit('create:'+user.id,30);
  const token = randomBytes(32).toString('hex');
  const invitation = await this.db.transaction(async em => {
   const inv = await em.getRepository(Invitation).save({ email: null, expectedEmail: input.email ?? null, mcName: input.mcName ?? null, teamLead: input.teamLead ?? null, jobTitle: input.jobTitle ?? null,
    telegramRequired: input.telegramRequired, managerId: user.id, tokenHash: digest(token), expiresAt: new Date(Date.now()+input.expirationDays*86400000) });
   await em.getRepository(DispatcherApplication).save({ invitationId: inv.id, assignedManagerId: user.id, status: 'INVITED', fields: {mcName:input.mcName ?? '',teamLead:input.teamLead ?? '',jobTitle:input.jobTitle ?? 'Dispatcher'}, applicantAccessUntil: inv.expiresAt });
   await this.activity(em,inv.id,'INVITATION_CREATED',user.id);
   return inv;
  });
  // Raw token is returned once only; list/detail never include it or its hash. It travels in the URL fragment,
  // which browsers never send to servers, so it cannot reach hosting, CDN or APM request logs.
  return { id: invitation.id, url: `${this.config.getOrThrow<string>('WEB_ORIGIN')}/apply#${token}` };
 }
 async invitations(user: User) {
  const rows = await this.db.getRepository(Invitation).find({ where: user.role === Role.SYSTEM_ADMIN ? {} : { managerId: user.id }, order: { createdAt: 'DESC' }, take: 200 });
  return rows.map(row => ({ ...row, status: invitationStatus(row) }));
 }
 async revoke(user: User, id: string) {
  await this.db.transaction(async em => {
   const inv = await em.getRepository(Invitation).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!inv || !canAccessAssignedApplication(user,{ assignedManagerId: inv.managerId })) throw new NotFoundException();
   if (inv.completedAt) throw new ConflictException('Submitted invitations cannot be revoked.');
   if (!inv.revokedAt) {
    inv.revokedAt = new Date(); await em.save(inv); await this.activity(em,id,'INVITATION_REVOKED',user.id);
   }
  });
  return { message: 'Invitation revoked' };
 }
 async begin(input: BeginVerificationDto) {
  this.assertDelivery();
  if (this.fictionalOnly && !input.email.endsWith('@example.test')) throw new BadRequestException('Outside production, use a fictional email ending in @example.test, such as applicant@example.test.');
  await this.limit('global-verification',60,60);
  await this.limit('email:'+input.email,5);
  if (Boolean(input.token) === Boolean(input.applicationId)) throw new BadRequestException('Provide an invitation or a returning application reference.');
  // The same queries run whether or not anything matches.
  const app = input.token ? null : await this.db.getRepository(DispatcherApplication).findOneBy({ id: input.applicationId });
  const inv = input.token
   ? await this.db.getRepository(Invitation).findOneBy({ tokenHash: digest(input.token) })
   : await this.db.getRepository(Invitation).findOneBy({ id: app?.invitationId ?? '00000000-0000-0000-0000-000000000000', email: input.email });
  const valid = !!inv && !inv.revokedAt && (!inv.expectedEmail || inv.expectedEmail === input.email) && (input.token
   ? !inv.consumedAt && inv.expiresAt.getTime() > Date.now()
   : !!inv.consumedAt && !!app && app.applicantAccessUntil.getTime() > Date.now());
  await this.db.query('DELETE FROM applicant_challenges WHERE "expiresAt" < now()');
  // Only matched challenges get a code. Unmatched challenges stay unusable and receive no email.
  const code = valid && this.email.enabled ? generateVerificationCode() : null;
  // Matched and unmatched requests perform the same single write before responding.
  const challenge = await this.db.getRepository(ApplicantChallenge).save({ invitationId: valid ? inv.id : null, resume: !input.token, email: valid ? input.email : null, expiresAt: new Date(Date.now()+600000), codeHash: code ? digest(code) : null });
  if (valid) {
   const invitationId = inv.id, to = input.email;
   // After the response: mark the invitation opened, send, and record the delivery outcome (metadata only).
   this.email.runInBackground(async () => {
    await this.db.getRepository(Invitation).createQueryBuilder().update().set({ openedAt: new Date() }).where('id = :id AND "openedAt" IS NULL', { id: invitationId }).execute();
    if (code) await this.activity(this.db.manager, invitationId, await this.email.sendVerificationCode(to, code) ? 'VERIFICATION_EMAIL_SENT' : 'VERIFICATION_EMAIL_FAILED');
   });
  }
  // Identical response for unknown, mismatched, expired and matched requests.
  return this.email.enabled
   ? { challengeId: challenge.id, delivery: 'email', message: 'If the details match an available invitation, we are emailing an 8-digit verification code to that address. It expires in 10 minutes.' }
   : { challengeId: challenge.id, delivery: 'manual', message: 'Local development: if the details match an available invitation, issue a code for this reference with npm run verification:demo.' };
 }
 async verify(input: VerifyApplicantDto, req: Request) {
  this.assertDelivery();
  await this.limit('verify-global',60,60);
  await this.limit('code:'+input.challengeId,5);
  const applicationId = await this.db.transaction(async em => {
   const challenge = await em.getRepository(ApplicantChallenge).createQueryBuilder('c').addSelect('c.codeHash').setLock('pessimistic_write').where('c.id = :id',{ id: input.challengeId }).getOne();
   if (!challenge?.invitationId || !challenge.email || challenge.consumedAt || challenge.expiresAt.getTime() <= Date.now() || challenge.codeHash !== digest(input.code)) throw new UnauthorizedException('Verification is invalid or expired.');
   const inv = await em.getRepository(Invitation).findOne({ where: { id: challenge.invitationId }, lock: { mode: 'pessimistic_write' } });
   const accessApp = inv ? await em.getRepository(DispatcherApplication).findOneBy({invitationId:inv.id}) : null;
   if (!inv || !accessApp || inv.revokedAt || (inv.expectedEmail && inv.expectedEmail !== challenge.email) || (challenge.resume && inv.email !== challenge.email) || (challenge.resume ? (!inv.consumedAt || accessApp.applicantAccessUntil.getTime() <= Date.now()) : (inv.consumedAt || inv.expiresAt.getTime() <= Date.now()))) throw new UnauthorizedException('Verification is invalid or expired.');
   challenge.consumedAt = new Date(); challenge.codeHash = null; await em.save(challenge);
   if (!inv.consumedAt) { inv.email = challenge.email; inv.consumedAt = new Date(); await em.save(inv); await this.activity(em,inv.id,'INVITATION_CLAIMED'); }
   const app = await em.getRepository(DispatcherApplication).findOneByOrFail({ invitationId: inv.id });
   await this.activity(em,inv.id,'APPLICANT_VERIFIED');
   return app.id;
  });
  await new Promise<void>((resolve,reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.applicantApplicationId = applicationId;
  req.session.expiresAt = Date.now()+3600000;
  req.session.cookie.maxAge = 3600000;
  await new Promise<void>((resolve,reject) => req.session.save(error => error ? reject(error) : resolve()));
  return { applicationId };
 }
 private async applicant(em: EntityManager, req: Request, lock = false) {
  if (!req.session?.applicantApplicationId || !req.session.expiresAt || req.session.expiresAt <= Date.now()) throw new UnauthorizedException('Please verify your access again.');
  const app = await em.getRepository(DispatcherApplication).findOne({ where: { id: req.session.applicantApplicationId } });
  if (!app) throw new UnauthorizedException();
  // Invitation lock serializes revocation, draft updates and submissions in the same order.
  const inv = await em.getRepository(Invitation).findOne({ where: { id: app.invitationId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  if (!inv || inv.revokedAt) throw new UnauthorizedException('This application is no longer available.');
  const current = lock ? await em.getRepository(DispatcherApplication).findOneByOrFail({ id: app.id }) : app;
  if (current.applicantAccessUntil.getTime() <= Date.now()) throw new UnauthorizedException('Application access has expired. Contact your manager.');
  return { application: current, invitation: inv };
 }
 private async applicantView(em: EntityManager, app: DispatcherApplication, inv: Invitation) {
  const correction = app.status === 'CHANGES_REQUESTED'
   ? await em.getRepository(ApplicationReview).findOne({where:{applicationId:app.id,decisionType:'REQUEST_CHANGES'},order:{applicationVersion:'DESC'}}) : null;
  const lastSubmission = correction ? await em.getRepository(ApplicationSubmission).findOne({where:{applicationId:app.id},order:{version:'DESC'}}) : null;
  // Existing correction rounds must allow completion of newly required fields too. Base this
  // on the submitted revision so saved values remain editable until the applicant resubmits.
  const effectiveCorrections = correction ? [...new Set([...correction.requestedFields,...requiredApplicantFields(lastSubmission?.fields ?? {})])] : [];
  const editableFields = correction ? effectiveCorrections : ['INVITED','DRAFT'].includes(app.status) ? [...CORRECTION_FIELDS] : [];
  // Explicit projection: no internal review comments, reviewer identity or histories to applicants.
  return { application:{id:app.id,invitationId:app.invitationId,status:app.status,fields:app.fields,version:app.version,updatedAt:app.updatedAt,submittedAt:app.submittedAt},
   invitation:{id:inv.id,email:inv.email,mcName:inv.mcName,teamLead:inv.teamLead,jobTitle:inv.jobTitle,telegramRequired:inv.telegramRequired},
   correction:correction ? {id:correction.id,reason:correction.reason,requestedFields:effectiveCorrections,createdAt:correction.createdAt} : null,
   editableFields, canEdit:editableFields.length>0, accessUntil:app.applicantAccessUntil };
 }
 async current(req: Request) {
  const {application,invitation} = await this.applicant(this.db.manager,req);
  return this.applicantView(this.db.manager,application,invitation);
 }
 async save(req: Request, input: DraftDto | SubmitDto, submit: boolean) {
  if (!req.session?.applicantApplicationId) throw new UnauthorizedException();
  await this.limit('save:'+req.session.applicantApplicationId,60,60);
  return this.db.transaction(async em => {
   const { application: app, invitation: inv } = await this.applicant(em,req,true);
   // Retry only the most recent submission, never apply stale requests to a later correction cycle.
   if (['SUBMITTED','RESUBMITTED'].includes(app.status) && submit && input.version === app.version-1) return this.applicantView(em,app,inv);
   if (!['INVITED','DRAFT','CHANGES_REQUESTED'].includes(app.status)) throw new ConflictException('This application is not open for changes.');
   if (input.version !== app.version) throw new ConflictException('Your application changed. Reload before saving.');
   const view = await this.applicantView(em,app,inv);
   const fields: ApplicationFields = {...app.fields};
   for (const key of CORRECTION_FIELDS) {
    if (input[key] === undefined) continue;
    if (!view.editableFields.includes(key) && input[key] !== (app.fields[key] ?? '')) throw new BadRequestException('Only requested fields may be corrected.');
    if (view.editableFields.includes(key)) fields[key] = input[key];
   }
   if (submit) {
    const missing = requiredApplicantFields(fields);
    if (missing.length) throw new BadRequestException(`Complete required applicant fields: ${missing.join(', ')}.`);
    if (!('accurate' in input) || input.accurate !== true) throw new BadRequestException('Confirm the information is accurate before submission.');
   }
   if (submit && inv.telegramRequired && !fields.telegram?.trim()) throw new BadRequestException('Telegram is required.');
   const correcting = app.status === 'CHANGES_REQUESTED';
   const nextStatus = submit ? (correcting ? 'RESUBMITTED' : 'SUBMITTED') : (app.status === 'INVITED' ? 'DRAFT' : app.status);
   if (app.status !== nextStatus) requireTransition(app.status,nextStatus);
   app.fields = fields;
   app.status = nextStatus;
   app.version += 1;
   if (submit) {
    app.submittedAt = new Date();
    if (!inv.completedAt) { inv.completedAt = app.submittedAt; await em.save(inv); }
    await em.getRepository(ApplicationSubmission).save({applicationId:app.id,version:app.version,fields:app.fields});
   }
   await em.save(app);
   await this.activity(em,inv.id,submit ? (correcting ? 'APPLICATION_RESUBMITTED' : 'APPLICATION_SUBMITTED') : (correcting ? 'CORRECTIONS_SAVED' : 'DRAFT_SAVED'));
   return this.applicantView(em,app,inv);
  });
 }
}
