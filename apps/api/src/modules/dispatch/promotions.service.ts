import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, QueryFailedError } from 'typeorm';
import type { User } from '../users/user.entity';
import { JobTitle, Mc } from '../lists/lists.entity';
import { ApplicationReview, ApplicationSubmission, DispatcherApplication, Invitation } from '../onboarding/entities';
import { createItRequest } from '../it/create-request';
import { NotificationsService } from '../updates/notifications.service';
import { CreatePromotionDto, DecidePromotionDto } from './dispatch.dto';
import { DispatchEvent, DispatchEventType, DispatchMember, MemberAssignment, MemberSupportLink, PromotionRequest } from './dispatch.entity';
import { ledTeams, lockTeam, onNotice } from './create-member';

const name = (alias: string) => `${alias}."firstName" || ' ' || ${alias}."lastName"`;

/**
 * Team leads and promotions. A team lead's account is linked to their dispatcher record; they see and act only for the
 * active teams that record leads, so changing a team's lead changes their access with it. A team lead asks for a support
 * in their team to become a dispatcher; a dispatch manager or administrator approves (choosing MC, team and job title)
 * or declines. Approval ends the support link, makes them an ONBOARDING dispatcher with an MC and team, and creates their
 * IT setup request in the same transaction; they become ACTIVE when IT completes setup, like any approved dispatcher.
 */
@Injectable()
export class PromotionsService {
 constructor(private readonly db: DataSource, private readonly notifications: NotificationsService) {}

 /** The active teams the signed-in team lead's dispatcher record leads; empty when it leads none. */
 private async scope(em: EntityManager | DataSource, user: User) {
  return (await ledTeams(em instanceof DataSource ? em.manager : em, user.id)).map(({ id, name, mc }) => ({ id, name, mc }));
 }

 async team(user: User) {
  const teams = await this.scope(this.db, user);
  const ids = teams.map(team => team.id);
  const dispatchers = ids.length ? await this.db.query(`SELECT d.id, ${name('d')} AS name, d.status, a."teamId", jt.name AS "jobTitle", (t."leadMemberId" = d.id) AS lead
   FROM member_assignments a JOIN dispatch_members d ON d.id = a."memberId" JOIN teams t ON t.id = a."teamId" LEFT JOIN job_titles jt ON jt.id = d."jobTitleId"
   WHERE a."teamId" = ANY($1) AND a."endedAt" IS NULL AND d.status <> 'LEFT' AND d.position = 'DISPATCHER' ORDER BY lower(d."firstName"), lower(d."lastName")`, [ids]) : [];
  const supports = ids.length ? await this.db.query(`SELECT s.id, ${name('s')} AS name, s."supportType", s.status, l."dispatcherId", l."teamId", l."startedAt" AS since,
    coalesce(e."periodDateKnown", true) OR (SELECT count(*) FROM member_support_links x WHERE x."supportId" = s.id) > 1 AS "sinceKnown",
    (SELECT json_build_object('id', p.id, 'createdAt', p."createdAt") FROM promotion_requests p WHERE p."supportId" = s.id AND p.status = 'PENDING') AS pending
   FROM member_support_links l JOIN dispatch_members s ON s.id = l."supportId" LEFT JOIN existing_member_records e ON e."memberId" = s.id
   WHERE (l."dispatcherId" = ANY($1) OR l."teamId" = ANY($2)) AND l."endedAt" IS NULL AND s.status <> 'LEFT' ORDER BY lower(s."firstName")`, [dispatchers.map((row: { id: string }) => row.id), ids]) : [];
  // Only for people still in their teams: a support assisting one of their dispatchers or the whole team, or a promoted support now one.
  const requests = ids.length ? await this.db.query(`SELECT p.id, p.status, p.reason, p.note, p."createdAt", p."decidedAt", ${name('s')} AS support
   FROM promotion_requests p JOIN dispatch_members s ON s.id = p."supportId" WHERE p."requestedBy" = $1 AND s.status <> 'LEFT' AND (EXISTS (SELECT 1 FROM member_assignments a
    LEFT JOIN member_support_links l ON l."dispatcherId" = a."memberId" AND l."endedAt" IS NULL AND l."supportId" = s.id
    WHERE a."endedAt" IS NULL AND a."teamId" = ANY($2) AND (a."memberId" = s.id OR l.id IS NOT NULL))
    OR EXISTS (SELECT 1 FROM member_support_links w WHERE w."supportId" = s.id AND w."endedAt" IS NULL AND w."teamId" = ANY($2))) ORDER BY p."createdAt" DESC LIMIT 50`, [user.id, ids]) : [];
  return { teams, dispatchers, supports, requests };
 }

 async request(user: User, dto: CreatePromotionDto) {
  return this.write(async em => {
   const support = await this.supportInScope(em, user, dto.supportId);
   if (support.position !== 'SUPPORT' || support.status !== 'ACTIVE') throw new ConflictException('Only an active support or updater can be promoted.');
   if (await onNotice(em, dto.supportId)) throw new ConflictException('This person is leaving, so they can’t be promoted.');
   const request = await em.getRepository(PromotionRequest).save({ supportId: dto.supportId, requestedBy: user.id, reason: dto.reason });
   await this.event(em, user, 'PROMOTION_REQUESTED', dto.supportId, { requestId: request.id });
   return { id: request.id };
  });
 }

