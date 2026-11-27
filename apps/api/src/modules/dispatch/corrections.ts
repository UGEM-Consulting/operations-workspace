import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { Role, type User } from '../users/user.entity';
import { ApplicationSubmission, DispatcherApplication, Invitation } from '../onboarding/entities';
import { ItLeaveActivity, ItLeaveRequest, ItOnboardingActivity, ItOnboardingRequest, ItRemovalActivity, ItRemovalRequest } from '../it/it.entity';
import { alreadyHere } from '../onboarding/already-here';
import { telegramUsername } from './account-details';
import { lockSetupRequests, sameSetups } from '../it/removal';
import { listNameKey } from '../lists/lists.entity';
import { SecurityEventType, StaffSecurityEvent } from '../auth/mfa.entity';
import { ChangeNameDto, CorrectDetailsDto } from './dispatch.dto';
import { CORRECTABLE_DETAILS, type CorrectableDetail, type CorrectedDetails, DispatchEvent, DispatchMember, MemberDetailCorrection, MemberOtherName, type NameChangeContext } from './dispatch.entity';

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
   await carryToIt(em, member, setups, details, fields, user.id);
   return { id, version: member.version };
  });
 }

 /**
  * Change name (section 45, approved 2026-11-27): dispatch managers and administrators, for anyone who hasn't left, whether they
  * came through onboarding or were added by hand. Locks as correct() does: their IT setups, then the member.
  */
 async changeName(user: User, id: string, dto: ChangeNameDto) {
  if (user.role !== Role.SYSTEM_ADMIN && user.role !== Role.DISPATCHER_MANAGER) throw new ForbiddenException('Only dispatch managers and administrators change a name.');
  if (dto.mcId && dto.companyName) throw new BadRequestException('Choose one place where the old name was used.');
  return this.db.transaction(async em => {
   await lockForRename(em);
   const locked = await lockSetupRequests(em, id);
   const member = await em.getRepository(DispatchMember).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
   await sameSetups(em, id, locked);
   if (member.version !== dto.version) throw new ConflictException('Someone else changed this record. Reload and try again.');
   if (member.status === 'LEFT') throw new ConflictException('This person has left; their record is kept for history.');
   if (dto.mcId && !(await em.query(`SELECT 1 FROM mcs WHERE id = $1`, [dto.mcId])).length) throw new BadRequestException('Choose an MC from the list.');
   await renameMember(em, member, { firstName: dto.firstName, lastName: dto.lastName, kind: dto.kind, place: { mcId: dto.mcId ?? null, companyName: dto.companyName || null }, reason: dto.reason, context: null },
    user.id, locked.filter(setup => !setup.completedAt));
   member.version += 1; await em.save(member);
   return { id, version: member.version };
  });
 }

 /** Each correction with its fields and values, newest first: staff only, for the dispatcher page's history. */
 history(em: Pick<EntityManager, 'query'>, memberId: string) {
  return em.query(`SELECT c.id, c.changes, c.reason, c.kind, c."createdAt", u."firstName" || ' ' || u."lastName" AS "correctedBy"
   FROM member_detail_corrections c JOIN users u ON u.id = c."actorId" WHERE c."memberId" = $1 ORDER BY c."createdAt" DESC`, [memberId]);
 }
}

/** on: the last day the old name was used (default today); null when that day isn't known, so the note names no date. */
export type NameChangeInput = { firstName: string; lastName: string; kind: 'NEW' | 'FIX'; place: { mcId: string | null; companyName: string | null }; reason: string; context: NameChangeContext | null; on?: Date | null };
/** A day as the History and other-name notes show it, in US Eastern time. */
const shownDay = (at: Date) => at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
/**
 * A rename can rename a team lead's sign-in (renameSignIn), so it takes user administration's advisory lock first, before any
 * row, as user administration and IT's sign-ins do: an account edit and a rename never interleave or deadlock.
 */
export async function lockForRename(em: Pick<EntityManager, 'query'>) { await em.query('SELECT pg_advisory_xact_lock(42002026)'); }
/** The most other names a record keeps, as Edit names allows (MemberNamesDto). */
export const OTHER_NAMES_MAX = 10;
const NAME_FIELDS = { first: ['preferredAmericanFirstName', 'firstName'], last: ['preferredAmericanLastName', 'lastName'] };
/** The name before a name change, from its correction row: both parts are always recorded (section 45). */
export function nameBefore(changes: { field: string; from: string | null }[]) {
 const part = (fields: string[]) => changes.find(item => fields.includes(item.field))?.from ?? '';
 return `${part(NAME_FIELDS.first)} ${part(NAME_FIELDS.last)}`.trim() || null;
}

/**
 * A new American name on a locked member (section 45), shared by Change name, a move, a rehire and a support's change of who they
 * assist; the caller bumps and saves the member's version. Someone who came through onboarding gets it as a correction of their
 * American name (their application never changes); someone added by hand on their record. Both name parts are recorded on the
 * correction row, changed or not, so the name before can always be read back (nameBefore). A new name keeps the old one as an
 * other name where it was used ("Their name until …"), unless it's already listed there, and refuses once 10 are listed; a fix
 * keeps nothing. Unfinished IT setups (locked by the caller before the member), open leave checklists and an open removal show
 * the new name.
 */
