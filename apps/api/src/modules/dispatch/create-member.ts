import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import type { ApplicationFields, DispatcherApplication } from '../onboarding/entities';
import { EmploymentAssignments } from '../onboarding/entities';
import { JobTitle, listNameKey, Mc } from '../lists/lists.entity';
import { DispatchMember, MemberAssignment, MemberSupportLink, NO_MC, Team, SupportType } from './dispatch.entity';

/** Where someone works now, for IT's removal. A support or updater works where their dispatcher or team works; a dispatcher with no period has no MC yet, which IT mustn't read as Independent. */
export async function memberPlace(em: EntityManager, id: string): Promise<{ mcName: string | null; teamName: string | null }> {
 const current = await em.getRepository(MemberAssignment).findOneBy({ memberId: id, endedAt: IsNull() });
 if (current?.mcId) {
  const [row] = await em.query(`SELECT m.name AS mc, t.name AS team FROM mcs m LEFT JOIN teams t ON t.id = $2 WHERE m.id = $1`, [current.mcId, current.teamId]);
  return { mcName: row?.mc ?? null, teamName: row?.team ?? null };
 }
 // A period with no MC predates Independent becoming a team choice; nobody was recorded that way, but it reads as no MC yet.
 if (current) return { mcName: NO_MC, teamName: null };
 const link = await em.getRepository(MemberSupportLink).findOneBy({ supportId: id, endedAt: IsNull() });
 if (link?.teamId) {
  const [team] = await em.query(`SELECT m.name AS mc, t.name AS team FROM teams t JOIN mcs m ON m.id = t."mcId" WHERE t.id = $1`, [link.teamId]);
  return { mcName: team?.mc ?? null, teamName: team?.team ?? null };
 }
 if (link?.dispatcherId) return memberPlace(em, link.dispatcherId);
 const member = await em.getRepository(DispatchMember).findOneBy({ id });
 return { mcName: member?.position === 'DISPATCHER' ? NO_MC : null, teamName: null };
}

/**
 * Called only inside the approval transaction: the approved dispatcher becomes a member record (no login), ONBOARDING
 * until IT completes setup (see activateMember), placed by
 * matching the confirmed MC, team lead and job title text to the managed lists. An MC that doesn't match an active one
 * leaves them with no MC yet (no period) for a manager to set; a team lead text of "Independent", or one that matches no
 * team of that MC, places them under the MC with no team (Independent). The unique applicationId keeps it to one member
 * per application.
 */
export async function createMemberForApproval(em: EntityManager, application: DispatcherApplication, fields: ApplicationFields, employment: EmploymentAssignments, approvedAt: Date) {
 const first = fields.preferredAmericanFirstName?.trim() || fields.firstName?.trim() || 'Dispatcher';
 const last = fields.preferredAmericanLastName?.trim() || fields.lastName?.trim() || '';
 const [mc, jobTitle] = await Promise.all([
  em.getRepository(Mc).findOneBy({ nameKey: listNameKey(employment.mcName), archivedAt: IsNull() }),
  em.getRepository(JobTitle).findOneBy({ nameKey: listNameKey(employment.jobTitle), archivedAt: IsNull() })]);
 // An active team of that MC whose lead is the confirmed team lead, by name; failing that, the team named after them or,
 // when a team without a lead was picked, the team's own name (the backfill adds the MC as "Lee Lead team (Northwind)"
 // when the same lead text appears under two MCs).
 const leadKey = listNameKey(employment.teamLead);
 const match = mc && leadKey && leadKey !== 'independent' ? await em.getRepository(Team).createQueryBuilder('t')
  .leftJoin(DispatchMember, 'lead', 'lead.id = t.leadMemberId')
  .where('t.mcId = :mc AND t.archivedAt IS NULL', { mc: mc.id })
  .andWhere(`(lower(lead.firstName || ' ' || lead.lastName) = :key OR t.nameKey IN (:named, :key) OR left(t.nameKey, length(:prefix)) = :prefix)`, { key: leadKey, named: `${leadKey} team`, prefix: `${leadKey} team (` })
  .orderBy('t.leadMemberId IS NULL', 'ASC').getOne() : null;
 // Locked and checked again: a manager may have archived the team or changed its MC meanwhile.
 const locked = match ? await lockTeam(em, match.id) : null;
 const team = locked && !locked.archivedAt && locked.mcId === mc?.id ? locked : null;
 const member = await em.getRepository(DispatchMember).save({ applicationId: application.id, firstName: first.slice(0, 100), lastName: last.slice(0, 100),
  position: 'DISPATCHER', status: 'ONBOARDING', jobTitleId: jobTitle?.id ?? null, joinedAt: approvedAt });
 if (mc) await em.getRepository(MemberAssignment).save({ memberId: member.id, mcId: mc.id, teamId: team?.id ?? null, startedAt: approvedAt, reason: 'Joined after onboarding was approved.' });
 return member;
}

/** Called inside the IT completion transaction: the dispatcher has their accounts and starts working. */
export async function activateMember(em: EntityManager, applicationId: string) {
 await em.query(`UPDATE dispatch_members SET status = 'ACTIVE', version = version + 1, "updatedAt" = now() WHERE "applicationId" = $1 AND status = 'ONBOARDING'`, [applicationId]);
}

