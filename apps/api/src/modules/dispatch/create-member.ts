import { EntityManager } from 'typeorm';
import type { ApplicationFields, DispatcherApplication } from '../onboarding/entities';
import { EmploymentAssignments } from '../onboarding/entities';
import { JobTitle, listNameKey, Mc } from '../lists/lists.entity';
import { DispatchMember, MemberAssignment, Team } from './dispatch.entity';

/**
 * Called only inside the approval transaction: the approved dispatcher becomes a member record (no login), placed by
 * matching the confirmed MC, team lead and job title text to the managed lists. Unmatched or "Independent" text leaves
 * that part empty for a manager to set. The unique applicationId keeps it to one member per application.
 */
export async function createMemberForApproval(em: EntityManager, application: DispatcherApplication, fields: ApplicationFields, employment: EmploymentAssignments, approvedAt: Date) {
 const first = fields.preferredAmericanFirstName?.trim() || fields.firstName?.trim() || 'Dispatcher';
 const last = fields.preferredAmericanLastName?.trim() || fields.lastName?.trim() || '';
 const [mc, jobTitle] = await Promise.all([
  em.getRepository(Mc).findOneBy({ nameKey: listNameKey(employment.mcName) }),
  em.getRepository(JobTitle).findOneBy({ nameKey: listNameKey(employment.jobTitle) })]);
 // An active team of that MC whose lead is the confirmed team lead, by name, or failing that the team named after them.
 const leadKey = listNameKey(employment.teamLead);
 const team = mc && leadKey && leadKey !== 'independent' ? await em.getRepository(Team).createQueryBuilder('t')
  .leftJoin(DispatchMember, 'lead', 'lead.id = t.leadMemberId')
  .where('t.mcId = :mc AND t.archivedAt IS NULL', { mc: mc.id })
  .andWhere(`(lower(lead.firstName || ' ' || lead.lastName) = :key OR t.nameKey = :named)`, { key: leadKey, named: `${leadKey} team` })
  .orderBy('t.leadMemberId IS NULL', 'ASC').getOne() : null;
 const member = await em.getRepository(DispatchMember).save({ applicationId: application.id, firstName: first.slice(0, 100), lastName: last.slice(0, 100),
  position: 'DISPATCHER', status: 'ACTIVE', jobTitleId: jobTitle?.id ?? null, joinedAt: approvedAt });
 await em.getRepository(MemberAssignment).save({ memberId: member.id, mcId: mc?.id ?? null, teamId: team?.id ?? null, startedAt: approvedAt, reason: 'Joined after onboarding was approved.' });
 return member;
}
