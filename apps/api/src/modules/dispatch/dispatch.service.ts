import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, QueryFailedError } from 'typeorm';
import type { User } from '../users/user.entity';
import { JobTitle, listNameKey, Mc } from '../lists/lists.entity';
import { Role } from '../users/user.entity';
import { AddContactDto, ChangeLastDayDto, CreateTeamDto, LeaveMemberDto, NoticeActionDto, MoveMemberDto, PlaceMemberDto, ReassignSupportDto, StartDateDto, SupportTypeDto, UpdateMemberDto, UpdateTeamDto, validPhone } from './dispatch.dto';
import { DispatchEvent, DispatchEventType, DispatchMember, ExistingMemberRecord, MemberAssignment, MemberContact, MemberNotice, MemberStartDateChange, MemberSupportLink, NO_MC, positionLabel, PromotionRequest, Team } from './dispatch.entity';
import { ApplicationActivity, Invitation } from '../onboarding/entities';
import { sharedSignIns } from './account-details';
import { lockCatchUpLinks, lockTeam, memberPlace, onNotice, paperworkTimeEnded, supportedDispatcher, supportedTeam } from './create-member';
import { addDays, usDay } from '../safety/screening-rules';
import { ItRemovalActivity, ItRemovalRequest, ItRemovalTask, removalScheduled } from '../it/it.entity';
import { DriverAssignment } from '../safety/safety.entity';
import { NotificationsService } from '../updates/notifications.service';
import { createRemoval, lockSetupRequest } from '../it/removal';
import { User as UserEntity, UserStatus } from '../users/user.entity';
import { companyEmailSql, lockAccount, syncSignIns, turnOffAccount } from './lead-sign-in';

const STALE = 'Someone else changed this record. Reload and try again.';
const NOTICE_MAX_DAYS = 90, LEAVING_LOCK = 42002036;
// A date picked in the form is stored at midday UTC, so it shows as the same calendar day in every US time zone.
// A change dated the same day as the period it ends starts at that period's start: a date picked in a form is midday UTC,
// while an approval or earlier change that same day may have a later time. Anything clearly earlier is refused.
export function notBefore(date: Date, previous: Date, message: string) {
 if (date.getTime() > previous.getTime()) return date;
 // One millisecond after: the database keeps microseconds that a JavaScript date would round down to before the start.
 if (previous.getTime() - date.getTime() <= 36 * 3600_000) return new Date(previous.getTime() + 1);
 throw new BadRequestException(message);
}
export function day(value: string) {
 const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
 if (Number.isNaN(date.getTime())) throw new BadRequestException('Choose a valid date.');
 if (date.getTime() > Date.now() + 36 * 3600_000) throw new BadRequestException('The date can’t be in the future.');
 return date;
}

/**
 * Teams and dispatch members (records only, no login). Dispatch managers and administrators see and manage all of
 * them. Where a member works is history: a move closes the open assignment and opens a new one, never overwriting.
 * A team lead must be an active dispatcher currently in that team; leaving or moving out of the team clears the lead.
 */
@Injectable()
export class DispatchService {
 private readonly logger = new Logger('Dispatch');
 constructor(private readonly db: DataSource, private readonly alerts: NotificationsService) {}

 async teams(status: 'ACTIVE' | 'ARCHIVED' | 'ALL' = 'ALL') {
  const items: Record<string, unknown>[] = await this.db.query(`SELECT t.id, t.name, t.version, t."archivedAt" IS NOT NULL AS archived,
    json_build_object('id', m.id, 'name', m.name) AS mc,
    CASE WHEN l.id IS NULL THEN NULL ELSE json_build_object('id', l.id, 'name', l."firstName" || ' ' || l."lastName") END AS lead,
    (SELECT count(*)::integer FROM member_assignments a JOIN dispatch_members d ON d.id = a."memberId" WHERE a."teamId" = t.id AND a."endedAt" IS NULL AND d.status = 'ACTIVE') AS members,
    (SELECT count(*)::integer FROM member_assignments a JOIN dispatch_members d ON d.id = a."memberId" WHERE a."teamId" = t.id AND a."endedAt" IS NULL AND d.status = 'ONBOARDING') AS onboarding,
    (SELECT count(*)::integer FROM member_support_links l JOIN dispatch_members d ON d.id = l."supportId" WHERE l."teamId" = t.id AND l."endedAt" IS NULL AND d.status <> 'LEFT') AS "wholeTeam",
    (SELECT count(*)::integer FROM member_support_links l JOIN dispatch_members d ON d.id = l."supportId" WHERE l."endedAt" IS NULL AND d.status <> 'LEFT' AND (l."teamId" = t.id
      OR l."dispatcherId" IN (SELECT a."memberId" FROM member_assignments a WHERE a."teamId" = t.id AND a."endedAt" IS NULL))) AS helpers
   FROM teams t JOIN mcs m ON m.id = t."mcId" LEFT JOIN dispatch_members l ON l.id = t."leadMemberId"
   WHERE ($1 = 'ALL' OR ($1 = 'ACTIVE') = (t."archivedAt" IS NULL)) ORDER BY m."nameKey", t."nameKey"`, [status]);
  const [counts] = await this.db.query(`SELECT count(*) FILTER (WHERE "archivedAt" IS NULL)::integer AS active, count(*) FILTER (WHERE "archivedAt" IS NOT NULL)::integer AS archived FROM teams`);
  return { items, counts };
 }