/**
 * Locks a team someone is being placed in. FOR SHARE is enough: updateTeam holds FOR UPDATE while it counts members to
 * archive the team or change its MC. Callers lock member rows before teams (member, then team), as move and leave do.
 */
export function lockTeam(em: EntityManager, id: string) {
 return em.getRepository(Team).findOne({ where: { id }, lock: { mode: 'pessimistic_read' } });
}

/** Locks someone's catch-up links. Called before their member row: a decision on their paperwork holds the invitation, then the member. */
export async function lockCatchUpLinks(em: EntityManager, memberId: string) {
 await em.query(`SELECT id FROM invitations WHERE "catchUpMemberId" = $1 AND "revokedAt" IS NULL ORDER BY id FOR UPDATE`, [memberId]);
}

/** Started their catch-up paperwork and still had something to do when their time ended. Someone who sent it is waiting for their manager, not for time. */
export function paperworkTimeEnded(link: { consumedAt: Date | null; status: string; applicantAccessUntil: Date }) {
 return !!link.consumedAt && ['INVITED', 'DRAFT', 'CHANGES_REQUESTED'].includes(link.status) && link.applicantAccessUntil.getTime() <= Date.now();
}

/** SQL columns for a member's open notice: its last day, and whether that day has passed (dayParam: the Pacific date, as the sweep uses). */
export const lastDaySql = (alias: string) => `(SELECT n."lastDay"::text FROM member_notices n WHERE n."memberId" = ${alias}.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL) AS "lastDay"`;
export const lastDayPassedSql = (alias: string, dayParam: string) => `coalesce((SELECT n."lastDay" < ${dayParam}::date FROM member_notices n WHERE n."memberId" = ${alias}.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL), false) AS "lastDayPassed"`;

/** On notice: nobody new is placed with them and they take on no new role. */
export async function onNotice(em: EntityManager, memberId: string) {
 const [row] = await em.query(`SELECT 1 FROM member_notices WHERE "memberId" = $1 AND "cancelledAt" IS NULL AND "finishedAt" IS NULL`, [memberId]);
 return !!row;
}

/**
 * A dispatcher a support can assist: a dispatcher record that hasn't left (still in IT setup is fine). Read FOR SHARE so
 * the dispatcher can't leave (which refuses while supports are linked) until the new link commits.
 */
export async function supportedDispatcher(em: EntityManager, id: string) {
 const dispatcher = await em.getRepository(DispatchMember).findOne({ where: { id }, lock: { mode: 'pessimistic_read' } });
 if (!dispatcher || dispatcher.position !== 'DISPATCHER' || dispatcher.status === 'LEFT') throw new BadRequestException('Choose a current dispatcher for this support.');
 if (await onNotice(em, id)) throw new ConflictException('This dispatcher is leaving. Choose another dispatcher for this support.');
 return dispatcher;
}

/** A team a support can assist as a whole. Read FOR SHARE so it can't be archived or change its MC until the new link commits. */
export async function supportedTeam(em: EntityManager, id: string) {
 const team = await lockTeam(em, id);
 if (!team || team.archivedAt) throw new BadRequestException('Choose an active team for this support.');
 return team;
}

/**
 * Called only inside the approval transaction for a support invitation: the support becomes an ACTIVE member record
 * (no IT setup) linked to the dispatcher or whole team they assist. Supports have no MC, team or job title of their own.
 */
export async function createSupportForApproval(em: EntityManager, application: DispatcherApplication, fields: ApplicationFields, assists: { dispatcherId: string | null; teamId: string | null }, approvedAt: Date, supportType: SupportType = 'SUPPORT') {
 if (assists.dispatcherId) await supportedDispatcher(em, assists.dispatcherId); else await supportedTeam(em, assists.teamId!);
 const first = fields.preferredAmericanFirstName?.trim() || fields.firstName?.trim() || 'Support';
 const last = fields.preferredAmericanLastName?.trim() || fields.lastName?.trim() || '';
 const member = await em.getRepository(DispatchMember).save({ applicationId: application.id, firstName: first.slice(0, 100), lastName: last.slice(0, 100),
  position: 'SUPPORT', supportType, status: 'ACTIVE', jobTitleId: null, joinedAt: approvedAt });
 await em.getRepository(MemberSupportLink).save({ supportId: member.id, dispatcherId: assists.dispatcherId, teamId: assists.teamId, startedAt: approvedAt, reason: 'Joined after onboarding was approved.' });
 return member;
}

/**
 * The active teams the signed-in team lead's dispatcher record leads; empty when it leads none. Loaded on every request,
 * so changing a team's lead changes their access with it.
 */
export async function ledTeams(em: EntityManager, userId: string): Promise<{ id: string; name: string; mc: string; mcId: string }[]> {
 return em.query(`SELECT t.id, t.name, m.name AS mc, m.id AS "mcId" FROM teams t JOIN mcs m ON m.id = t."mcId"
  JOIN dispatch_members d ON d.id = t."leadMemberId" WHERE d."accountUserId" = $1 AND d.status <> 'LEFT' AND t."archivedAt" IS NULL ORDER BY t."nameKey"`, [userId]);
}