 async cancel(user: User, id: string) {
  return this.write(async em => {
   const request = await em.getRepository(PromotionRequest).findOne({ where: { id, requestedBy: user.id }, lock: { mode: 'pessimistic_write' } });
   if (!request) throw new NotFoundException('This request no longer exists.');
   // A decided request says so even when the support has moved on (an approved one is no longer a support).
   if (request.status !== 'PENDING') throw new ConflictException('This request was already decided.');
   // Only while the support is still in a team they lead (they may have stopped leading it or the support moved on).
   await this.supportInScope(em, user, request.supportId, false);
   Object.assign(request, { status: 'CANCELLED', decidedBy: user.id, decidedAt: new Date(), version: request.version + 1 });
   await em.save(request);
   await this.event(em, user, 'PROMOTION_CANCELLED', request.supportId, { requestId: id });
   return { id };
  });
 }

 async list(status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'CANCELLED' | 'ALL' = 'ALL') {
  const items = await this.db.query(`SELECT p.id, p.status, p.reason, p.note, p.version, p."createdAt", p."decidedAt", p."itRequestId",
    s.id AS "supportId", ${name('s')} AS support, s."supportType", d.id AS "dispatcherId", ${name('d')} AS dispatcher,
    coalesce(lm.id, m.id) AS "mcId", coalesce(lm.name, m.name) AS mc, a.id IS NOT NULL OR lt.id IS NOT NULL AS "dispatcherPlaced", coalesce(lt.id, t.id) AS "teamId", coalesce(lt.name, t.name) AS team, lt.name AS "wholeTeam",
    CASE WHEN r.id IS NULL THEN NULL ELSE ${name('r')} END AS "requestedBy", CASE WHEN x.id IS NULL THEN NULL ELSE ${name('x')} END AS "decidedBy"
   FROM promotion_requests p JOIN dispatch_members s ON s.id = p."supportId"
   LEFT JOIN LATERAL (SELECT * FROM member_support_links l WHERE l."supportId" = s.id ORDER BY l."startedAt" DESC LIMIT 1) l ON true
   LEFT JOIN dispatch_members d ON d.id = l."dispatcherId" LEFT JOIN teams lt ON lt.id = l."teamId" LEFT JOIN mcs lm ON lm.id = lt."mcId"
   LEFT JOIN LATERAL (SELECT * FROM member_assignments a WHERE a."memberId" = d.id AND a."endedAt" IS NULL LIMIT 1) a ON true
   LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN teams t ON t.id = a."teamId"
   LEFT JOIN users r ON r.id = p."requestedBy" LEFT JOIN users x ON x.id = p."decidedBy"
   WHERE ($1 = 'ALL' OR p.status = $1) ORDER BY (p.status = 'PENDING') DESC, p."createdAt" DESC LIMIT 200`, [status]);
  const [counts] = await this.db.query(`SELECT count(*) FILTER (WHERE status = 'PENDING')::integer AS pending, count(*)::integer AS total FROM promotion_requests`);
  return { items, counts };
 }

 async pendingCount() {
  const [row] = await this.db.query(`SELECT count(*)::integer AS n FROM promotion_requests WHERE status = 'PENDING'`);
  return row.n as number;
 }

