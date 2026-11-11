import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { Role, type User } from '../users/user.entity';
import { ApplicationSubmission, DispatcherApplication, Invitation } from '../onboarding/entities';
import { ItLeaveActivity, ItLeaveRequest, ItOnboardingActivity, ItOnboardingRequest, ItRemovalActivity, ItRemovalRequest } from '../it/it.entity';
import { alreadyHere } from '../onboarding/already-here';
import { telegramUsername } from './account-details';
import { lockSetupRequests, sameSetups } from '../it/removal';
import { CorrectDetailsDto } from './dispatch.dto';
import { CORRECTABLE_DETAILS, type CorrectableDetail, type CorrectedDetails, DispatchEvent, DispatchMember, MemberDetailCorrection } from './dispatch.entity';

/** What a dispatcher's application says for each correctable field, before any correction. */
export function applicationDetails(source: object, email: string | null): Record<CorrectableDetail, string | null> {
 const fields = source as Record<string, unknown>, value = (key: string) => typeof fields[key] === 'string' && (fields[key] as string).trim() ? (fields[key] as string).trim() : null;
 return { legalFirstName: value('firstName'), legalLastName: value('lastName'), preferredAmericanFirstName: value('preferredAmericanFirstName'), preferredAmericanLastName: value('preferredAmericanLastName'),
  personalEmail: email, personalPhoneNumber: value('personalPhoneNumber'), telegram: value('telegram') };
}
/** The details shown everywhere: an administrator's correction where there is one, else the application. */
export function currentDetails(original: Record<CorrectableDetail, string | null>, corrected: CorrectedDetails) {
 return Object.fromEntries(CORRECTABLE_DETAILS.map(field => [field, field in corrected ? corrected[field] ?? null : original[field]])) as Record<CorrectableDetail, string | null>;
}
const displayName = (details: Record<CorrectableDetail, string | null>) => details.preferredAmericanFirstName && details.preferredAmericanLastName ? `${details.preferredAmericanFirstName} ${details.preferredAmericanLastName}` : null;

/**
 * Correcting a dispatcher's details (section 36, designed and approved 2026-11-11). Administrators only. The application and
 * its submitted revisions never change, and neither do signed documents: the correction lives on the dispatcher record, each
 * change is kept with its earlier and new value and a reason, and an unfinished IT setup or removal picks up the new values.
 */