 /**
  * One team as it's built, for its page (designed as an org chart and approved 2026-11-05): its lead, its dispatchers
  * (in IT setup too) and everyone assisting them or the whole team, each with whether they have a profile photo (the
  * plain selfie from an approved application, as the dispatcher page shows it), how many drivers a dispatcher has and
  * the last day of anyone leaving. Names and work details only.
  */
 async team(id: string) {
  const person = `d.id, d."firstName", d."lastName", d.status, d.position, d."supportType", d.version,
   EXISTS(SELECT 1 FROM dispatcher_applications a JOIN applicant_photos p ON p."applicationId" = a.id AND p.kind = 'SELFIE' AND p."createdAt" <= a."submittedAt" WHERE a.id = d."applicationId" AND a.status = 'APPROVED') AS photo,
   (SELECT n."lastDay"::text FROM member_notices n WHERE n."memberId" = d.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL) AS "lastDay"`;
  // The three reads don't depend on each other, so they run at once.
  const [[team], dispatchers, helpers] = await Promise.all([
   this.db.query(`SELECT t.id, t.name, t.version, t."archivedAt" IS NOT NULL AS archived, t."leadMemberId" AS "leadId", json_build_object('id', m.id, 'name', m.name, 'archived', m."archivedAt" IS NOT NULL) AS mc
    FROM teams t JOIN mcs m ON m.id = t."mcId" WHERE t.id = $1`, [id]),
   this.db.query(`SELECT ${person}, jt.name AS "jobTitle",
     (SELECT count(*)::integer FROM driver_assignments x WHERE x."memberId" = d.id AND x."endedAt" IS NULL) AS drivers,
     ${companyEmailSql()} AS "companyEmail", (SELECT u.status FROM users u WHERE u.id = d."accountUserId") AS "accountStatus"
    FROM member_assignments a JOIN dispatch_members d ON d.id = a."memberId" LEFT JOIN job_titles jt ON jt.id = d."jobTitleId" LEFT JOIN existing_member_records e ON e."memberId" = d.id
    WHERE a."teamId" = $1 AND a."endedAt" IS NULL AND d.status <> 'LEFT' ORDER BY lower(d."firstName"), lower(d."lastName")`, [id]),
   // Whoever assists the whole team or one of its current dispatchers (the same people the query above returns).
   this.db.query(`SELECT ${person}, l."dispatcherId", l."teamId" FROM member_support_links l JOIN dispatch_members d ON d.id = l."supportId"
    WHERE l."endedAt" IS NULL AND d.status <> 'LEFT' AND (l."teamId" = $1 OR l."dispatcherId" IN (SELECT a."memberId" FROM member_assignments a JOIN dispatch_members x ON x.id = a."memberId"
     WHERE a."teamId" = $1 AND a."endedAt" IS NULL AND x.status <> 'LEFT')) ORDER BY lower(d."firstName"), lower(d."lastName")`, [id]),
  ]);
  if (!team) throw new NotFoundException('This team no longer exists.');
  return { ...team, dispatchers, helpers };
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
   const previousLead = team.leadMemberId;
   const fields: string[] = [];
   if (dto.name !== undefined && dto.name !== team.name) { team.name = dto.name; team.nameKey = listNameKey(dto.name); fields.push('name'); }
   if (dto.mcId !== undefined && dto.mcId !== team.mcId) {
    if (members.length) throw new ConflictException(members.some(row => row.position === 'DISPATCHER') ? 'Move this team’s dispatchers first; a team keeps its MC while it has dispatchers.' : 'Change who this team’s supports and updaters assist first; a team keeps its MC while they assist it.');
    await this.activeMc(em, dto.mcId); team.mcId = dto.mcId; fields.push('mcId');
   }
   if (dto.leadMemberId !== undefined && dto.leadMemberId !== team.leadMemberId) {
    const placed = candidate && await em.getRepository(MemberAssignment).existsBy({ memberId: candidate.id, teamId: id, endedAt: IsNull() });
    if (dto.leadMemberId && !(placed && candidate.position === 'DISPATCHER' && candidate.status === 'ACTIVE'))
     throw new BadRequestException('The team lead must be an active dispatcher in this team.');
    if (dto.leadMemberId && await onNotice(em, dto.leadMemberId)) throw new BadRequestException('This dispatcher is leaving, so they can’t become the team lead.');
    team.leadMemberId = dto.leadMemberId; fields.push('leadMemberId');
   }
   const archive = dto.archived === undefined || dto.archived === (team.archivedAt !== null) ? null : dto.archived;
   if (archive) {
    if (members.length) throw new ConflictException(members.some(row => row.position === 'DISPATCHER') ? 'A team can only be archived once it has no dispatchers.' : 'People assist this whole team. Change who they assist first.');
    team.archivedAt = new Date(); team.leadMemberId = null;
   } else if (archive === false) { await this.activeMc(em, team.mcId); team.archivedAt = null; }
   if (!fields.length && archive === null) return { id, version: team.version };
   team.version += 1;
   await em.getRepository(Team).save(team);
   if (fields.length) await this.event(em, user, 'TEAM_UPDATED', { teamId: id }, { fields });
   if (archive !== null) await this.event(em, user, archive ? 'TEAM_ARCHIVED' : 'TEAM_RESTORED', { teamId: id }, {});
   // A new lead needs a sign-in, and someone who stops leading but stays on is turned off; IT or an administrator does both.
   if (previousLead !== team.leadMemberId) await syncSignIns(em, [previousLead, team.leadMemberId], user.id);
   return { id, version: team.version };
  });
 }

 async members(status: 'ONBOARDING' | 'ACTIVE' | 'LEFT' | 'ALL' = 'ALL') {
  const items: Record<string, unknown>[] = await this.db.query(`SELECT d.id, d."firstName", d."lastName", d.position, d."supportType", d.status, d.version, d."joinedAt", d."leftAt",
    jt.name AS "jobTitle", e."memberId" IS NOT NULL AS "addedByHand", coalesce(sl."startedAt", a."startedAt") AS since, CASE WHEN st.id IS NOT NULL THEN sm.name WHEN a."mcId" IS NULL AND d.status <> 'LEFT' THEN '${NO_MC}' ELSE m.name END AS mc, a."mcId" IS NOT NULL OR st.id IS NOT NULL AS placed, coalesce(e."startDateKnown", true) AS "startDateKnown",
    coalesce(e."periodDateKnown", true) OR (SELECT count(*) FROM member_assignments p WHERE p."memberId" = d.id) + (SELECT count(*) FROM member_support_links p WHERE p."supportId" = d.id) > 1 AS "sinceKnown", coalesce(st.id, t.id) AS "teamId", coalesce(st.name, t.name) AS team, st.name AS "wholeTeam", (t."leadMemberId" = d.id) IS TRUE AS lead,
    sl."dispatcherId", CASE WHEN sd.id IS NULL THEN NULL ELSE sd."firstName" || ' ' || sd."lastName" END AS dispatcher,
    ${companyEmailSql()} AS "companyEmail",
    n."lastDay"::text AS "lastDay", n."lastDay" < $2::date AS "lastDayPassed",
    CASE WHEN n.id IS NULL THEN NULL ELSE (SELECT count(*)::integer FROM driver_assignments da WHERE da."memberId" = d.id AND da."endedAt" IS NULL) END AS "driversToReassign",
    CASE WHEN n.id IS NULL THEN NULL ELSE (SELECT count(*)::integer FROM member_support_links ml WHERE ml."dispatcherId" = d.id AND ml."endedAt" IS NULL) END AS "supportsToReassign",
    CASE WHEN n.id IS NULL OR rm.id IS NULL THEN NULL WHEN rm."completedAt" IS NOT NULL THEN 'COMPLETED' WHEN rm."removeNowAt" IS NULL AND rm."dueOn" > $3::date THEN 'SCHEDULED' ELSE 'IN_PROGRESS' END AS "itRemoval"
   FROM dispatch_members d LEFT JOIN job_titles jt ON jt.id = d."jobTitleId" LEFT JOIN existing_member_records e ON e."memberId" = d.id
   LEFT JOIN LATERAL (SELECT * FROM member_support_links l WHERE l."supportId" = d.id AND l."endedAt" IS NULL AND d.position = 'SUPPORT' LIMIT 1) sl ON true
   LEFT JOIN dispatch_members sd ON sd.id = sl."dispatcherId" LEFT JOIN teams st ON st.id = sl."teamId" LEFT JOIN mcs sm ON sm.id = st."mcId"
   LEFT JOIN LATERAL (SELECT * FROM member_assignments x WHERE x."memberId" = coalesce(sl."dispatcherId", d.id) ORDER BY x."startedAt" DESC, x."createdAt" DESC LIMIT 1) a ON true
   LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN teams t ON t.id = a."teamId"
   LEFT JOIN member_notices n ON n."memberId" = d.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL
   LEFT JOIN it_removal_requests rm ON rm."memberId" = d.id AND rm."cancelledAt" IS NULL
   WHERE ($1 = 'ALL' OR d.status = $1) ORDER BY lower(d."firstName"), lower(d."lastName") LIMIT 1000`, [status, usDay('earliest'), usDay('latest')]);
  const [counts] = await this.db.query(`SELECT count(*) FILTER (WHERE status = 'ONBOARDING')::integer AS onboarding, count(*) FILTER (WHERE status = 'ACTIVE')::integer AS active, count(*) FILTER (WHERE status = 'LEFT')::integer AS left FROM dispatch_members`);
  return { items, counts };
 }

 /**
  * Everything a manager needs about one dispatcher: where they work and their history, the approved application details
  * (the latest submitted revision), the company accounts and IT progress, signed documents, the profile photo and
  * contacts staff added, and the onboarding timeline (event names and times only). Every dispatch manager and
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
   application ? this.db.query(`SELECT r."companyEmail", r."assignedRingCentralPhoneNumber" AS "workPhone", r."ringCentralExtension", r."datEmail", r."truckstopEmail", r."completedAt", r."cancelledAt",
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
  const existing = await this.existingRecord(user, id);
  // On notice or after they left: IT's removal progress (never IT notes) and what happens to their company email.
  const [removalRow] = await this.db.query(`SELECT r.id, r."dueOn"::text AS "dueOn", r."completedAt", r."emailAfter", r."numberOutcome", r."removeNowAt", r."removeNowReason",
    CASE WHEN f.id IS NULL THEN NULL ELSE f."firstName" || ' ' || f."lastName" END AS "forwardTo",
    count(t.id) FILTER (WHERE t.status IN ('COMPLETED','NOT_NEEDED'))::integer AS done, count(t.id)::integer AS total,
    coalesce(json_agg(json_build_object('key', t.key, 'status', t.status)) FILTER (WHERE t.id IS NOT NULL), '[]') AS tasks
   FROM it_removal_requests r LEFT JOIN users f ON f.id = r."forwardTo" LEFT JOIN it_removal_tasks t ON t."requestId" = r.id WHERE r."memberId" = $1 AND r."cancelledAt" IS NULL GROUP BY r.id, f.id`, [id]);
  const removal = removalRow ? { ...removalRow, scheduled: removalScheduled(removalRow, usDay('latest')) } : null;
  // The notice, the drivers with them (who must be reassigned before they leave), and earlier notices that were cancelled or moved.
  const notices: (MemberNotice & { recorder: string | null; canceller: string | null })[] = await this.db.query(`SELECT n.id, n."lastDay"::text AS "lastDay", n.reason, n.changes, n."createdAt", n."cancelledAt", n."cancelReason", n."finishedAt",
    r."firstName" || ' ' || r."lastName" AS recorder, CASE WHEN c.id IS NULL THEN NULL ELSE c."firstName" || ' ' || c."lastName" END AS canceller
   FROM member_notices n JOIN users r ON r.id = n."recordedBy" LEFT JOIN users c ON c.id = n."cancelledBy" WHERE n."memberId" = $1 ORDER BY n."createdAt" DESC`, [id]);
  const openNotice = notices.find(row => !row.cancelledAt && !row.finishedAt);
  const notice = openNotice ? { id: openNotice.id, lastDay: openNotice.lastDay, reason: openNotice.reason, createdAt: openNotice.createdAt, recordedBy: openNotice.recorder, passed: openNotice.lastDay < usDay('earliest') } : null;
  const driversToReassign = member.status !== 'LEFT' ? await this.db.query(`SELECT d.id, d."firstName" || ' ' || d."lastName" AS name, a.truck FROM driver_assignments a JOIN drivers d ON d.id = a."driverId"
   WHERE a."memberId" = $1 AND a."endedAt" IS NULL ORDER BY lower(d."firstName")`, [id]) : [];
  // Who marked them as left; why is kept on the record.
  const [left] = member.status === 'LEFT' ? await this.db.query(`SELECT CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "by"
   FROM dispatch_events e LEFT JOIN users u ON u.id = e."actorId" WHERE e."memberId" = $1 AND e.event = 'MEMBER_LEFT' ORDER BY e."createdAt" DESC LIMIT 1`, [id]) : [];
  // A team lead whose sign-in is off while they're still here: staying longer or staying on doesn't turn it back on.
  const account = member.accountUserId && member.status !== 'LEFT' ? await this.db.getRepository(UserEntity).findOneBy({ id: member.accountUserId }) : null;
  // Their workspace sign-in as a team lead: waiting for IT (and for what), on or off. Managers see it; IT acts on it.
  const [signInRequest]: { kind: string }[] = member.status !== 'LEFT' ? await this.db.query(`SELECT kind FROM team_lead_sign_ins WHERE "memberId" = $1 AND "doneAt" IS NULL AND "cancelledAt" IS NULL`, [id]) : [];
  const signIn = signInRequest ? { status: 'WAITING', request: signInRequest.kind } : account ? { status: account.status === UserStatus.ACTIVE ? 'ACTIVE' : 'OFF', request: null } : null;
  const fields = (application?.fields ?? {}) as Record<string, string | undefined>;
  const current = history.find((row: { endedAt: Date | null }) => row.endedAt === null) ?? null;
  // Who a support has assisted over time (the open row is now, with that dispatcher's or team's MC and team); a dispatcher's supports now.
  const supportHistory = member.position === 'SUPPORT' ? await this.db.query(`SELECT l.id, l."startedAt", l."endedAt", l.reason, d.id AS "dispatcherId",
    CASE WHEN d.id IS NULL THEN NULL ELSE d."firstName" || ' ' || d."lastName" END AS dispatcher, d.status AS "dispatcherStatus", lt.id AS "wholeTeamId", lt.name AS "wholeTeam",
    CASE WHEN lt.id IS NOT NULL THEN lm.name WHEN a."mcId" IS NULL THEN '${NO_MC}' ELSE m.name END AS mc, coalesce(lt.name, t.name) AS team,
    CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "changedBy"
   FROM member_support_links l LEFT JOIN dispatch_members d ON d.id = l."dispatcherId" LEFT JOIN teams lt ON lt.id = l."teamId" LEFT JOIN mcs lm ON lm.id = lt."mcId" LEFT JOIN users u ON u.id = l."actorId"
   LEFT JOIN LATERAL (SELECT * FROM member_assignments a WHERE a."memberId" = d.id AND a."endedAt" IS NULL LIMIT 1) a ON true
   LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN teams t ON t.id = a."teamId"
   WHERE l."supportId" = $1 ORDER BY l."startedAt" DESC, l."createdAt" DESC`, [id]) : [];
  const supports = member.position === 'DISPATCHER' ? await this.db.query(`SELECT s.id, s."firstName" || ' ' || s."lastName" AS name, s."supportType", s.status, l."startedAt" AS since,
    coalesce(e."periodDateKnown", true) OR (SELECT count(*) FROM member_support_links p WHERE p."supportId" = s.id) > 1 AS "sinceKnown"
   FROM member_support_links l JOIN dispatch_members s ON s.id = l."supportId" LEFT JOIN existing_member_records e ON e."memberId" = s.id WHERE l."dispatcherId" = $1 AND l."endedAt" IS NULL ORDER BY lower(s."firstName")`, [id]) : [];
  // Who changed what they're called, and when. Support or updater is no one's private detail, so the event can say which.
  const supportTypeChanges = member.position === 'SUPPORT' ? await this.db.query(`SELECT e.id, e.metadata->>'to' AS "to", e."createdAt", CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS "changedBy"
   FROM dispatch_events e LEFT JOIN users u ON u.id = e."actorId" WHERE e."memberId" = $1 AND e.event = 'SUPPORT_TYPE_CHANGED' ORDER BY e."createdAt" DESC`, [id]) : [];
  // Anyone else using their load board sign-ins, so nobody closes the wrong account.
  const signIns = { dat: it[0]?.datEmail ?? existing?.datEmail ?? null, truckstop: it[0]?.truckstopEmail ?? existing?.truckstopEmail ?? null };
  return { sharedSignIns: await sharedSignIns(this.db, id, signIns), id: member.id, firstName: member.firstName, lastName: member.lastName, position: member.position, supportType: member.supportType, supportTypeChanges, status: member.status, version: member.version,
   joinedAt: member.joinedAt, leftAt: member.leftAt, applicationId: member.applicationId, jobTitle: jobTitle ? { id: jobTitle.id, name: jobTitle.name } : null,
   current, history, leadOf: leadOf ? { id: leadOf.id, name: leadOf.name } : null, accounts: it[0] ?? null,
   // The onboarding record itself stays with its responsible manager and administrators.
   canOpenApplication, activity, supportHistory, supportOf: supportHistory.find((row: { endedAt: Date | null }) => row.endedAt === null) ?? null, supports,
   details: application ? { legalFirstName: fields.firstName ?? null, legalLastName: fields.lastName ?? null, preferredAmericanFirstName: fields.preferredAmericanFirstName ?? null,
    preferredAmericanLastName: fields.preferredAmericanLastName ?? null, personalEmail: application.email, personalPhoneNumber: fields.personalPhoneNumber ?? null,
    telegram: fields.telegram ?? null, mcName: fields.mcName ?? null, teamLead: fields.teamLead ?? null, jobTitle: fields.jobTitle ?? null, submittedAt: application.submittedAt } : null,
   existing, documents, photo: !!photo[0]?.present, idPhoto: canOpenApplication && !!photo[0]?.idPresent, contacts, removal, leftReason: member.leftReason, leftBy: left?.by ?? null, notice, driversToReassign, signInOff: account?.status === UserStatus.INACTIVE, signIn,
   noticeHistory: notices.filter(row => row.cancelledAt || row.changes.length).map(row => ({ id: row.id, lastDay: row.lastDay, reason: row.reason, recordedBy: row.recorder, createdAt: row.createdAt, cancelledAt: row.cancelledAt, cancelledBy: row.canceller, cancelReason: row.cancelReason, changes: row.changes.map(({ from, to, reason, at }) => ({ from, to, reason, at })) })) };
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
   if (member.position === 'SUPPORT') throw new BadRequestException('Supports and updaters work where their dispatcher works. Change their dispatcher instead.');
   let startedAt = day(dto.startedAt);
   const current = await em.getRepository(MemberAssignment).findOneBy({ memberId: id, endedAt: IsNull() });
   await this.activeMc(em, dto.mcId);
   const teamId = dto.teamId ?? null;
   // Teams are locked after the member and in id order (the one they join, the one they lead and may leave), so two
   // moves can't deadlock. Which team this member leads can't change meanwhile: setting a lead locks the member first.
   const led = await em.getRepository(Team).findOneBy({ leadMemberId: id });
   for (const lockId of [...new Set([teamId, led?.id].filter((value): value is string => !!value))].sort()) {
    const team = lockId === teamId ? await lockTeam(em, lockId) : await em.getRepository(Team).findOne({ where: { id: lockId }, lock: { mode: 'pessimistic_write' } });
    if (lockId === teamId && (!team || team.archivedAt || team.mcId !== dto.mcId)) throw new BadRequestException('Choose an active team of the selected MC.');
   }
   if (current && current.mcId === dto.mcId && current.teamId === teamId) throw new BadRequestException('The dispatcher already works for this MC and team.');
   // Their drivers work for the MC they work for; a manager moves the drivers first.
   if (current?.mcId !== dto.mcId && await em.getRepository(DriverAssignment).existsBy({ memberId: id, endedAt: IsNull() }))
    throw new ConflictException('This dispatcher still has drivers under this MC. Reassign their drivers first.');
   if (current) startedAt = notBefore(startedAt, current.startedAt, 'The move can’t start before the current MC and team did.');
   // Someone approved with no MC yet gets their first MC and team here: not before they joined.
   else startedAt = notBefore(startedAt, member.joinedAt, 'The move can’t start before they joined.');
   if (current) { current.endedAt = startedAt; await em.save(current); }
   await em.getRepository(MemberAssignment).save({ memberId: id, mcId: dto.mcId, teamId, startedAt, reason: dto.reason, actorId: user.id });
   const leadCleared = await this.clearLead(em, id, teamId);
   if (leadCleared) await syncSignIns(em, [id], user.id);
   member.version += 1; await em.save(member);
   await this.event(em, user, 'MEMBER_MOVED', { memberId: id }, { fields: ['mcId', 'teamId'], leadCleared });
   return { id, version: member.version };
  });
 }

 /** Support or updater: only the name changes, so their dispatcher, MC and team stay as they are. */
 async setSupportType(user: User, id: string, dto: SupportTypeDto) {
  return this.write(async em => {
   const member = await this.lockMember(em, id, dto.version);
   if (member.position !== 'SUPPORT') throw new BadRequestException('Only a support or an updater can change between the two.');
   if (member.supportType === dto.supportType) return { id, version: member.version };
   member.supportType = dto.supportType; member.version += 1; await em.save(member);
   await this.event(em, user, 'SUPPORT_TYPE_CHANGED', { memberId: id }, { fields: ['supportType'], to: dto.supportType });
   return { id, version: member.version };
  });
 }

 /**
  * The first MC and team of someone added with none. Nothing is being moved, so there's no reason to give and no period to end.
  * Without a date of its own the period follows their start date: that date when it's known, otherwise marked as not recorded.
  */
 async placeMember(user: User, id: string, dto: PlaceMemberDto) {
  return this.write(async em => {
   const member = await this.lockMember(em, id, dto.version);
   if (member.position === 'SUPPORT') throw new BadRequestException('Supports and updaters work where their dispatcher works. Change their dispatcher instead.');
   const record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId: id });
   if (!record) throw new BadRequestException('Only someone added by hand can start with no MC.');
   if (await em.getRepository(MemberAssignment).existsBy({ memberId: id })) throw new ConflictException('This dispatcher already has an MC. Move them instead.');
   await this.activeMc(em, dto.mcId);
   const teamId = dto.teamId ?? null;
   if (teamId) {
    const team = await lockTeam(em, teamId);
    if (!team || team.archivedAt || team.mcId !== dto.mcId) throw new BadRequestException('Choose an active team of the selected MC.');
   }
   const startedAt = dto.startedAt ? day(dto.startedAt) : member.joinedAt;
   if (dto.startedAt && record.startDateKnown && startedAt.getTime() < member.joinedAt.getTime() - 36 * 3600_000) throw new BadRequestException('This can’t be before their start date.');
   await em.getRepository(MemberAssignment).save({ memberId: id, mcId: dto.mcId, teamId, startedAt, reason: 'MC and team set after they were added.', actorId: user.id });
   record.periodDateKnown = !!dto.startedAt || record.startDateKnown;
   await em.save(record);
   member.version += 1; await em.save(member);
   await this.event(em, user, 'MEMBER_PLACED', { memberId: id }, { fields: ['mcId', 'teamId'], dated: !!dto.startedAt });
   return { id, version: member.version };
  });
 }

 /**
  * Adds or corrects the start date of someone added by hand. A correction needs a reason. Their first period moves with it when it
  * has no date of its own or began on their start date; it must still begin before that period ended, so a move stays as it is.
  */
 async setStartDate(user: User, id: string, dto: StartDateDto) {
  const startedAt = day(dto.startedOn);
  if (startedAt.toISOString().slice(0, 10) !== dto.startedOn) throw new BadRequestException('Choose a valid date.');
  if (dto.startedOn > usDay('latest')) throw new BadRequestException('The start date can’t be in the future.');
  if (dto.startedOn < '1980-01-01') throw new BadRequestException('This start date is too long ago.');
  return this.write(async em => {
   const member = await this.lockMember(em, id, dto.version);
   const record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId: id });
   if (!record) throw new BadRequestException('Only someone added by hand has a start date to change.');
   const previousOn = record.startDateKnown ? member.joinedAt.toISOString().slice(0, 10) : null, corrected = previousOn !== null;
   if (previousOn === dto.startedOn) return { id, version: member.version };
   if (corrected && !dto.reason) throw new BadRequestException('Say why the start date changed.');
   // Their first period of either kind: someone promoted began as a support, whatever they are now.
   const link = await em.getRepository(MemberSupportLink).findOne({ where: { supportId: id }, order: { startedAt: 'ASC', createdAt: 'ASC' }, lock: { mode: 'pessimistic_write' } });
   const placed = await em.getRepository(MemberAssignment).findOne({ where: { memberId: id }, order: { startedAt: 'ASC', createdAt: 'ASC' }, lock: { mode: 'pessimistic_write' } });
   const first = link && placed ? (link.startedAt <= placed.startedAt ? link : placed) : link ?? placed;
   let periodMoved = false;
   if (first) {
    const follows = !record.periodDateKnown || (record.startDateKnown && first.startedAt.toISOString().slice(0, 10) === previousOn);
    if (first.endedAt && startedAt >= first.endedAt) throw new BadRequestException(`This must be before ${first.endedAt.toISOString().slice(0, 10)}, when their first period ended.`);
    if (follows) { first.startedAt = startedAt; await em.save(first); record.periodDateKnown = true; periodMoved = true; }
    else if (startedAt > first.startedAt) throw new BadRequestException(`This can’t be after ${first.startedAt.toISOString().slice(0, 10)}, when their first period began.`);
   }
   record.startDateKnown = true; await em.save(record);
   member.joinedAt = startedAt; member.version += 1; await em.save(member);
   await em.getRepository(MemberStartDateChange).save({ memberId: id, startedOn: dto.startedOn, previousOn, reason: corrected ? dto.reason! : null, actorId: user.id });
   await this.event(em, user, 'START_DATE_RECORDED', { memberId: id }, { fields: ['startDate'], corrected, periodMoved });
   return { id, version: member.version };
  });
 }

 /**
  * Records a dispatcher's last day. Today or earlier: they leave now (drivers and supports reassigned first). A future day
  * is a notice period: they stay as they are, may be reassigned meanwhile, and the last-day job marks them as left. Someone
  * who had IT setup gets an IT removal checklist (and IT a Telegram alert) in the same transaction. The setup request is
  * locked before the member, the order IT completion uses.
  */
 async leave(user: User, id: string, dto: LeaveMemberDto) {
  let alerts: string[] = [];
  const result = await this.write(async em => {
   const setup = await lockSetupRequest(em, id);
   await lockCatchUpLinks(em, id);
   const member = await this.lockMember(em, id, dto.version);
   if (await onNotice(em, id)) throw new ConflictException('This dispatcher is already leaving. Change their last day instead.');
   const today = usDay('latest'), lastDay = dto.leftAt.slice(0, 10), name = `${member.firstName} ${member.lastName}`;
   const place = await memberPlace(em, id);
   // A dispatcher added by hand always gets a removal; a support only when accounts were recorded for them. Someone added by hand
   // and promoted has IT setup too: what IT recorded comes first, and what a manager recorded before that still reaches IT.
   const record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId: id });
   const accounts = record && (setup || member.position === 'DISPATCHER' || record.companyEmail || record.ringCentralNumber || record.datEmail || record.truckstopEmail) ? { companyEmail: record.companyEmail, ringCentralNumber: record.ringCentralNumber, ringCentralExtension: record.ringCentralExtension, datEmail: record.datEmail, truckstopEmail: record.truckstopEmail } : undefined, removes = !!setup || !!accounts;
   if (lastDay > today) {
    if (lastDay > addDays(today, NOTICE_MAX_DAYS)) throw new BadRequestException(`The last day can be up to ${NOTICE_MAX_DAYS} days ahead.`);
    if (setup && !setup.completedAt) throw new BadRequestException('This dispatcher is still in IT setup, so their last day can’t be in the future. Choose today to cancel the setup.');
    await em.getRepository(MemberNotice).save({ memberId: id, lastDay, reason: dto.reason, recordedBy: user.id, changes: [] });
    member.version += 1; await em.save(member);
    if (removes) alerts = await createRemoval(em, this.alerts, { setup, accounts, position: positionLabel(member), memberId: id, name, dueOn: lastDay, scheduled: true, emailAfter: dto.emailAfter ?? 'SUSPEND', actorId: user.id, ...place });
    await this.event(em, user, 'NOTICE_RECORDED', { memberId: id }, { itRemoval: removes });
    await syncSignIns(em, [id], user.id);
    return { id, version: member.version };
   }
   await this.requireNobodyAssigned(em, member);
   const leftAt = day(dto.leftAt);
   if (removes) alerts = await createRemoval(em, this.alerts, { setup, accounts, position: positionLabel(member), memberId: id, name, dueOn: leftAt.toISOString().slice(0, 10), scheduled: false, emailAfter: dto.emailAfter ?? 'SUSPEND', actorId: user.id, ...place });
   await this.finishLeaving(em, user, member, leftAt, dto.reason, removes);
   return { id, version: member.version };
  });
  this.alerts.dispatch(alerts);
  return result;
 }
 /** Where they work now, for what IT sees on the removal. */
 private async stillAssigned(em: EntityManager, member: DispatchMember) {
  return { supports: member.position === 'DISPATCHER' && await em.getRepository(MemberSupportLink).existsBy({ dispatcherId: member.id, endedAt: IsNull() }),
   drivers: await em.getRepository(DriverAssignment).existsBy({ memberId: member.id, endedAt: IsNull() }) };
 }
 private async requireNobodyAssigned(em: EntityManager, member: DispatchMember) {
  const { supports, drivers } = await this.stillAssigned(em, member);
  // Their supports would be left assisting no one; a manager moves them to another dispatcher first.
  if (supports) throw new ConflictException('This dispatcher still has supports or updaters. Reassign them to another dispatcher first.');
  if (drivers) throw new ConflictException('This dispatcher still has drivers. Reassign their drivers to another dispatcher first.');
 }
 /** Ends their place in the team and marks the record as left: the same for leaving now and at the end of a notice. */
 private async finishLeaving(em: EntityManager, actor: Pick<User, 'id'>, member: DispatchMember, date: Date, reason: string, itRemoval: boolean) {
  const id = member.id;
  let leftAt = date;
  const current = await em.getRepository(MemberAssignment).findOneBy({ memberId: id, endedAt: IsNull() });
  if (current) leftAt = notBefore(leftAt, current.startedAt, 'The leaving date can’t be before the current MC and team started.');
  if (current) { current.endedAt = leftAt; await em.save(current); }
  // A support leaving stops assisting their dispatcher or team on the same day.
  const link = await em.getRepository(MemberSupportLink).findOneBy({ supportId: id, endedAt: IsNull() });
  if (link) leftAt = notBefore(leftAt, link.startedAt, 'The leaving date can’t be before they started with their dispatcher.');
  if (link) { link.endedAt = leftAt; await em.save(link); }
  const leadCleared = await this.clearLead(em, id, null);
  // A support's open promotion request ends with them (locked after the member, as decide does).
  const pending = member.position === 'SUPPORT' ? await em.getRepository(PromotionRequest).findOne({ where: { supportId: id, status: 'PENDING' }, lock: { mode: 'pessimistic_write' } }) : null;
  if (pending) {
   Object.assign(pending, { status: 'CANCELLED', decidedBy: actor.id, decidedAt: new Date(), version: pending.version + 1 });
   await em.save(pending);
   await this.event(em, actor, 'PROMOTION_CANCELLED', { memberId: id }, { requestId: pending.id, memberLeft: true });
  }
  member.status = 'LEFT'; member.leftAt = leftAt; member.leftReason = reason; member.version += 1; await em.save(member);
  const signInOff = await this.endTeamLeadAccount(em, actor, member);
  // Their paperwork closes, started or not: the applicant session and any decision on it check the revoked link. Accepted paperwork stays as it is.
  const links: { id: string }[] = await em.query(`SELECT i.id FROM invitations i JOIN dispatcher_applications a ON a."invitationId" = i.id WHERE i."catchUpMemberId" = $1 AND i."revokedAt" IS NULL AND a.status <> 'APPROVED'`, [id]);
  for (const link of links) {
   await em.update(Invitation, { id: link.id }, { revokedAt: new Date() });
   await em.getRepository(ApplicationActivity).save({ invitationId: link.id, event: 'INVITATION_REVOKED', actorId: actor.id });
  }
  await this.event(em, actor, 'MEMBER_LEFT', { memberId: id }, { leadCleared, reasonGiven: true, itRemoval, signInOff });
  // Leaving turns the account off with them, so a request still waiting for IT is cancelled.
  await syncSignIns(em, [id], actor.id);
 }
 private async openNotice(em: EntityManager, id: string) {
  const notice = await em.getRepository(MemberNotice).findOne({ where: { memberId: id, cancelledAt: IsNull(), finishedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
  if (!notice) throw new ConflictException('This dispatcher isn’t on notice any more. Reload the page.');
  return notice;
 }
 private openRemoval(em: EntityManager, id: string) {
  return em.getRepository(ItRemovalRequest).findOne({ where: { memberId: id, cancelledAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
 }
 /** The notice is extended or shortened: IT's checklist moves with it, unless access is already being removed. */
 async changeLastDay(user: User, id: string, dto: ChangeLastDayDto) {
  return this.write(async em => {
   const member = await this.lockMember(em, id, dto.version);
   const notice = await this.openNotice(em, id);
   const today = usDay('latest'), lastDay = dto.lastDay.slice(0, 10);
   if (lastDay < today) throw new BadRequestException('The new last day can’t be in the past.');
   if (lastDay > addDays(today, NOTICE_MAX_DAYS)) throw new BadRequestException(`The last day can be up to ${NOTICE_MAX_DAYS} days ahead.`);
   if (lastDay === notice.lastDay) throw new BadRequestException('That is already their last day.');
   notice.changes = [...notice.changes, { from: notice.lastDay, to: lastDay, reason: dto.reason, by: user.id, at: new Date().toISOString() }];
   notice.lastDay = lastDay; await em.save(notice);
   member.version += 1; await em.save(member);
   const removal = await this.openRemoval(em, id);
   if (removal && !removal.completedAt && !removal.removeNowAt) {
    removal.dueOn = lastDay; removal.dueAlertedAt = null; removal.version += 1; await em.save(removal);
    await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId: user.id, event: 'LAST_DAY_CHANGED', metadata: {} });
   }
   await this.event(em, user, 'NOTICE_CHANGED', { memberId: id }, {});
   return { id, version: member.version };
  });
 }
 /** They're staying after all: only while IT hasn't started and the last day hasn't passed. The history keeps the notice. */
 async cancelNotice(user: User, id: string, dto: NoticeActionDto) {
  return this.write(async em => {
   const member = await this.lockMember(em, id, dto.version);
   const notice = await this.openNotice(em, id);
   if (notice.lastDay < usDay('earliest')) throw new ConflictException('Their last day has passed, so this notice can’t be cancelled. Talk to IT.');
   const removal = await this.openRemoval(em, id);
   if (removal) {
    const started = removal.removeNowAt || removal.completedAt || (await em.getRepository(ItRemovalTask).findBy({ requestId: removal.id })).some(task => task.status !== 'PENDING' || task.notes.trim());
    if (started) throw new ConflictException('IT has started removing their access, so this notice can’t be cancelled. Talk to IT.');
    removal.cancelledAt = new Date(); removal.version += 1; await em.save(removal);
    await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId: user.id, event: 'REMOVAL_CANCELLED', metadata: {} });
   }
   Object.assign(notice, { cancelledAt: new Date(), cancelledBy: user.id, cancelReason: dto.reason }); await em.save(notice);
   member.version += 1; await em.save(member);
   await this.event(em, user, 'NOTICE_CANCELLED', { memberId: id }, { itRemoval: !!removal });
   // Staying on as a lead whose sign-in was turned off asks IT to turn it back on; nothing turns it on by itself.
   await syncSignIns(em, [id], user.id);
   return { id, version: member.version };
  });
 }
 /** Someone who shouldn't keep their accounts until the last day: due today, IT alerted now, a team lead's sign-in off now. */
 async removeAccessNow(user: User, id: string, dto: NoticeActionDto) {
  let alerts: string[] = [];
  const result = await this.write(async em => {
   const member = await this.lockMember(em, id, dto.version);
   await this.openNotice(em, id);
   const removal = await this.openRemoval(em, id);
   const signInOff = await this.endTeamLeadAccount(em, user, member);
   if (!removal && !signInOff) throw new BadRequestException('This person has no company accounts to remove.');
   if (removal?.removeNowAt) throw new ConflictException('IT has already been asked to remove their access now.');
   if (removal && !removal.completedAt) {
    Object.assign(removal, { removeNowAt: new Date(), removeNowReason: dto.reason, dueOn: usDay('latest'), dueAlertedAt: new Date(), version: removal.version + 1 }); await em.save(removal);
    await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId: user.id, event: 'ACCESS_REMOVAL_REQUESTED', metadata: {} });
    alerts = await this.alerts.queueItRemoval(em, removal, 'IT_REMOVAL_NOW');
   }
   member.version += 1; await em.save(member);
   await this.event(em, user, 'ACCESS_REMOVAL_REQUESTED', { memberId: id }, { signInOff });
   await syncSignIns(em, [id], user.id);
   return { id, version: member.version };
  });
  this.alerts.dispatch(alerts);
  return result;
 }
 /**
  * The last-day job: IT's alert when a scheduled removal falls due (from the Eastern date), then, once the Pacific date has
  * passed the last day, a team lead's sign-in ends and anyone with nobody left assigned is marked as left, dated their last
  * day. Removal never waits for reassignment. One instance at a time; each person is their own transaction.
  */
 async sweepLeaving() {
  const counts = { alerted: 0, left: 0, failed: 0 };
  const runner = this.db.createQueryRunner();
  try {
   await runner.connect();
   const [{ locked }] = await runner.query('SELECT pg_try_advisory_lock($1) AS locked', [LEAVING_LOCK]);
   if (!locked) return counts;
   try {
    const due: { id: string }[] = await this.db.query(`SELECT id FROM it_removal_requests WHERE "completedAt" IS NULL AND "cancelledAt" IS NULL AND "dueAlertedAt" IS NULL AND "dueOn" <= $1::date`, [usDay('latest')]);
    for (const { id } of due) {
     try {
      const ids = await this.db.transaction(async em => {
       const removal = await em.getRepository(ItRemovalRequest).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
       if (!removal || removal.completedAt || removal.cancelledAt || removal.dueAlertedAt) return [];
       removal.dueAlertedAt = new Date(); await em.save(removal);
       return this.alerts.queueItRemoval(em, removal, 'IT_REMOVAL_DUE');
      });
      this.alerts.dispatch(ids); counts.alerted += 1;
     } catch { counts.failed += 1; }
    }
    const ended: { memberId: string }[] = await this.db.query(`SELECT "memberId" FROM member_notices WHERE "cancelledAt" IS NULL AND "finishedAt" IS NULL AND "lastDay" < $1::date`, [usDay('earliest')]);
    for (const { memberId } of ended) {
     try { if (await this.write(em => this.endNotice(em, memberId))) counts.left += 1; } catch { counts.failed += 1; }
    }
   } finally { await runner.query('SELECT pg_advisory_unlock($1)', [LEAVING_LOCK]); }
  } finally { await runner.release(); }
  if (counts.failed) this.logger.warn(`Last-day job: ${counts.failed} failed`);
  return counts;
 }
 private async endNotice(em: EntityManager, memberId: string) {
  await lockSetupRequest(em, memberId);
  await lockCatchUpLinks(em, memberId);
  const member = await em.getRepository(DispatchMember).findOne({ where: { id: memberId }, lock: { mode: 'pessimistic_write' } });
  const notice = await em.getRepository(MemberNotice).findOne({ where: { memberId, cancelledAt: IsNull(), finishedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
  if (!member || !notice || member.status === 'LEFT' || notice.lastDay >= usDay('earliest')) return false;
  const actor = { id: notice.recordedBy };
  const { supports, drivers } = await this.stillAssigned(em, member);
  if (supports || drivers) { await this.endTeamLeadAccount(em, actor, member); await syncSignIns(em, [member.id], actor.id); return false; }
  notice.finishedAt = new Date(); await em.save(notice);
  // Dated their last day, or just after a later change to where they work.
  const placed = await em.getRepository(MemberAssignment).findOneBy({ memberId, endedAt: IsNull() });
  const link = await em.getRepository(MemberSupportLink).findOneBy({ supportId: memberId, endedAt: IsNull() });
  const earliest = Math.max(placed?.startedAt.getTime() ?? 0, link?.startedAt.getTime() ?? 0) + 1;
  const leftAt = new Date(Math.max(Date.parse(`${notice.lastDay}T12:00:00Z`), earliest));
  const removal = await em.getRepository(ItRemovalRequest).existsBy({ memberId, cancelledAt: IsNull() });
  await this.finishLeaving(em, actor, member, leftAt, notice.reason, removal);
  return true;
 }
 /** A team lead who leaves can't sign in any more: the account is made inactive and every session ends (metadata-only event). */
 private async endTeamLeadAccount(em: EntityManager, user: Pick<User, 'id'>, member: DispatchMember) {
  if (!member.accountUserId) return false;
  const account = await lockAccount(em, member.accountUserId);
  if (!account || account.status !== UserStatus.ACTIVE) return false;
  await turnOffAccount(em, account, user.id, 'member-left');
  return true;
 }

 /** A support starts assisting another dispatcher or a whole team: the current link ends on the start date and stays in the history. */
 async reassignSupport(user: User, id: string, dto: ReassignSupportDto) {
  if (!!dto.dispatcherId === !!dto.teamId) throw new BadRequestException('Choose a dispatcher or a team.');
  return this.write(async em => {
   const member = await this.lockMember(em, id, dto.version);
   if (member.position !== 'SUPPORT') throw new BadRequestException('Only a support or an updater has someone to assist.');
   let startedAt = day(dto.startedAt);
   if (dto.dispatcherId) await supportedDispatcher(em, dto.dispatcherId); else await supportedTeam(em, dto.teamId!);
   const current = await em.getRepository(MemberSupportLink).findOneBy({ supportId: id, endedAt: IsNull() });
   if (dto.dispatcherId && current?.dispatcherId === dto.dispatcherId) throw new BadRequestException('They already assist this dispatcher.');
   if (dto.teamId && current?.teamId === dto.teamId) throw new BadRequestException('They already assist this team.');
   if (current) startedAt = notBefore(startedAt, current.startedAt, 'The change can’t start before their current one did.');
   if (current) { current.endedAt = startedAt; await em.save(current); }
   await em.getRepository(MemberSupportLink).save({ supportId: id, dispatcherId: dto.dispatcherId ?? null, teamId: dto.teamId ?? null, startedAt, reason: dto.reason, actorId: user.id });
   member.version += 1; await em.save(member);
   await this.event(em, user, 'SUPPORT_REASSIGNED', { memberId: id }, { fields: [dto.teamId ? 'teamId' : 'dispatcherId'], assists: dto.teamId ? 'TEAM' : 'DISPATCHER' });
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

 /** Someone recorded by hand: what a manager recorded, the paper copies, and how far their paperwork has come. */
 private async existingRecord(user: User, id: string) {
  const [record] = await this.db.query(`SELECT r."sourceName", r."companyEmail", r."ringCentralNumber", r."ringCentralExtension", r."datEmail", r."truckstopEmail", r.telegram, r."personalEmail", r."personalPhone", r."createdAt", r."acceptedAt", r."startDateKnown", r."periodDateKnown", u."firstName" || ' ' || u."lastName" AS "addedBy"
   FROM existing_member_records r JOIN users u ON u.id = r."addedBy" WHERE r."memberId" = $1`, [id]);
  if (!record) return null;
  const paper = await this.db.query(`SELECT p.kind, p."signedOn"::text AS "signedOn", p."createdAt", u."firstName" || ' ' || u."lastName" AS "recordedBy" FROM member_paper_documents p JOIN users u ON u.id = p."recordedBy" WHERE p."memberId" = $1 ORDER BY p.kind`, [id]);
  const [link] = await this.db.query(`SELECT i.id, i.email, i."expiresAt", i."openedAt", i."consumedAt", a.id AS "applicationId", a.status, a."assignedManagerId", a."applicantAccessUntil",
    coalesce((SELECT json_agg(json_build_object('kind', c.kind, 'signedAt', s."signedAt")) FROM document_signatures s JOIN company_documents c ON c.id = s."documentId" WHERE s."applicationId" = a.id AND s."signerRole" = 'APPLICANT'), '[]') AS signed
   FROM invitations i JOIN dispatcher_applications a ON a."invitationId" = i.id WHERE i."catchUpMemberId" = $1 AND i."revokedAt" IS NULL ORDER BY i."createdAt" DESC LIMIT 1`, [id]);
  const started = !!link?.consumedAt, mine = !!link && (user.role === Role.SYSTEM_ADMIN || link.assignedManagerId === user.id);
  const published: { kind: string }[] = await this.db.query(`SELECT DISTINCT kind FROM company_documents`);
  // The one period with no date of its own, of either kind, so it never shows the day they were added.
  const undated: { id: string }[] = record.periodDateKnown ? [] : await this.db.query(`SELECT id FROM (SELECT id, "startedAt", "createdAt" FROM member_support_links WHERE "supportId" = $1
    UNION ALL SELECT id, "startedAt", "createdAt" FROM member_assignments WHERE "memberId" = $1) p ORDER BY "startedAt", "createdAt" LIMIT 1`, [id]);
  const startDateChanges = await this.db.query(`SELECT c.id, c."startedOn"::text AS "startedOn", c."previousOn"::text AS "previousOn", c.reason, c."createdAt", u."firstName" || ' ' || u."lastName" AS "changedBy"
   FROM member_start_date_changes c JOIN users u ON u.id = c."actorId" WHERE c."memberId" = $1 ORDER BY c."createdAt" DESC`, [id]);
  return { ...record, paper, startDateChanges, undatedPeriodId: undated[0]?.id ?? null, published: published.map(row => row.kind), catchUp: link ? { expiresAt: link.expiresAt, opened: !!link.openedAt, started, status: link.status, signed: link.signed,
   // The reference lets someone return with a fresh code, and only their manager needs it.
   applicationId: started && mine ? link.applicationId : null, reference: started && mine ? link.applicationId : null, canReview: mine,
   timeEndedAt: paperworkTimeEnded(link) ? link.applicantAccessUntil : null, returnEmail: started && mine ? link.email : null } : null };
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
 // Everyone in the team now, including dispatchers still in IT setup and anyone assisting the whole team (a team with them keeps its MC and stays open).
 private async teamMembers(em: EntityManager, teamId: string): Promise<{ id: string; position: string; status: string }[]> {
  return em.query(`SELECT d.id, d.position, d.status FROM member_assignments a JOIN dispatch_members d ON d.id = a."memberId" WHERE a."teamId" = $1 AND a."endedAt" IS NULL AND d.status <> 'LEFT'
   UNION ALL SELECT d.id, d.position, d.status FROM member_support_links l JOIN dispatch_members d ON d.id = l."supportId" WHERE l."teamId" = $1 AND l."endedAt" IS NULL AND d.status <> 'LEFT'`, [teamId]);
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
 private event(em: EntityManager, user: Pick<User, 'id'>, event: DispatchEventType, target: { memberId?: string; teamId?: string }, metadata: Record<string, unknown>) {
  return em.getRepository(DispatchEvent).save({ memberId: target.memberId ?? null, teamId: target.teamId ?? null, event, actorId: user.id, metadata });
 }
}
