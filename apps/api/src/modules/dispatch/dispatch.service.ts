import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, QueryFailedError } from 'typeorm';
import type { User } from '../users/user.entity';
import { JobTitle, listNameKey, Mc } from '../lists/lists.entity';
import { Role } from '../users/user.entity';
import { AddContactDto, CreateTeamDto, LeaveMemberDto, MoveMemberDto, ReassignSupportDto, UpdateMemberDto, UpdateTeamDto, validPhone } from './dispatch.dto';
import { DispatchEvent, DispatchEventType, DispatchMember, MemberAssignment, MemberContact, MemberSupportLink, PromotionRequest, Team } from './dispatch.entity';
import { lockTeam, supportedDispatcher } from './create-member';

const STALE = 'Someone else changed this record. Reload and try again.';
// A date picked in the form is stored at midday UTC, so it shows as the same calendar day in every US time zone.
// A change dated the same day as the period it ends starts at that period's start: a date picked in a form is midday UTC,
// while an approval or earlier change that same day may have a later time. Anything clearly earlier is refused.
function notBefore(date: Date, previous: Date, message: string) {
 if (date.getTime() > previous.getTime()) return date;
 // One millisecond after: the database keeps microseconds that a JavaScript date would round down to before the start.
 if (previous.getTime() - date.getTime() <= 36 * 3600_000) return new Date(previous.getTime() + 1);
 throw new BadRequestException(message);
}
function day(value: string) {
 const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
 if (Number.isNaN(date.getTime())) throw new BadRequestException('Choose a valid date.');
 if (date.getTime() > Date.now() + 36 * 3600_000) throw new BadRequestException('The date can’t be in the future.');
 return date;
}

/**
 * Teams and dispatch members (records only, no login). Dispatcher managers and administrators see and manage all of
 * them. Where a member works is history: a move closes the open assignment and opens a new one, never overwriting.
 * A team lead must be an active dispatcher currently in that team; leaving or moving out of the team clears the lead.
 */
@Injectable()
export class DispatchService {
 constructor(private readonly db: DataSource) {}

 async teams(status: 'ACTIVE' | 'ARCHIVED' | 'ALL' = 'ALL') {
  const items: Record<string, unknown>[] = await this.db.query(`SELECT t.id, t.name, t.version, t."archivedAt" IS NOT NULL AS archived,
    json_build_object('id', m.id, 'name', m.name) AS mc,
    CASE WHEN l.id IS NULL THEN NULL ELSE json_build_object('id', l.id, 'name', l."firstName" || ' ' || l."lastName") END AS lead,
    (SELECT count(*)::integer FROM member_assignments a JOIN dispatch_members d ON d.id = a."memberId" WHERE a."teamId" = t.id AND a."endedAt" IS NULL AND d.status = 'ACTIVE') AS members,
    (SELECT count(*)::integer FROM member_assignments a JOIN dispatch_members d ON d.id = a."memberId" WHERE a."teamId" = t.id AND a."endedAt" IS NULL AND d.status = 'ONBOARDING') AS onboarding
   FROM teams t JOIN mcs m ON m.id = t."mcId" LEFT JOIN dispatch_members l ON l.id = t."leadMemberId"
   WHERE ($1 = 'ALL' OR ($1 = 'ACTIVE') = (t."archivedAt" IS NULL)) ORDER BY m."nameKey", t."nameKey"`, [status]);
  const [counts] = await this.db.query(`SELECT count(*) FILTER (WHERE "archivedAt" IS NULL)::integer AS active, count(*) FILTER (WHERE "archivedAt" IS NOT NULL)::integer AS archived FROM teams`);
  return { items, counts };
 }

 async createTeam(user: User, dto: CreateTeamDto) {
  return this.write(async em => {
   await this.activeMc(em, dto.mcId);
   const team = await em.getRepository(Team).save({ name: dto.name, nameKey: listNameKey(dto.name), mcId: dto.mcId });
   await this.event(em, user, 'TEAM_CREATED', { teamId: team.id }, { fields: ['name', 'mcId'] });
   return { id: team.id, version: team.version };
  });
 }

