import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager, IsNull, QueryFailedError } from 'typeorm';
import { memberPlace, onNotice } from '../dispatch/create-member';
import { DispatchMember, positionLabel } from '../dispatch/dispatch.entity';
import { ItOnboardingActivity, ItOnboardingRequest, ItOnboardingTask, ItProfile, IT_CHECKLIST, SUPPORT_IT_ITEMS, SupportItItem } from './it.entity';

/**
 * What IT sees about a support or updater: their names and personal contacts (from their approved application, else what a
 * manager recorded when adding them by hand), and where they work, which follows whoever they assist.
 */
async function supportProfile(em: EntityManager, member: DispatchMember): Promise<ItProfile> {
 const [source]: { legalFirstName: string | null; legalLastName: string | null; personalPhone: string | null; personalEmail: string | null; assists: string | null }[] = await em.query(`SELECT
   nullif(btrim(s.fields->>'firstName'), '') AS "legalFirstName", nullif(btrim(s.fields->>'lastName'), '') AS "legalLastName",
   coalesce(nullif(btrim(s.fields->>'personalPhoneNumber'), ''), e."personalPhone") AS "personalPhone", coalesce(i.email, e."personalEmail") AS "personalEmail",
   coalesce(st.name, CASE WHEN sd.id IS NULL THEN NULL ELSE sd."firstName" || ' ' || sd."lastName" END) AS assists
  FROM dispatch_members d LEFT JOIN existing_member_records e ON e."memberId" = d.id
  LEFT JOIN dispatcher_applications a ON a.id = d."applicationId" AND a.status = 'APPROVED' LEFT JOIN invitations i ON i.id = a."invitationId"
  LEFT JOIN LATERAL (SELECT fields FROM application_submissions x WHERE x."applicationId" = a.id ORDER BY x.version DESC LIMIT 1) s ON true
  LEFT JOIN member_support_links l ON l."supportId" = d.id AND l."endedAt" IS NULL LEFT JOIN dispatch_members sd ON sd.id = l."dispatcherId" LEFT JOIN teams st ON st.id = l."teamId"
  WHERE d.id = $1`, [member.id]);
 const place = await memberPlace(em, member.id), name = `${member.firstName} ${member.lastName}`.trim();
 return { legalFirstName: source?.legalFirstName ?? null, legalLastName: source?.legalLastName ?? null,
  preferredAmericanFirstName: member.firstName, preferredAmericanLastName: member.lastName || null, proposedDisplayName: name,
  personalPhoneNumber: source?.personalPhone ?? null, workPhoneNumber: null, personalEmail: source?.personalEmail ?? null,
  mcName: place.mcName ?? '', teamLead: place.teamName ?? '', jobTitle: positionLabel(member),
  assists: source?.assists ? `${positionLabel(member)} for ${source.assists}` : positionLabel(member) };
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
 const open = await em.getRepository(ItOnboardingRequest).findOneBy({ memberId: member.id, purpose: 'SUPPORT', completedAt: IsNull(), cancelledAt: IsNull() });
 const busy = 'IT is still working on the last request. Ask for more once it’s done.';
 if (open) throw new ConflictException(busy);
 const keys = new Set<string>(items.flatMap(item => SUPPORT_IT_ITEMS[item]));
 // Every writer takes the member lock first, so the index only catches one that didn't; it answers the same 409, never a 500.
 const request = await em.getRepository(ItOnboardingRequest).save({ purpose: 'SUPPORT', memberId: member.id, applicationId: null, approvalId: null,
  managerId: input.managerId, requestedBy: input.actorId, note: input.note?.trim() || null, profile: await supportProfile(em, member), version: 0 }).catch((error: unknown) => {
  if (error instanceof QueryFailedError && (error.driverError as { constraint?: string }).constraint === 'UQ_it_requests_support_open') throw new ConflictException(busy);
  throw error;
 });
 // The tasks in checklist order, only those asked for.
 await em.getRepository(ItOnboardingTask).save(IT_CHECKLIST.filter(task => keys.has(task.key)).map(task => ({ requestId: request.id, key: task.key, status: 'PENDING' as const, notes: '' })));
 await em.getRepository(ItOnboardingActivity).save({ requestId: request.id, actorId: input.actorId, event: 'IT_REQUEST_CREATED', metadata: { items: items.join(','), note: !!request.note } });
 return request;
}
