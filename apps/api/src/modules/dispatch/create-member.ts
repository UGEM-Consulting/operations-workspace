import { EntityManager } from 'typeorm';
import type { ApplicationFields, DispatcherApplication } from '../onboarding/entities';
import { EmploymentAssignments } from '../onboarding/entities';
import { JobTitle, listNameKey, Mc } from '../lists/lists.entity';
import { DispatchMember, MemberAssignment, Team } from './dispatch.entity';

/**
 * Called only inside the approval transaction: the approved dispatcher becomes a member record (no login), ONBOARDING
 * until IT completes setup (see activateMember), placed by
 * matching the confirmed MC, team lead and job title text to the managed lists. Unmatched or "Independent" text leaves
 * that part empty for a manager to set. The unique applicationId keeps it to one member per application.
 */
export async function createMemberForApproval(em: EntityManager, application: DispatcherApplication, fields: ApplicationFields, employment: EmploymentAssignments, approvedAt: Date) {
 const first = fields.preferredAmericanFirstName?.trim() || fields.firstName?.trim() || 'Dispatcher';
 const last = fields.preferredAmericanLastName?.trim() || fields.lastName?.trim() || '';
 const [mc, jobTitle] = await Promise.all([
  em.getRepository(Mc).findOneBy({ nameKey: listNameKey(employment.mcName) }),
  em.getRepository(JobTitle).findOneBy({ nameKey: listNameKey(employment.jobTitle) })]);
 // An active team of that MC whose lead is the confirmed team lead, by name; failing that, the team named after them or,
 // when a team without a lead was picked, the team's own name (the backfill adds the MC as "Lee Lead team (Northwind)"
 // when the same lead text appears under two MCs).
 const leadKey = listNameKey(employment.teamLead);
 const team = mc && leadKey && leadKey !== 'independent' ? await em.getRepository(Team).createQueryBuilder('t')
  .leftJoin(DispatchMember, 'lead', 'lead.id = t.leadMemberId')
  .where('t.mcId = :mc AND t.archivedAt IS NULL', { mc: mc.id })
  .andWhere(`(lower(lead.firstName || ' ' || lead.lastName) = :key OR t.nameKey IN (:named, :key) OR left(t.nameKey, length(:prefix)) = :prefix)`, { key: leadKey, named: `${leadKey} team`, prefix: `${leadKey} team (` })
  .orderBy('t.leadMemberId IS NULL', 'ASC').getOne() : null;
 const member = await em.getRepository(DispatchMember).save({ applicationId: application.id, firstName: first.slice(0, 100), lastName: last.slice(0, 100),
  position: 'DISPATCHER', status: 'ONBOARDING', jobTitleId: jobTitle?.id ?? null, joinedAt: approvedAt });
 await em.getRepository(MemberAssignment).save({ memberId: member.id, mcId: mc?.id ?? null, teamId: team?.id ?? null, startedAt: approvedAt, reason: 'Joined after onboarding was approved.' });
 return member;
}

/** Called inside the IT completion transaction: the dispatcher has their accounts and starts working. */
export async function activateMember(em: EntityManager, applicationId: string) {
 await em.query(`UPDATE dispatch_members SET status = 'ACTIVE', version = version + 1, "updatedAt" = now() WHERE "applicationId" = $1 AND status = 'ONBOARDING'`, [applicationId]);
}