export async function renameMember(em: EntityManager, member: DispatchMember, input: NameChangeInput, actorId: string, setups: ItOnboardingRequest[]) {
 const firstName = input.firstName.trim().replace(/\s+/g, ' '), lastName = input.lastName.trim().replace(/\s+/g, ' ');
 const oldName = `${member.firstName} ${member.lastName}`.trim(), newName = `${firstName} ${lastName}`;
 if (oldName === newName) throw new BadRequestException(input.context ? 'That’s the name they have now: answer No to keep it.' : 'That’s the name they have now.');
 if (input.kind === 'NEW' && listNameKey(oldName) === listNameKey(newName)) throw new BadRequestException(input.context
  ? 'Only capitals or spacing differ from the name they have now. Answer No, then fix the spelling with Change name.' : 'Only the spelling changes: choose Fixing a mistake instead.');
 // Checked before anything is written: the old name joins their other names unless it's already listed at that place.
 const { mcId, companyName } = input.place;
 const listed: MemberOtherName[] = input.kind === 'NEW' ? await em.getRepository(MemberOtherName).findBy({ memberId: member.id }) : [];
 const already = listed.some(item => listNameKey(item.name) === listNameKey(oldName) && (item.mcId ?? null) === mcId && listNameKey(item.companyName ?? '') === listNameKey(companyName ?? ''));
 const keepOld = input.kind === 'NEW' && !!oldName && !already;
 // Going back to a name they used before: it's their name now, so it leaves their other names (wherever it was listed).
 const all: MemberOtherName[] = input.kind === 'NEW' ? listed : await em.getRepository(MemberOtherName).findBy({ memberId: member.id });
 const nowListed = all.filter(item => listNameKey(item.name) === listNameKey(newName));
 if (keepOld && listed.length - nowListed.length >= OTHER_NAMES_MAX) throw new ConflictException(`They already have ${OTHER_NAMES_MAX} other names. Remove one with Edit names, then try again.`);
 let changes: { field: string; from: string | null; to: string | null }[];
 let details: Record<CorrectableDetail, string | null> | null = null;
 if (member.applicationId) {
  const application = await em.getRepository(DispatcherApplication).findOneByOrFail({ id: member.applicationId });
  const invitation = await em.getRepository(Invitation).findOneByOrFail({ id: application.invitationId });
  const submitted = await em.getRepository(ApplicationSubmission).findOne({ where: { applicationId: application.id }, order: { version: 'DESC' } });
  const original = applicationDetails(submitted?.fields ?? {}, invitation.email), before = currentDetails(original, member.correctedDetails ?? {});
  const corrected: CorrectedDetails = { ...(member.correctedDetails ?? {}), preferredAmericanFirstName: firstName, preferredAmericanLastName: lastName };
  changes = [{ field: 'preferredAmericanFirstName', from: before.preferredAmericanFirstName ?? member.firstName, to: firstName }, { field: 'preferredAmericanLastName', from: before.preferredAmericanLastName ?? member.lastName, to: lastName }];
  member.correctedDetails = corrected; details = currentDetails(original, corrected);
 } else changes = [{ field: 'firstName', from: member.firstName, to: firstName }, { field: 'lastName', from: member.lastName, to: lastName }];
 member.firstName = firstName.slice(0, 100); member.lastName = lastName.slice(0, 100);
 await em.getRepository(MemberDetailCorrection).save({ memberId: member.id, changes, reason: input.reason, actorId, kind: input.kind === 'NEW' ? 'NEW_NAME' : 'NAME_FIX', context: input.context });
 // Field names of the parts that changed, never the names.
 const fields = changes.filter(item => item.from !== item.to).map(item => item.field);
 await em.getRepository(DispatchEvent).save({ memberId: member.id, teamId: null, event: 'DETAILS_CORRECTED', actorId, metadata: { fields, name: input.kind === 'NEW' ? 'new' : 'fix', ...(input.context ? { with: input.context } : {}), kept: keepOld, ...(nowListed.length ? { otherNameRemoved: true } : {}) } });
 if (nowListed.length) await em.getRepository(MemberOtherName).delete(nowListed.map(item => item.id));
 if (keepOld) await em.getRepository(MemberOtherName).save({ memberId: member.id, name: oldName.slice(0, 100), mcId, companyName,
  note: input.on === null ? 'Their name before they came back.' : `Their name until ${shownDay(input.on ?? new Date())}.`, addedBy: actorId });
 await renameSignIn(em, member, actorId);
 await carryToIt(em, member, setups, details, fields, actorId);
}

/**
 * A team lead's linked sign-in is named after their record (it/sign-ins.ts), so it follows a new name: their account and the
 * announcements they send show it. USER_NAME_CHANGED holds field names only and revokes no session, as in user administration.
 */
async function renameSignIn(em: EntityManager, member: DispatchMember, actorId: string) {
 if (!member.accountUserId) return;
 const renamed: { id: string }[] = await em.query(`WITH renamed AS (UPDATE users SET "firstName" = $2, "lastName" = $3 WHERE id = $1 AND ("firstName" <> $2 OR "lastName" <> $3) RETURNING id) SELECT id FROM renamed`, [member.accountUserId, member.firstName, member.lastName]);
 if (renamed.length) await em.insert(StaffSecurityEvent, { userId: member.accountUserId, actorId, type: SecurityEventType.USER_NAME_CHANGED, metadata: { fields: ['firstName', 'lastName'], reason: 'member-renamed' } });
}

/** An unfinished IT setup works from the corrected details, and open leave checklists and an open removal show the corrected name. Activity holds field names only. */
async function carryToIt(em: EntityManager, member: DispatchMember, setups: ItOnboardingRequest[], details: Record<CorrectableDetail, string | null> | null, fields: string[], actorId: string) {
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
