import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager, IsNull, Not, QueryFailedError } from 'typeorm';
import { memberPlace, onLeave, onNotice } from '../dispatch/create-member';
import { DispatchMember, positionLabel } from '../dispatch/dispatch.entity';
import { ItOnboardingActivity, ItOnboardingRequest, ItOnboardingTask, ItProfile, IT_CHECKLIST, ReturningProfile, SUPPORT_IT_ITEMS, SupportItItem } from './it.entity';

/**
 * What IT sees about someone on a setup that names them: their names and personal contacts (from their approved application,
 * else what a manager recorded when adding them by hand), and where they work, which for a support or updater follows whoever
 * they assist. A dispatcher coming back (section 41) shows their job title instead.
 */
export async function memberItProfile(em: EntityManager, member: DispatchMember): Promise<ItProfile> {
 const [source]: { legalFirstName: string | null; legalLastName: string | null; personalPhone: string | null; personalEmail: string | null; assists: string | null }[] = await em.query(`SELECT
   coalesce(d."correctedDetails"->>'legalFirstName', nullif(btrim(s.fields->>'firstName'), '')) AS "legalFirstName", coalesce(d."correctedDetails"->>'legalLastName', nullif(btrim(s.fields->>'lastName'), '')) AS "legalLastName",
   coalesce(d."correctedDetails"->>'personalPhoneNumber', nullif(btrim(s.fields->>'personalPhoneNumber'), ''), e."personalPhone") AS "personalPhone", coalesce(d."correctedDetails"->>'personalEmail', i.email, e."personalEmail") AS "personalEmail",
   coalesce(st.name, CASE WHEN sd.id IS NULL THEN NULL ELSE sd."firstName" || ' ' || sd."lastName" END) AS assists
  FROM dispatch_members d LEFT JOIN existing_member_records e ON e."memberId" = d.id
  LEFT JOIN dispatcher_applications a ON a.id = d."applicationId" AND a.status = 'APPROVED' LEFT JOIN invitations i ON i.id = a."invitationId"
  LEFT JOIN LATERAL (SELECT fields FROM application_submissions x WHERE x."applicationId" = a.id ORDER BY x.version DESC LIMIT 1) s ON true
  LEFT JOIN member_support_links l ON l."supportId" = d.id AND l."endedAt" IS NULL LEFT JOIN dispatch_members sd ON sd.id = l."dispatcherId" LEFT JOIN teams st ON st.id = l."teamId"
  WHERE d.id = $1`, [member.id]);
 const place = await memberPlace(em, member.id), name = `${member.firstName} ${member.lastName}`.trim();
 const [title]: { name: string }[] = member.position === 'DISPATCHER' && member.jobTitleId ? await em.query(`SELECT name FROM job_titles WHERE id = $1`, [member.jobTitleId]) : [];
 const support = member.position === 'SUPPORT';
 return { legalFirstName: source?.legalFirstName ?? null, legalLastName: source?.legalLastName ?? null,
  preferredAmericanFirstName: member.firstName, preferredAmericanLastName: member.lastName || null, proposedDisplayName: name,
  personalPhoneNumber: source?.personalPhone ?? null, workPhoneNumber: null, personalEmail: source?.personalEmail ?? null,
  mcName: place.mcName ?? '', teamLead: place.teamName ?? '', jobTitle: title?.name ?? positionLabel(member),
  assists: !support ? null : source?.assists ? `${positionLabel(member)} for ${source.assists}` : positionLabel(member) };
}

/**
 * A dispatch manager asks IT to set up some of: a company email, a RingCentral number, business software, equipment (section
 * 32). Called in the approval transaction (managerId is the application's responsible manager) or from the person's page
 * (the asking manager). The member row is locked first, then the request is created with only the tasks asked for; the
 * caller queues the IT_SETUP_WAITING alert. One open request per person (UQ_it_requests_support_open).
 */