 async decide(user: User, id: string, dto: DecidePromotionDto) {
  let alerts: string[] = [];
  const result = await this.write(async em => {
   // The support's record is locked before the request (member, then request, then team), the order leaving uses.
   const found = await em.getRepository(PromotionRequest).findOneBy({ id });
   if (!found) throw new NotFoundException('This request no longer exists.');
   const support = await em.getRepository(DispatchMember).findOne({ where: { id: found.supportId }, lock: { mode: 'pessimistic_write' } });
   const request = await em.getRepository(PromotionRequest).findOneOrFail({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (request.version !== dto.version) throw new ConflictException('Someone else changed this request. Reload and try again.');
   if (request.status !== 'PENDING') throw new ConflictException('This request was already decided.');
   if (dto.decision !== 'DECLINE' && await onNotice(em, request.supportId)) throw new ConflictException('This person is leaving, so they can’t be promoted. Cancel their notice first.');
   const now = new Date();
   if (dto.decision === 'DECLINE') {
    if (!dto.note?.trim()) throw new BadRequestException('Say why the request is declined.');
    Object.assign(request, { status: 'DECLINED', note: dto.note.trim(), decidedBy: user.id, decidedAt: now, version: request.version + 1 });
    await em.save(request);
    await this.event(em, user, 'PROMOTION_DECLINED', request.supportId, { requestId: id });
    return { id, status: request.status };
   }
   if (!support || support.position !== 'SUPPORT' || support.status !== 'ACTIVE') throw new ConflictException('This person is no longer an active support or updater.');
   if (!support.applicationId) throw new ConflictException('Promotion needs their approved application for their IT setup.');
   // Where they will work: an active MC (or Independent, with no team), a team of that MC, and a job title.
   const mc = dto.mcId ? await em.getRepository(Mc).findOneBy({ id: dto.mcId }) : null;
   if (dto.mcId && (!mc || mc.archivedAt)) throw new BadRequestException('Choose an active MC.');
   const team = dto.teamId ? await lockTeam(em, dto.teamId) : null;
   if (dto.teamId && (!team || team.archivedAt || team.mcId !== dto.mcId)) throw new BadRequestException('Choose an active team of the selected MC.');
   const title = dto.jobTitleId ? await em.getRepository(JobTitle).findOneBy({ id: dto.jobTitleId }) : null;
   if (!title || title.archivedAt) throw new BadRequestException('Choose an active job title.');
   const lead = team?.leadMemberId ? await em.getRepository(DispatchMember).findOneBy({ id: team.leadMemberId }) : null;
   // The support's own approval and latest submitted answers carry their IT profile (names, phones, personal email).
   const application = await em.getRepository(DispatcherApplication).findOneByOrFail({ id: support.applicationId });
   const approval = await em.getRepository(ApplicationReview).findOne({ where: { applicationId: application.id, decisionType: 'APPROVE' }, order: { createdAt: 'DESC' } });
   if (!approval) throw new ConflictException('Promotion needs their approved application for their IT setup.');
   const invitation = await em.getRepository(Invitation).findOneByOrFail({ id: application.invitationId });
   const submitted = await em.getRepository(ApplicationSubmission).findOne({ where: { applicationId: application.id }, order: { version: 'DESC' } });
   const link = await em.getRepository(MemberSupportLink).findOneBy({ supportId: support.id, endedAt: IsNull() });
   // Same instant for the end of the support link and the start of the dispatcher assignment (after the link began).
   const at = link && link.startedAt.getTime() >= now.getTime() ? new Date(link.startedAt.getTime() + 1) : now;
   if (link) { link.endedAt = at; await em.save(link); }
   Object.assign(support, { position: 'DISPATCHER', supportType: 'SUPPORT', status: 'ONBOARDING', jobTitleId: title.id, version: support.version + 1 });
   await em.save(support);
   await em.getRepository(MemberAssignment).save({ memberId: support.id, mcId: mc?.id ?? null, teamId: team?.id ?? null, startedAt: at, reason: 'Promoted from support to dispatcher.', actorId: user.id });
   const itRequest = await createItRequest(em, application, approval, submitted?.fields ?? {}, invitation, user.id,
    { mcName: mc?.name ?? 'Independent', teamLead: team ? (lead ? `${lead.firstName} ${lead.lastName}`.trim() : team.name) : 'Independent', jobTitle: title.name });
   alerts = await this.notifications.queueItSetupWaiting(em, itRequest);
   Object.assign(request, { status: 'APPROVED', note: dto.note?.trim() || null, decidedBy: user.id, decidedAt: now, itRequestId: itRequest.id, version: request.version + 1 });
   await em.save(request);
   await this.event(em, user, 'PROMOTION_APPROVED', support.id, { requestId: id, fields: ['position', 'mcId', 'teamId', 'jobTitleId'] });
   return { id, status: request.status, itRequestId: itRequest.id };
  });
  // The IT setup alert goes out only after the promotion commits.
  this.notifications.dispatch(alerts);
  return result;
 }

 /** Only a team lead may act through the team routes; their record must still lead a team. */
 async requireLead(user: User) {
  if (!(await this.scope(this.db, user)).length) throw new ForbiddenException('Your account isn’t linked to a team you lead.');
 }

 /** A support assisting a dispatcher in one of the team lead's teams, or one of those teams as a whole; outside that scope looks the same as not existing. */
 private async supportInScope(em: EntityManager, user: User, supportId: string, lock = true) {
  const teams = (await this.scope(em, user)).map(team => team.id);
  const [support] = await em.query(`SELECT s.id, s.position, s.status, coalesce(l."teamId", a."teamId") AS "teamId" FROM dispatch_members s
   JOIN member_support_links l ON l."supportId" = s.id AND l."endedAt" IS NULL
   LEFT JOIN member_assignments a ON a."memberId" = l."dispatcherId" AND a."endedAt" IS NULL WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [supportId]);
  if (!support || !teams.includes(support.teamId)) throw new NotFoundException('This person isn’t in your team.');
  return support as { id: string; position: string; status: string; teamId: string };
 }

 private async write<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
  try { return await this.db.transaction(work); }
  catch (error) {
   const driver = error instanceof QueryFailedError ? error.driverError as { code?: string; constraint?: string } : null;
   if (driver?.code === '23505' && driver.constraint === 'UQ_promotion_requests_open') throw new ConflictException('There is already an open request for this person.');
   if (driver?.code === '23505') throw new ConflictException('This record changed at the same time. Reload and try again.');
   throw error;
  }
 }
 private event(em: EntityManager, user: User, event: DispatchEventType, memberId: string, metadata: Record<string, unknown>) {
  return em.getRepository(DispatchEvent).save({ memberId, teamId: null, event, actorId: user.id, metadata });
 }
}