 async updateTeam(user: User, id: string, dto: UpdateTeamDto) {
  return this.write(async em => {
   // A new lead's record is locked before the team (member, then team, like move and leave), so they can't move out or
   // leave between this check and the commit.
   const candidate = dto.leadMemberId ? await em.getRepository(DispatchMember).findOne({ where: { id: dto.leadMemberId }, lock: { mode: 'pessimistic_write' } }) : null;
   const team = await em.getRepository(Team).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!team) throw new NotFoundException('This team no longer exists.');
   if (team.version !== dto.version) throw new ConflictException(STALE);
   const members = await this.teamMembers(em, id);
   const fields: string[] = [];
   if (dto.name !== undefined && dto.name !== team.name) { team.name = dto.name; team.nameKey = listNameKey(dto.name); fields.push('name'); }
   if (dto.mcId !== undefined && dto.mcId !== team.mcId) {
    if (members.length) throw new ConflictException('Move this team’s dispatchers first; a team keeps its MC while it has dispatchers.');
    await this.activeMc(em, dto.mcId); team.mcId = dto.mcId; fields.push('mcId');
   }
   if (dto.leadMemberId !== undefined && dto.leadMemberId !== team.leadMemberId) {
    const placed = candidate && await em.getRepository(MemberAssignment).existsBy({ memberId: candidate.id, teamId: id, endedAt: IsNull() });
    if (dto.leadMemberId && !(placed && candidate.position === 'DISPATCHER' && candidate.status === 'ACTIVE'))
     throw new BadRequestException('The team lead must be an active dispatcher in this team.');
    team.leadMemberId = dto.leadMemberId; fields.push('leadMemberId');
   }
   const archive = dto.archived === undefined || dto.archived === (team.archivedAt !== null) ? null : dto.archived;
   if (archive) {
    if (members.length) throw new ConflictException('A team can only be archived once it has no dispatchers.');
    team.archivedAt = new Date(); team.leadMemberId = null;
   } else if (archive === false) { await this.activeMc(em, team.mcId); team.archivedAt = null; }
   if (!fields.length && archive === null) return { id, version: team.version };
   team.version += 1;
   await em.getRepository(Team).save(team);
   if (fields.length) await this.event(em, user, 'TEAM_UPDATED', { teamId: id }, { fields });
   if (archive !== null) await this.event(em, user, archive ? 'TEAM_ARCHIVED' : 'TEAM_RESTORED', { teamId: id }, {});
   return { id, version: team.version };
  });
 }

 async members(status: 'ONBOARDING' | 'ACTIVE' | 'LEFT' | 'ALL' = 'ALL') {
  const items: Record<string, unknown>[] = await this.db.query(`SELECT d.id, d."firstName", d."lastName", d.position, d.status, d.version, d."joinedAt", d."leftAt",
    jt.name AS "jobTitle", coalesce(sl."startedAt", a."startedAt") AS since, m.name AS mc, t.id AS "teamId", t.name AS team, (t."leadMemberId" = d.id) IS TRUE AS lead,
    sl."dispatcherId", CASE WHEN sd.id IS NULL THEN NULL ELSE sd."firstName" || ' ' || sd."lastName" END AS dispatcher
   FROM dispatch_members d LEFT JOIN job_titles jt ON jt.id = d."jobTitleId"
   LEFT JOIN LATERAL (SELECT * FROM member_support_links l WHERE l."supportId" = d.id AND l."endedAt" IS NULL AND d.position = 'SUPPORT' LIMIT 1) sl ON true
   LEFT JOIN dispatch_members sd ON sd.id = sl."dispatcherId"
   LEFT JOIN LATERAL (SELECT * FROM member_assignments x WHERE x."memberId" = coalesce(sl."dispatcherId", d.id) ORDER BY x."startedAt" DESC, x."createdAt" DESC LIMIT 1) a ON true
   LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN teams t ON t.id = a."teamId"
   WHERE ($1 = 'ALL' OR d.status = $1) ORDER BY lower(d."firstName"), lower(d."lastName") LIMIT 1000`, [status]);
  const [counts] = await this.db.query(`SELECT count(*) FILTER (WHERE status = 'ONBOARDING')::integer AS onboarding, count(*) FILTER (WHERE status = 'ACTIVE')::integer AS active, count(*) FILTER (WHERE status = 'LEFT')::integer AS left FROM dispatch_members`);
  return { items, counts };
 }

 /**
  * Everything a manager needs about one dispatcher: where they work and their history, the approved application details
  * (the latest submitted revision), the company accounts and IT progress, signed documents, the profile photo and
  * contacts staff added, and the onboarding timeline (event names and times only). Every dispatcher manager and
  * administrator may read it (agreed 2026-10-29), while the onboarding record itself and the ID selfie stay with the
  * responsible manager and administrators.
  */
 async member(user: User, id: string) {
  const member = await this.db.getRepository(DispatchMember).findOneBy({ id });
  if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
  const application = member.applicationId ? (await this.db.query(`SELECT a.id, a."invitationId", a."assignedManagerId", a."submittedAt", i.email,
    coalesce((SELECT s.fields FROM application_submissions s WHERE s."applicationId" = a.id ORDER BY s.version DESC LIMIT 1), a.fields) AS fields
   FROM dispatcher_applications a JOIN invitations i ON i.id = a."invitationId" WHERE a.id = $1 AND a.status = 'APPROVED'`, [member.applicationId]))[0] ?? null : null;
  const [history, jobTitle, leadOf, it, documents, photo, contacts, activity] = await Promise.all([
   this.db.query(`SELECT a.id, a."startedAt", a."endedAt", a.reason, m.id AS "mcId", m.name AS mc, m."mcNumber", t.id AS "teamId", t.name AS team,
     CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "movedBy"
    FROM member_assignments a LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN teams t ON t.id = a."teamId" LEFT JOIN users u ON u.id = a."actorId"
    WHERE a."memberId" = $1 ORDER BY a."startedAt" DESC, a."createdAt" DESC`, [id]),
   member.jobTitleId ? this.db.getRepository(JobTitle).findOneBy({ id: member.jobTitleId }) : null,
   this.db.getRepository(Team).findOneBy({ leadMemberId: id }),
   // The company accounts IT recorded and how far setup is; never IT notes or verification metadata.
   application ? this.db.query(`SELECT r."companyEmail", r."assignedRingCentralPhoneNumber" AS "workPhone", r."completedAt",
     count(t.id) FILTER (WHERE t.status IN ('COMPLETED','NOT_NEEDED'))::integer AS done, count(t.id)::integer AS total
    FROM it_onboarding_requests r LEFT JOIN it_onboarding_tasks t ON t."requestId" = r.id WHERE r."applicationId" = $1 GROUP BY r.id`, [application.id]) : [],
   application ? this.db.query(`SELECT DISTINCT ON (d.id) d.id, d.kind, d.title, d.version, s."signedAt" FROM document_signatures s JOIN company_documents d ON d.id = s."documentId"
    WHERE s."applicationId" = $1 AND s."signerRole" = 'APPLICANT' ORDER BY d.id, s."signedAt"`, [application.id]) : [],
   application ? this.db.query(`SELECT EXISTS(SELECT 1 FROM applicant_photos p WHERE p."applicationId" = $1 AND p.kind = 'SELFIE' AND p."createdAt" <= $2) AS present,
     EXISTS(SELECT 1 FROM applicant_photos p WHERE p."applicationId" = $1 AND p.kind = 'ID_SELFIE' AND p."createdAt" <= $2) AS "idPresent"`, [application.id, application.submittedAt]) : [{ present: false, idPresent: false }],
   this.db.query(`SELECT c.id, c.kind, c.value, c.label, c."createdAt", CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "addedBy"
    FROM member_contacts c LEFT JOIN users u ON u.id = c."addedBy" WHERE c."memberId" = $1 AND c."removedAt" IS NULL ORDER BY c."createdAt"`, [id]),
   application ? this.db.query(`SELECT id, event, "createdAt" FROM application_activity WHERE "invitationId" = $1 ORDER BY "createdAt"`, [application.invitationId]) : [],
  ]);
  const canOpenApplication = !!application && (user.role === Role.SYSTEM_ADMIN || application.assignedManagerId === user.id);
  const fields = (application?.fields ?? {}) as Record<string, string | undefined>;
  const current = history.find((row: { endedAt: Date | null }) => row.endedAt === null) ?? null;
  // A support's dispatchers over time (the open row is now, with that dispatcher's MC and team); a dispatcher's supports now.
  const supportHistory = member.position === 'SUPPORT' ? await this.db.query(`SELECT l.id, l."startedAt", l."endedAt", l.reason, d.id AS "dispatcherId",
    d."firstName" || ' ' || d."lastName" AS dispatcher, d.status AS "dispatcherStatus", m.name AS mc, t.name AS team,
    CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "changedBy"
   FROM member_support_links l JOIN dispatch_members d ON d.id = l."dispatcherId" LEFT JOIN users u ON u.id = l."actorId"
   LEFT JOIN LATERAL (SELECT * FROM member_assignments a WHERE a."memberId" = d.id AND a."endedAt" IS NULL LIMIT 1) a ON true
   LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN teams t ON t.id = a."teamId"
   WHERE l."supportId" = $1 ORDER BY l."startedAt" DESC, l."createdAt" DESC`, [id]) : [];
  const supports = member.position === 'DISPATCHER' ? await this.db.query(`SELECT s.id, s."firstName" || ' ' || s."lastName" AS name, s.status, l."startedAt" AS since
   FROM member_support_links l JOIN dispatch_members s ON s.id = l."supportId" WHERE l."dispatcherId" = $1 AND l."endedAt" IS NULL ORDER BY lower(s."firstName")`, [id]) : [];
  return { id: member.id, firstName: member.firstName, lastName: member.lastName, position: member.position, status: member.status, version: member.version,
   joinedAt: member.joinedAt, leftAt: member.leftAt, applicationId: member.applicationId, jobTitle: jobTitle ? { id: jobTitle.id, name: jobTitle.name } : null,
   current, history, leadOf: leadOf ? { id: leadOf.id, name: leadOf.name } : null, accounts: it[0] ?? null,
   // The onboarding record itself stays with its responsible manager and administrators.
   canOpenApplication, activity, supportHistory, supportOf: supportHistory.find((row: { endedAt: Date | null }) => row.endedAt === null) ?? null, supports,
   details: application ? { legalFirstName: fields.firstName ?? null, legalLastName: fields.lastName ?? null, preferredAmericanFirstName: fields.preferredAmericanFirstName ?? null,
    preferredAmericanLastName: fields.preferredAmericanLastName ?? null, personalEmail: application.email, personalPhoneNumber: fields.personalPhoneNumber ?? null,
    telegram: fields.telegram ?? null, mcName: fields.mcName ?? null, teamLead: fields.teamLead ?? null, jobTitle: fields.jobTitle ?? null, submittedAt: application.submittedAt } : null,
   documents, photo: !!photo[0]?.present, idPhoto: canOpenApplication && !!photo[0]?.idPresent, contacts };
 }

 async addContact(user: User, id: string, dto: AddContactDto) {
  const value = dto.kind === 'EMAIL' ? dto.value.toLowerCase() : dto.value;
  if (dto.kind === 'PHONE' && !validPhone(value)) throw new BadRequestException('Use 7–15 digits; international formatting is accepted.');
  return this.write(async em => {
   const member = await em.getRepository(DispatchMember).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
   if (await em.getRepository(MemberContact).countBy({ memberId: id, removedAt: IsNull() }) >= 10) throw new BadRequestException('A dispatcher can have up to 10 added contacts. Remove one first.');
   try {
    const contact = await em.getRepository(MemberContact).save({ memberId: id, kind: dto.kind, value, label: dto.label || null, addedBy: user.id });
    await this.event(em, user, 'CONTACT_ADDED', { memberId: id }, { kind: dto.kind, labelled: !!dto.label });
    return { id: contact.id };
   } catch (error) {
    if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23505') throw new ConflictException(`This ${dto.kind === 'EMAIL' ? 'email' : 'phone number'} is already on the record.`);
    throw error;
   }
  });
 }

 async removeContact(user: User, id: string, contactId: string) {
  return this.write(async em => {
   const contact = await em.getRepository(MemberContact).findOne({ where: { id: contactId, memberId: id, removedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
   if (!contact) throw new NotFoundException('This contact was already removed.');
   contact.removedAt = new Date(); contact.removedBy = user.id; await em.save(contact);
   await this.event(em, user, 'CONTACT_REMOVED', { memberId: id }, { kind: contact.kind });
   return { id: contactId };
  });
 }

 async move(user: User, id: string, dto: MoveMemberDto) {
  return this.write(async em => {
   const member = await this.lockMember(em, id, dto.version);
   if (member.position === 'SUPPORT') throw new BadRequestException('Supports work where their dispatcher works. Change their dispatcher instead.');
   let startedAt = day(dto.startedAt);
   const current = await em.getRepository(MemberAssignment).findOneBy({ memberId: id, endedAt: IsNull() });
   if (dto.mcId) await this.activeMc(em, dto.mcId);
   const teamId = dto.mcId ? dto.teamId ?? null : null;
   // Teams are locked after the member and in id order (the one they join, the one they lead and may leave), so two
   // moves can't deadlock. Which team this member leads can't change meanwhile: setting a lead locks the member first.
   const led = await em.getRepository(Team).findOneBy({ leadMemberId: id });
   for (const lockId of [...new Set([teamId, led?.id].filter((value): value is string => !!value))].sort()) {
    const team = lockId === teamId ? await lockTeam(em, lockId) : await em.getRepository(Team).findOne({ where: { id: lockId }, lock: { mode: 'pessimistic_write' } });
    if (lockId === teamId && (!team || team.archivedAt || team.mcId !== dto.mcId)) throw new BadRequestException('Choose an active team of the selected MC.');
   }
   if (current && current.mcId === dto.mcId && current.teamId === teamId) throw new BadRequestException('The dispatcher already works for this MC and team.');
   if (current) startedAt = notBefore(startedAt, current.startedAt, 'The move can’t start before the current MC and team did.');
   if (current) { current.endedAt = startedAt; await em.save(current); }
   await em.getRepository(MemberAssignment).save({ memberId: id, mcId: dto.mcId, teamId, startedAt, reason: dto.reason, actorId: user.id });
   const leadCleared = await this.clearLead(em, id, teamId);
   member.version += 1; await em.save(member);
   await this.event(em, user, 'MEMBER_MOVED', { memberId: id }, { fields: ['mcId', 'teamId'], leadCleared });
   return { id, version: member.version };
  });
 }

 async leave(user: User, id: string, dto: LeaveMemberDto) {
  return this.write(async em => {
   const member = await this.lockMember(em, id, dto.version);
   // Their supports would be left assisting no one; a manager moves them to another dispatcher first.
   if (member.position === 'DISPATCHER' && await em.getRepository(MemberSupportLink).existsBy({ dispatcherId: id, endedAt: IsNull() }))
    throw new ConflictException('This dispatcher still has supports. Reassign their supports to another dispatcher first.');
   let leftAt = day(dto.leftAt);
   const current = await em.getRepository(MemberAssignment).findOneBy({ memberId: id, endedAt: IsNull() });
   if (current) leftAt = notBefore(leftAt, current.startedAt, 'The leaving date can’t be before the current MC and team started.');
   if (current) { current.endedAt = leftAt; await em.save(current); }
   // A support leaving stops assisting their dispatcher on the same day.
   const link = await em.getRepository(MemberSupportLink).findOneBy({ supportId: id, endedAt: IsNull() });
   if (link) leftAt = notBefore(leftAt, link.startedAt, 'The leaving date can’t be before they started with their dispatcher.');
   if (link) { link.endedAt = leftAt; await em.save(link); }
   const leadCleared = await this.clearLead(em, id, null);
   // A support's open promotion request ends with them (locked after the member, as decide does).
   const pending = member.position === 'SUPPORT' ? await em.getRepository(PromotionRequest).findOne({ where: { supportId: id, status: 'PENDING' }, lock: { mode: 'pessimistic_write' } }) : null;
   if (pending) {
    Object.assign(pending, { status: 'CANCELLED', decidedBy: user.id, decidedAt: new Date(), version: pending.version + 1 });
    await em.save(pending);
    await this.event(em, user, 'PROMOTION_CANCELLED', { memberId: id }, { requestId: pending.id, memberLeft: true });
   }
   member.status = 'LEFT'; member.leftAt = leftAt; member.version += 1; await em.save(member);
   await this.event(em, user, 'MEMBER_LEFT', { memberId: id }, { leadCleared, reasonGiven: true });
   return { id, version: member.version };
  });
 }

 /** A support starts assisting another dispatcher: the current link ends on the start date and stays in the history. */
 async reassignSupport(user: User, id: string, dto: ReassignSupportDto) {
  return this.write(async em => {
   const member = await this.lockMember(em, id, dto.version);
   if (member.position !== 'SUPPORT') throw new BadRequestException('Only a support has a dispatcher to change.');
   let startedAt = day(dto.startedAt);
   await supportedDispatcher(em, dto.dispatcherId);
   const current = await em.getRepository(MemberSupportLink).findOneBy({ supportId: id, endedAt: IsNull() });
   if (current?.dispatcherId === dto.dispatcherId) throw new BadRequestException('The support already assists this dispatcher.');
   if (current) startedAt = notBefore(startedAt, current.startedAt, 'The change can’t start before the current dispatcher did.');
   if (current) { current.endedAt = startedAt; await em.save(current); }
   await em.getRepository(MemberSupportLink).save({ supportId: id, dispatcherId: dto.dispatcherId, startedAt, reason: dto.reason, actorId: user.id });
   member.version += 1; await em.save(member);
   await this.event(em, user, 'SUPPORT_REASSIGNED', { memberId: id }, { fields: ['dispatcherId'] });
   return { id, version: member.version };
  });
 }

 async updateMember(user: User, id: string, dto: UpdateMemberDto) {
  return this.write(async em => {
   const member = await this.lockMember(em, id, dto.version);
   if (dto.jobTitleId === undefined || dto.jobTitleId === member.jobTitleId) return { id, version: member.version };
   if (dto.jobTitleId) {
    const title = await em.getRepository(JobTitle).findOneBy({ id: dto.jobTitleId });
    if (!title || title.archivedAt) throw new BadRequestException('Choose an active job title.');
   }
   member.jobTitleId = dto.jobTitleId; member.version += 1; await em.save(member);
   await this.event(em, user, 'MEMBER_UPDATED', { memberId: id }, { fields: ['jobTitleId'] });
   return { id, version: member.version };
  });
 }

 private async lockMember(em: EntityManager, id: string, version: number) {
  const member = await em.getRepository(DispatchMember).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
  if (member.version !== version) throw new ConflictException(STALE);
  if (member.status === 'LEFT') throw new ConflictException('This dispatcher has left; their record is kept for history.');
  return member;
 }
 // Leaving a team ends being its lead.
 private async clearLead(em: EntityManager, memberId: string, stayingTeamId: string | null) {
  const team = await em.getRepository(Team).findOne({ where: { leadMemberId: memberId }, lock: { mode: 'pessimistic_write' } });
  if (!team || team.id === stayingTeamId) return false;
  team.leadMemberId = null; team.version += 1; await em.save(team);
  return true;
 }
 // Everyone in the team now, including dispatchers still in IT setup (a team with them keeps its MC and stays open).
 private async teamMembers(em: EntityManager, teamId: string): Promise<{ id: string; position: string; status: string }[]> {
  return em.query(`SELECT d.id, d.position, d.status FROM member_assignments a JOIN dispatch_members d ON d.id = a."memberId" WHERE a."teamId" = $1 AND a."endedAt" IS NULL AND d.status <> 'LEFT'`, [teamId]);
 }
 private async activeMc(em: EntityManager, id: string) {
  const mc = await em.getRepository(Mc).findOneBy({ id });
  if (!mc || mc.archivedAt) throw new BadRequestException('Choose an active MC.');
  return mc;
 }
 private async write<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
  try { return await this.db.transaction(work); }
  catch (error) {
   const driver = error instanceof QueryFailedError ? error.driverError as { code?: string; constraint?: string } : null;
   if (driver?.code === '23505') throw new ConflictException(driver.constraint === 'UQ_teams_nameKey' ? 'A team with this name already exists.' : 'This record changed at the same time. Reload and try again.');
   throw error;
  }
 }
 private event(em: EntityManager, user: User, event: DispatchEventType, target: { memberId?: string; teamId?: string }, metadata: Record<string, unknown>) {
  return em.getRepository(DispatchEvent).save({ memberId: target.memberId ?? null, teamId: target.teamId ?? null, event, actorId: user.id, metadata });
 }
}