export async function createSupportItRequest(em: EntityManager, input: { memberId: string; items: SupportItItem[]; note?: string | null; managerId: string; actorId: string }) {
 const items = [...new Set(input.items)];
 if (!items.length) throw new BadRequestException('Choose what IT should set up.');
 const member = await em.getRepository(DispatchMember).findOne({ where: { id: input.memberId }, lock: { mode: 'pessimistic_write' } });
 if (!member) throw new NotFoundException();
 if (member.position !== 'SUPPORT') throw new BadRequestException('Only supports and updaters are set up this way; a new dispatcher’s setup starts at approval.');
 if (member.status === 'LEFT') throw new ConflictException('They have left.');
 if (await onNotice(em, member.id)) throw new ConflictException('They’re leaving, so IT won’t set up anything new for them.');
 if (await onLeave(em, member.id)) throw new ConflictException('They’re on leave. Ask IT once they’re back.');
 // A leave recorded for later lists what IT suspends from what they have today; a new account now would miss that list.
 const [planned] = await em.query(`SELECT 1 FROM member_leaves WHERE "memberId" = $1 AND "endedAt" IS NULL`, [member.id]);
 if (planned) throw new ConflictException('They have leave coming up. Ask IT once they’re back, or cancel the leave first.');
 // A return checklist still open (section 41) counts too: IT finishes one list before getting another.
 const open = await em.getRepository(ItOnboardingRequest).findOneBy({ memberId: member.id, purpose: Not('DISPATCHER'), completedAt: IsNull(), cancelledAt: IsNull() });
 const busy = 'IT is still working on the last request. Ask for more once it’s done.';
 if (open) throw new ConflictException(busy);
 const keys = new Set<string>(items.flatMap(item => SUPPORT_IT_ITEMS[item]));
 // Every writer takes the member lock first, so the index only catches one that didn't; it answers the same 409, never a 500.
 const request = await em.getRepository(ItOnboardingRequest).save({ purpose: 'SUPPORT', memberId: member.id, applicationId: null, approvalId: null,
  managerId: input.managerId, requestedBy: input.actorId, note: input.note?.trim() || null, profile: await memberItProfile(em, member), version: 0 }).catch((error: unknown) => {
  if (error instanceof QueryFailedError && (error.driverError as { constraint?: string }).constraint === 'UQ_it_requests_support_open') throw new ConflictException(busy);
  throw error;
 });
 // The tasks in checklist order, only those asked for.
 await em.getRepository(ItOnboardingTask).save(IT_CHECKLIST.filter(task => keys.has(task.key)).map(task => ({ requestId: request.id, key: task.key, status: 'PENDING' as const, notes: '' })));
 await em.getRepository(ItOnboardingActivity).save({ requestId: request.id, actorId: input.actorId, event: 'IT_REQUEST_CREATED', metadata: { items: items.join(','), note: !!request.note } });
 return request;
}

/**
 * IT's checklist for someone coming back (section 41): RESTORE after an undone leaving, REHIRE for a rehire. Called with the
 * member row already locked (and their setups before it). Only the tasks given; restoreKeys names those that bring an old
 * account back, whose email or number is filled in already so IT only confirms it. The caller queues the IT_SETUP_WAITING alert.
 */
export async function createReturnSetup(em: EntityManager, input: { purpose: 'REHIRE' | 'RESTORE'; member: DispatchMember; keys: string[]; restoreKeys: string[]; managerId: string; actorId: string;
 accounts: { companyEmail: string | null; ringCentralNumber: string | null; ringCentralExtension: string | null }; returning: ReturningProfile }) {
 const keys = new Set(input.keys);
 const request = await em.getRepository(ItOnboardingRequest).save({ purpose: input.purpose, memberId: input.member.id, applicationId: null, approvalId: null,
  managerId: input.managerId, requestedBy: input.actorId, note: null, restoreKeys: input.restoreKeys.filter(key => keys.has(key)),
  profile: { ...await memberItProfile(em, input.member), returning: input.returning }, companyEmail: input.accounts.companyEmail,
  assignedRingCentralPhoneNumber: input.accounts.ringCentralNumber, ringCentralExtension: input.accounts.ringCentralExtension, version: 0 }).catch((error: unknown) => {
  if (error instanceof QueryFailedError && (error.driverError as { constraint?: string }).constraint === 'UQ_it_requests_return_open') throw new ConflictException('IT is still working on their last checklist. Reload and try again.');
  throw error;
 });
 await em.getRepository(ItOnboardingTask).save(IT_CHECKLIST.filter(task => keys.has(task.key)).map(task => ({ requestId: request.id, key: task.key, status: 'PENDING' as const, notes: '' })));
 await em.getRepository(ItOnboardingActivity).save({ requestId: request.id, actorId: input.actorId, event: 'IT_REQUEST_CREATED', metadata: { returning: input.returning.kind, restore: input.restoreKeys.length > 0 } });
 return request;
}