@Injectable()
export class MemberDetailsService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService) {}
 private get fictionalOnly() { return !(this.config.get('NODE_ENV') === 'production' || this.config.get('DEPLOYMENT_PURPOSE') === 'production'); }

 async correct(user: User, id: string, dto: CorrectDetailsDto) {
  if (user.role !== Role.SYSTEM_ADMIN) throw new ForbiddenException('Only administrators correct a dispatcher’s details.');
  if (dto.personalEmail && this.fictionalOnly && !dto.personalEmail.toLowerCase().endsWith('@example.test')) throw new BadRequestException('Outside production, the personal email must be a fictional example.test address.');
  return this.db.transaction(async em => {
   // IT setups before the member, the order IT completion takes them in.
   const locked = await lockSetupRequests(em, id), setups = locked.filter(setup => !setup.completedAt);
   const member = await em.getRepository(DispatchMember).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
   // A setup asked for while this waited would keep the old details.
   await sameSetups(em, id, locked);
   if (member.version !== dto.version) throw new ConflictException('Someone else changed this record. Reload and try again.');
   if (member.status === 'LEFT') throw new ConflictException('This person has left; their record is kept for history.');
   const changes: { field: string; from: string | null; to: string | null }[] = [];
   const change = (field: string, from: string | null, to: string | null) => { if ((from ?? '') !== (to ?? '')) changes.push({ field, from, to }); };
   let details: Record<CorrectableDetail, string | null> | null = null;
   if (member.applicationId) {
    if (dto.firstName !== undefined || dto.lastName !== undefined) throw new BadRequestException('Their name comes from their application: correct the legal or American name.');
    const application = await em.getRepository(DispatcherApplication).findOneByOrFail({ id: member.applicationId });
    const invitation = await em.getRepository(Invitation).findOneByOrFail({ id: application.invitationId });
    const submitted = await em.getRepository(ApplicationSubmission).findOne({ where: { applicationId: application.id }, order: { version: 'DESC' } });
    const before = currentDetails(applicationDetails(submitted?.fields ?? {}, invitation.email), member.correctedDetails ?? {});
    const corrected: CorrectedDetails = { ...(member.correctedDetails ?? {}) };
    for (const field of CORRECTABLE_DETAILS) {
     let value = dto[field];
     if (value === undefined) continue;
     if (field === 'personalEmail') value = value.toLowerCase();
     if (field === 'telegram' && value) { const username = telegramUsername(value); if (!username) throw new BadRequestException('Telegram should be a username, like @name.'); value = username; }
     const next = value || null;
     if ((before[field] ?? '') === (next ?? '')) continue;
     change(field, before[field], next); corrected[field] = next;
    }
    details = currentDetails(applicationDetails(submitted?.fields ?? {}, invitation.email), corrected);
    // One person, one record (section 37): an email can't be someone else's here now or another open application's.
    if (changes.some(item => item.field === 'personalEmail') && details.personalEmail) {
     const matches = (await alreadyHere(em, [{ key: 'email', email: details.personalEmail, phone: null, applicationId: member.applicationId, skipMemberId: member.id }])).get('email') ?? [];
     const taken = matches.find(match => match.kind === 'APPLICATION' || match.status !== 'LEFT');
     if (taken) throw new ConflictException(taken.kind === 'MEMBER' ? `This email belongs to ${taken.name}, who works here now.` : 'Another open application uses this email.');
    }
    member.correctedDetails = corrected;
    // The American name is what the workspace calls them.
    const name = displayName(details);
    if (name && (changes.some(item => item.field.startsWith('preferredAmerican')))) { member.firstName = details.preferredAmericanFirstName!.slice(0, 100); member.lastName = details.preferredAmericanLastName!.slice(0, 100); }
   } else {
    if (CORRECTABLE_DETAILS.some(field => dto[field] !== undefined)) throw new BadRequestException('Someone added by hand has no application: edit their recorded details instead.');
    if (dto.firstName !== undefined) { change('firstName', member.firstName, dto.firstName); member.firstName = dto.firstName; }
    if (dto.lastName !== undefined) { change('lastName', member.lastName, dto.lastName); member.lastName = dto.lastName; }
   }
   if (!changes.length) throw new BadRequestException('Nothing changed.');
   member.version += 1; await em.save(member);
   await em.getRepository(MemberDetailCorrection).save({ memberId: id, changes, reason: dto.reason, actorId: user.id });
   const fields = changes.map(item => item.field);
   await em.getRepository(DispatchEvent).save({ memberId: id, teamId: null, event: 'DETAILS_CORRECTED', actorId: user.id, metadata: { fields } });
   await this.carryToIt(em, member, setups, details, fields, user.id);
   return { id, version: member.version };
  });
 }

 /** An unfinished IT setup works from the corrected details, and open leave checklists and an open removal show the corrected name. Activity holds field names only. */
 private async carryToIt(em: EntityManager, member: DispatchMember, setups: ItOnboardingRequest[], details: Record<CorrectableDetail, string | null> | null, fields: string[], actorId: string) {
  const name = `${member.firstName} ${member.lastName}`.trim();
  for (const setup of setups) {
   // Someone added by hand: IT's profile names them by their record, as support setups do (support-setup.ts).
   const profile = details ? { ...setup.profile, legalFirstName: details.legalFirstName, legalLastName: details.legalLastName, preferredAmericanFirstName: details.preferredAmericanFirstName,
    preferredAmericanLastName: details.preferredAmericanLastName, proposedDisplayName: displayName(details), personalPhoneNumber: details.personalPhoneNumber, personalEmail: details.personalEmail }
    : { ...setup.profile, preferredAmericanFirstName: member.firstName, preferredAmericanLastName: member.lastName || null, proposedDisplayName: name };
   // Only a change IT can see (not Telegram, say) bumps the version, so IT isn't asked to reload for nothing.
   if (JSON.stringify(profile) === JSON.stringify(setup.profile)) continue;
   setup.profile = profile; setup.version += 1; await em.save(setup);
   await em.getRepository(ItOnboardingActivity).save({ requestId: setup.id, actorId, event: 'DETAILS_CORRECTED', metadata: { fields: fields.join(',') } });
  }
  // Leave checklists not finished yet name them too.
  const leaveRequests = await em.getRepository(ItLeaveRequest).find({ where: { memberId: member.id, completedAt: IsNull(), cancelledAt: IsNull() }, order: { id: 'ASC' }, lock: { mode: 'pessimistic_write' } });
  for (const request of leaveRequests.filter(item => item.profile.displayName !== name)) {
   request.profile = { ...request.profile, displayName: name }; request.version += 1; await em.save(request);
   await em.getRepository(ItLeaveActivity).save({ requestId: request.id, actorId, event: 'DETAILS_CORRECTED', metadata: { fields: 'displayName' } });
  }
  const removal = await em.getRepository(ItRemovalRequest).findOne({ where: { memberId: member.id, completedAt: IsNull(), cancelledAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
  if (removal && removal.profile.displayName !== name) {
   removal.profile = { ...removal.profile, displayName: name }; removal.version += 1; await em.save(removal);
   await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId, event: 'DETAILS_CORRECTED', metadata: { fields: 'displayName' } });
  }
 }

 /** Each correction with its fields and values, newest first: staff only, for the dispatcher page's history. */
 history(em: Pick<EntityManager, 'query'>, memberId: string) {
  return em.query(`SELECT c.id, c.changes, c.reason, c."createdAt", u."firstName" || ' ' || u."lastName" AS "correctedBy"
   FROM member_detail_corrections c JOIN users u ON u.id = c."actorId" WHERE c."memberId" = $1 ORDER BY c."createdAt" DESC`, [memberId]);
 }
}
