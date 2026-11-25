import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { webOrigins } from '../../config/environment';
import { canAccessAssignedApplication } from '../auth/policy';
import { Role, User } from '../users/user.entity';
import { ApplicationActivity, DispatcherApplication, Invitation, MORE_TIME_DAYS, UNDECIDED_STATUSES } from './entities';
import { refuseSecondApplication } from './already-here';
import { SEND_LIMITS } from './onboarding.service';
import { accessEndedKey, attemptWindow, clearAttempt, onboardingLimit, sendsKey } from './rate-limit';

/** Applications whose applicant can still come back to change something. */
const OPEN = ['DRAFT', 'CHANGES_REQUESTED'];
const UNDECIDED: readonly string[] = UNDECIDED_STATUSES;

/**
 * Returning applicants (section 42, approved 2026-11-24). Applicants are told the same thing whatever went wrong, so nobody
 * can find out which emails or applications exist; staff see why here. The responsible manager or an administrator sees
 * until when the applicant can return and today's codes, and may give more time; only administrators reset the daily code
 * limit. Nobody is messaged; both are recorded in the application's activity (ACCESS_EXTENDED, CODE_LIMIT_RESET).
 */
@Injectable()
export class ReturningService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService) {}

 async status(user: User, id: string) {
  const application = await this.db.getRepository(DispatcherApplication).findOneBy({ id });
  if (!application || !canAccessAssignedApplication(user, application)) throw new NotFoundException();
  const invitation = await this.db.getRepository(Invitation).findOneByOrFail({ id: application.invitationId });
  // Before they verify their email there is nobody to return; the invitation link still works.
  if (!invitation.consumedAt || !invitation.email) throw new ConflictException('They haven’t verified their email yet.');
  const window = await attemptWindow(this.db, sendsKey(invitation.email));
  // Every request counts, sent or not, in a 24-hour window from the first; the limit refuses by this count. Shown up to the limit.
  const codes = Math.min(window?.attempts ?? 0, SEND_LIMITS.perAddressDaily), limited = codes >= SEND_LIMITS.perAddressDaily;
  const ended = application.applicantAccessUntil.getTime() <= Date.now(), catchUp = !!invitation.catchUpMemberId, revoked = !!invitation.revokedAt;
  const [inviter]: { name: string }[] = await this.db.query(`SELECT "firstName" || ' ' || "lastName" AS name FROM users WHERE id = $1`, [invitation.managerId]);
  // The application page of an application not sent yet shows no answers (they stay private until sent), only this and its activity.
  const activity = application.submittedAt ? null : await this.db.getRepository(ApplicationActivity).find({ where: { invitationId: invitation.id }, order: { createdAt: 'ASC' } });
  // 5: why an administrator can't reset now, so the page never points them at a refused action.
  const resetWhy = user.role !== Role.SYSTEM_ADMIN || !limited ? null : revoked ? 'Their invitation was revoked.' : catchUp ? 'Catch-up paperwork is handled from their dispatcher page.'
   : !UNDECIDED.includes(application.status) ? 'This application is decided.' : ended ? 'Their time to return has ended. Give them more time first.' : null;
  return { applicationId: application.id, status: application.status, email: invitation.email, startedAt: invitation.consumedAt, invitedBy: inviter?.name ?? null, catchUp, revoked,
   accessUntil: application.applicantAccessUntil, ended, codes, limit: SEND_LIMITS.perAddressDaily, limited, countResetsAt: window?.expiresAt ?? null, nextCodeAt: limited ? window!.expiresAt : null,
   canGiveTime: !catchUp && !revoked && OPEN.includes(application.status), canReset: user.role === Role.SYSTEM_ADMIN && !catchUp && !revoked && !ended && UNDECIDED.includes(application.status) && codes > 0,
   admin: user.role === Role.SYSTEM_ADMIN, resetWhy, moreTimeDays: MORE_TIME_DAYS,
   // 6: the returning link on the primary origin, as invitation links are made.
   returnLink: `${webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0]}/apply/resume`, activity };
 }

 /**
  * Give more time (GiveMoreTimeScreen): 7, 14 or 30 days from now, never shortening. Only the date changes, never the
  * application's version, so an applicant still typing keeps their unsaved answers; nothing is recorded when it changed nothing.
  */
 async moreTime(user: User, id: string, days: number) {
  await onboardingLimit(this.db, 'more-time:' + user.id, 30, 60);
  return this.db.transaction(async em => {
   const { invitation, application } = await this.locked(em, user, id);
   // Catch-up paperwork has its own More time on the dispatcher page.
   if (invitation.catchUpMemberId) throw new BadRequestException('Give them more time from their dispatcher page.');
   if (!OPEN.includes(application.status)) throw new ConflictException('More time is only for an application not sent yet, or one with changes requested.');
   const until = new Date(Date.now() + days * 86400000);
   if (until.getTime() <= application.applicantAccessUntil.getTime()) return { accessUntil: application.applicantAccessUntil, changed: false };
   // Once its time ended another invitation could be claimed with the same email: never two open at once (section 37's rule).
   await refuseSecondApplication(em, invitation.email!, invitation.id).catch((error: unknown) => {
    if (error instanceof ConflictException) throw new ConflictException(`Another application with ${invitation.email} is in progress. Continue that one, or close it before giving this one more time.`);
    throw error;
   });
   await em.update(DispatcherApplication, { id }, { applicantAccessUntil: until });
   await clearAttempt(em, accessEndedKey(invitation.id));
   await em.getRepository(ApplicationActivity).save({ invitationId: invitation.id, event: 'ACCESS_EXTENDED', actorId: user.id });
   return { accessUntil: until, changed: true };
  });
 }

 /** Reset code limit (ResetCodeLimitScreen, administrators only): clears the daily count for their verified email. */
 async resetCodeLimit(user: User, id: string, confirmed: boolean) {
  if (user.role !== Role.SYSTEM_ADMIN) throw new NotFoundException();
  if (!confirmed) throw new BadRequestException('Confirm the applicant asked you for a new code.');
  await onboardingLimit(this.db, 'code-limit-reset:' + user.id, 20, 60);
  return this.db.transaction(async em => {
   const { invitation, application } = await this.locked(em, user, id);
   if (invitation.catchUpMemberId) throw new BadRequestException('Catch-up paperwork is handled from their dispatcher page.');
   if (!UNDECIDED.includes(application.status)) throw new ConflictException('This application is decided, so they no longer return to it.');
   if (application.applicantAccessUntil.getTime() <= Date.now()) throw new ConflictException('Their time to return has ended. Give them more time first.');
   await clearAttempt(em, sendsKey(invitation.email!));
   await em.getRepository(ApplicationActivity).save({ invitationId: invitation.id, event: 'CODE_LIMIT_RESET', actorId: user.id });
   return { codes: 0 };
  });
 }

 /** The invitation locked first, as every application write does, then the application read again under it. */
 private async locked(em: EntityManager, user: User, id: string) {
  const current = await em.getRepository(DispatcherApplication).findOneBy({ id });
  if (!current || !canAccessAssignedApplication(user, current)) throw new NotFoundException();
  const invitation = await em.getRepository(Invitation).findOneOrFail({ where: { id: current.invitationId }, lock: { mode: 'pessimistic_write' } });
  const application = await em.getRepository(DispatcherApplication).findOneByOrFail({ id });
  if (!canAccessAssignedApplication(user, application)) throw new NotFoundException();
  if (invitation.revokedAt) throw new ConflictException('This invitation was revoked, so they can’t return to it.');
  if (!invitation.consumedAt || !invitation.email) throw new ConflictException('They haven’t verified their email yet. Their invitation link still works until it expires.');
  return { invitation, application };
 }
}
